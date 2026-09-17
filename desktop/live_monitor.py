#!/usr/bin/env python3
"""单个监听目标的常驻监控进程（供 desktop/ 的 Electron UI 调用）。

核心逻辑已下沉到 core/live_watcher.py（与 CLI 的 link + mode: live 共用），
本脚本只是进程壳：
- 解析命令行参数、装配 ConfigLoader / CookieManager / download_fn；
- 把 core 的事件流转成 stdout 上的 ``[DW_EVENT] {json}`` 供 UI 解析，
  其余输出（cli.main 的 rich 展示走 stdout、logging 走 stderr）视为日志行；
- UI 向 stdin 写一行 ``stop`` 优雅停止：录制中的任务被取消，
  live_downloader 的 CancelledError 分支会把半成品 .tmp 提升为正式文件。

用法（在仓库根目录、用项目 venv 的 python 执行）：
    python desktop/live_monitor.py --url https://live.douyin.com/123456 \
        --config config.yml --download-path D:/Downloads \
        --max-duration 0 --chunk-size 65536 --idle-timeout 30 --poll-interval 60
--url 也接受主播主页链接（douyin.com/user/{sec_uid}），按主页模式轮询开播状态。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
os.chdir(PROJECT_ROOT)

from auth import CookieManager  # noqa: E402
from cli.main import download_url  # noqa: E402
from config import ConfigLoader  # noqa: E402
from core import LoginRequiredError  # noqa: E402
from core.downloader_base import DownloadResult  # noqa: E402  (re-export 兼容)
from core.live_watcher import (  # noqa: E402
    LoginRequiredInterrupt,
    poll_interval_from_config,
    resolve_watch_target,
    watch_live,
)
from utils.logger import setup_logger  # noqa: E402

logger = setup_logger("LiveMonitor")

EVENT_PREFIX = "[DW_EVENT] "


def emit(**payload: Any) -> None:
    payload.setdefault("ts", time.time())
    try:
        print(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        # 事件输出失败不能影响监控主流程。
        pass


class WatcherReporter:
    """download_url(progress_reporter=...) 的鸭子类型实现。

    只实现 BaseDownloader / download_url 实际会调用的方法；其余方法
    （ProgressDisplay 专属的 show_* 等）通过 __getattr__ 兜底为 no-op，
    保证上游新增调用不会让监控进程崩掉。
    """

    def __init__(self) -> None:
        self.last_file: str = ""

    def advance_step(self, step: str, detail: str = "") -> None:
        emit(type="state", state="checking", detail=f"{step}: {detail}".strip(": "))

    def update_step(self, step: str, detail: str = "") -> None:
        if step == "录制直播流":
            # detail 形如 "quality=ORIGIN | -> 2026-09-17_2130_room.flv"
            file_name = detail.split("->", 1)[1].strip() if "->" in detail else ""
            if file_name:
                self.last_file = file_name
            emit(type="state", state="recording", detail=detail, file=file_name)
        else:
            emit(type="state", state="checking", detail=f"{step}: {detail}".strip(": "))

    def set_item_total(self, total: int, detail: str = "") -> None:
        pass

    def advance_item(self, status: str, detail: str = "", reason: str = "") -> None:
        # 汇总状态由 core.watch_live 依据 DownloadResult 统一发事件；
        # 录制文件名只在 update_step 里出现，这里没有额外信息要记录。
        pass

    def __getattr__(self, name: str):
        def _noop(*args, **kwargs):
            return None

        return _noop


async def _read_stdin_commands(stop_event: asyncio.Event) -> None:
    """后台线程读 stdin；收到 stop 或管道关闭（父进程退出）时触发停止。"""

    def _reader() -> None:
        try:
            for line in sys.stdin:
                if line.strip().lower() == "stop":
                    stop_event.set()
                    return
        except Exception:
            pass
        # stdin 关闭说明 UI 父进程已退出，跟着退出避免孤儿进程。
        stop_event.set()

    await asyncio.to_thread(_reader)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Monitor one Douyin live/homepage target and record when live."
    )
    parser.add_argument(
        "--url", required=True, help="直播间链接或主播主页链接（douyin.com/user/{sec_uid}）"
    )
    parser.add_argument("--config", default=str(PROJECT_ROOT / "config.yml"), help="基础配置文件（cookies 等从这读）")
    parser.add_argument("--download-path", default="", help="下载根目录（覆盖配置里的 path）")
    parser.add_argument("--max-duration", type=float, default=0, help="单次录制最长秒数，0 = 录到下播")
    parser.add_argument("--chunk-size", type=int, default=65536)
    parser.add_argument("--idle-timeout", type=float, default=30.0)
    parser.add_argument("--poll-interval", type=float, default=60, help="开播状态轮询间隔秒数")
    return parser


CORE_EVENT_TO_STATE = {
    "starting": "starting",
    "checking": "checking",
    "live_detected": "checking",
    "waiting": "waiting",
    "finished": "finished",
    "error": "error",
    "login_required": "login_required",
    "stopped": "stopped",
}


def make_event_adapter(room_id_of_target: str) -> Any:
    """把 core.watch_live 的事件转成 [DW_EVENT] 行。

    target_id（房间号/主播 sec_uid）随 starting 事件带上；账号模式在检测到
    开播后，房间号通过 live_detected / recording 事件的 room_id 展示。
    """

    def _handle(event: dict) -> None:
        state = CORE_EVENT_TO_STATE.get(str(event.get("event")))
        if not state:
            return
        payload: dict = {"type": "state", "state": state, "detail": str(event.get("detail") or "")}
        if event.get("hint"):
            payload["hint"] = event["hint"]
        if event.get("file"):
            payload["file"] = event["file"]
        room_id = str(event.get("room_id") or "")
        if room_id:
            payload["room_id"] = room_id
        elif state == "starting" and room_id_of_target and "live.douyin.com" in str(
            event.get("url") or ""
        ):
            payload["room_id"] = room_id_of_target
        emit(**payload)

    return _handle


async def run_monitor(args: argparse.Namespace) -> int:
    url = args.url.strip()
    config = ConfigLoader(args.config)

    download_path = args.download_path or str(config.get("path") or "./Downloaded/")
    poll_interval = poll_interval_from_config(
        {"poll_interval_seconds": args.poll_interval}
    )

    config.update(
        link=[url],
        path=download_path,
        live={
            "max_duration_seconds": float(args.max_duration or 0),
            "chunk_size": int(args.chunk_size or 65536),
            "idle_timeout_seconds": float(args.idle_timeout or 30),
            "poll_interval_seconds": poll_interval,
        },
    )
    if not config.validate():
        emit(type="state", state="error", detail="配置校验失败（缺少下载路径或链接）")
        return 2

    cookie_manager = CookieManager()
    cookie_manager.set_cookies(config.get_cookies())
    if not cookie_manager.validate_cookies():
        emit(type="state", state="login_required", detail="Cookies 缺失或无效，请先在 UI 中登录抖音")
        return 2

    stop_event = asyncio.Event()
    stdin_task = asyncio.create_task(_read_stdin_commands(stop_event))
    reporter = WatcherReporter()

    # starting 事件里的 target_id 用于房间模式展示房间号
    target_room_id = ""
    try:
        target = resolve_watch_target(url)
        if target.get("kind") == "room":
            target_room_id = str(target.get("room_id") or "")
    except Exception:
        pass

    exit_code = 0

    async def download_fn(target_url: str) -> Optional[DownloadResult]:
        try:
            return await download_url(
                target_url, config, cookie_manager, None, progress_reporter=reporter
            )
        except LoginRequiredError as exc:
            raise LoginRequiredInterrupt(str(exc)) from exc

    try:
        await watch_live(
            url,
            download_fn=download_fn,
            cookies=cookie_manager.get_cookies(),
            proxy=str(config.get("proxy") or ""),
            poll_interval_seconds=poll_interval,
            stop_event=stop_event,
            on_event=make_event_adapter(target_room_id),
        )
    except asyncio.CancelledError:
        emit(type="state", state="stopped", detail="已中断")
        emit(type="exit", code=0)
        return 0
    finally:
        stdin_task.cancel()
        emit(type="exit", code=exit_code)

    return exit_code


def main() -> int:
    args = build_arg_parser().parse_args()
    try:
        return asyncio.run(run_monitor(args))
    except KeyboardInterrupt:
        emit(type="state", state="stopped", detail="已中断")
        emit(type="exit", code=0)
        return 0
    except Exception as exc:  # 兜底：任何未捕获异常都要让 UI 看得到
        emit(type="state", state="error", detail=f"监控进程崩溃：{exc}")
        emit(type="exit", code=1)
        logger.exception("Monitor crashed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
