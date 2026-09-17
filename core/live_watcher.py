"""直播开播监听（link + mode: live）。

两种监听目标（按 URL 类型自动区分）：
- 主播主页（douyin.com/user/{sec_uid}）：每轮拉取主页 SSR，从头像区检测直播间号
  （开播时头像外层出现 data-e2e="web_others_homepage" 锚点，内含
  live.douyin.com/{web_rid} 链接和 user-info-living「直播中」徽标），开播即通过
  download_fn 录制，未开播按轮询间隔重试；
- 直播间链接（live.douyin.com/{web_rid} 等）：每轮直接尝试录制（LiveDownloader
  对未开播房间按 skipped 结算，不会阻塞）。

被两处复用：CLI 的 ``link + mode: [live]``（见 cli.main._run_live_watchers）和
desktop UI 的每链接监控进程（desktop/live_monitor.py）。

事件协议：on_event 收到 ``{"event": ..., "detail": ..., "room_id": ..., "hint": ...}``，
event 取值 starting / checking / live_detected / waiting / finished / error /
login_required / stopped。录制过程中的细粒度进度由 progress_reporter 负责，
本模块不重复上报。
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Awaitable, Callable, Dict, Optional

from core import URLParser
from core.downloader_base import DownloadResult
from utils.logger import setup_logger
from utils.validators import normalize_short_url

logger = setup_logger("LiveWatcher")

# 轮询间隔下限：主页/房间信息检查打得太密容易触发风控
MIN_POLL_INTERVAL_SECONDS = 15
# 录制结束后的宽限秒数：等主播真正下播，或开始下一段分段录制
RESTART_GRACE_SECONDS = 5
# 连续失败多少轮后在事件里附带「检查登录/链接」提示
CONSECUTIVE_FAIL_HINT = 3

DEFAULT_POLL_INTERVAL_SECONDS = 60

USER_PAGE_URL_TEMPLATE = "https://www.douyin.com/user/{sec_uid}"

EventCallback = Callable[[Dict[str, Any]], None]
# download_fn(url) -> Awaitable[DownloadResult]；由调用方闭包 progress_reporter
DownloadFn = Callable[[str], Awaitable[Optional[DownloadResult]]]
# homepage_fetcher(sec_uid) -> Optional[live_url]；默认用 DouyinAPIClient 抓主页 SSR，
# 测试可注入替身
HomepageFetcher = Callable[[str], Awaitable[Optional[str]]]

# 头像区锚点：<a href="https://live.douyin.com/{web_rid}?..." data-e2e="web_others_homepage">
# 「直播中」徽标：<span data-e2e="user-info-living">直播中</span>（仅开播时渲染）
_ANCHOR_TAG_PATTERN = re.compile(r"<a\b[^>]*>")
_ANCHOR_LIVE_HREF_PATTERN = re.compile(r'href="https://live\.douyin\.com/(\d+)')
_ANY_LIVE_URL_PATTERN = re.compile(r"live\.douyin\.com/(\d+)")


def detect_user_live_web_rid(html: str) -> Optional[str]:
    """从用户主页 SSR HTML 解析头像区的直播间号（开播时才渲染），未开播返回 None。"""
    for anchor in _ANCHOR_TAG_PATTERN.finditer(html):
        tag = anchor.group(0)
        if 'data-e2e="web_others_homepage"' not in tag:
            continue
        href = _ANCHOR_LIVE_HREF_PATTERN.search(tag)
        if href:
            return href.group(1)
    # 兜底：「直播中」徽标出现时取页面里第一个直播间号
    if 'data-e2e="user-info-living"' in html:
        fallback = _ANY_LIVE_URL_PATTERN.search(html)
        if fallback:
            return fallback.group(1)
    return None


def resolve_watch_target(url: str) -> Dict[str, Any]:
    """离线解析监听目标。

    返回 ``{"kind": "room"|"account"|"unsupported", "url": 规范化URL,
    "room_id"|"sec_uid": ..., "type": 原始类型}``；短链在这里不解析（需要网络），
    返回 kind="short"，由 watch_live 首轮解析。
    """
    parsed = URLParser.parse(url)
    if not parsed:
        return {"kind": "unsupported", "url": url, "type": None}
    url_type = parsed.get("type")
    if url_type == "live" and parsed.get("room_id"):
        return {"kind": "room", "url": url, "room_id": str(parsed["room_id"]), "type": url_type}
    if url_type == "user" and parsed.get("sec_uid"):
        return {
            "kind": "account",
            "url": url,
            "sec_uid": str(parsed["sec_uid"]),
            "type": url_type,
        }
    if url_type == "short":
        return {"kind": "short", "url": url, "type": url_type}
    return {"kind": "unsupported", "url": url, "type": url_type}


async def default_homepage_fetcher_factory(
    cookies: Dict[str, str], proxy: str
) -> HomepageFetcher:
    """构造默认的主页探测函数：探测复用一个 API 客户端会话，close() 释放。"""
    from core import DouyinAPIClient  # 局部导入避免 core 包内循环

    client = DouyinAPIClient(cookies, proxy=proxy or None)
    session = await client.get_session()

    async def _fetch(sec_uid: str) -> Optional[str]:
        url = USER_PAGE_URL_TEMPLATE.format(sec_uid=sec_uid)
        headers = {**client.headers, "Referer": "https://www.douyin.com/"}
        try:
            async with session.get(
                url, headers=headers, proxy=client.proxy or None
            ) as response:
                if response.status != 200:
                    logger.error(
                        "User page request failed: sec_uid=%s, status=%s",
                        sec_uid,
                        response.status,
                    )
                    return None
                html = await response.text()
        except Exception as exc:
            logger.error("User page fetch failed: sec_uid=%s, error=%s", sec_uid, exc)
            return None
        web_rid = detect_user_live_web_rid(html)
        if web_rid:
            return f"https://live.douyin.com/{web_rid}"
        return None

    async def _close() -> None:
        await client.close()

    _fetch.close = _close  # type: ignore[attr-defined]
    return _fetch


async def watch_live(
    target_url: str,
    *,
    download_fn: DownloadFn,
    cookies: Dict[str, str],
    proxy: str = "",
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    stop_event: Optional[asyncio.Event] = None,
    on_event: Optional[EventCallback] = None,
    homepage_fetcher: Optional[HomepageFetcher] = None,
) -> None:
    """监听一个目标直到 stop_event 置位。

    - room 目标：每轮 ``download_fn(url)``（未开播房间由 LiveDownloader 按
      skipped 快速返回）；
    - account 目标：每轮探测主页，开播时 ``download_fn(live_url)``。

    录制中的取消由调用方控制：stop_event 置位后本轮下载任务被 cancel，
    LiveDownloader 的 CancelledError 分支会保留半成品文件。
    异常安全：任何一轮失败都会继续下一轮（附退避提示），只有 LoginRequiredError
    会让监听结束（登录态失效需要人工介入）。
    """
    stop = stop_event or asyncio.Event()
    interval = max(MIN_POLL_INTERVAL_SECONDS, float(poll_interval_seconds or DEFAULT_POLL_INTERVAL_SECONDS))
    emit: EventCallback = on_event or (lambda event: None)

    target = resolve_watch_target(target_url)
    if target["kind"] == "short":
        emit({"event": "checking", "detail": "解析短链…"})
        resolved = await _resolve_short_link(target_url, cookies, proxy)
        if not resolved:
            emit({"event": "error", "detail": "短链解析失败，请直接粘贴直播间或主页链接"})
            return
        target = resolve_watch_target(resolved)
        emit({"event": "checking", "detail": f"短链已解析：{resolved}"})

    if target["kind"] == "unsupported":
        type_name = target.get("type") or "无法识别"
        emit({"event": "error", "detail": f"仅支持直播间链接或主播主页链接（识别为：{type_name}）"})
        return

    account_mode = target["kind"] == "account"
    canonical_url: str = target["url"]
    target_id: str = str(target.get("room_id") or target.get("sec_uid") or "")
    emit(
        {
            "event": "starting",
            "mode": "account" if account_mode else "room",
            "target_id": target_id,
            "url": canonical_url,
            "poll_interval": interval,
        }
    )

    if homepage_fetcher is None:
        homepage_fetcher = await default_homepage_fetcher_factory(cookies, proxy)

    consecutive_failures = 0
    login_lost = False
    try:
        while True:
            result: Optional[DownloadResult]
            try:
                if account_mode:
                    result = await _account_cycle(
                        str(target["sec_uid"]),
                        homepage_fetcher,
                        download_fn,
                        emit,
                    )
                else:
                    emit({"event": "checking", "detail": "检查直播间状态"})
                    result = await download_fn(canonical_url)
            except asyncio.CancelledError:
                raise
            except LoginRequiredInterrupt as exc:
                login_lost = True
                emit({"event": "login_required", "detail": str(exc) or "登录态失效，请重新登录"})
                break
            except Exception as exc:  # 单轮异常不终止监听
                logger.exception("Live watch cycle failed")
                result = None
                emit({"event": "error", "detail": f"本轮执行异常：{exc}"})

            if isinstance(result, DownloadResult) and result.success > 0:
                consecutive_failures = 0
                emit({"event": "finished", "detail": f"录制完成（成功 {result.success}）"})
                if await _sleep_or_stop(RESTART_GRACE_SECONDS, stop):
                    break
                continue

            if result is None or (isinstance(result, DownloadResult) and result.failed > 0):
                consecutive_failures += 1
                hint = (
                    "连续多次失败，请检查登录状态或链接是否有效"
                    if consecutive_failures >= CONSECUTIVE_FAIL_HINT
                    else ""
                )
                emit({"event": "error", "detail": "本轮检查失败", "hint": hint})
            else:
                # skipped 或零结果：未开播
                consecutive_failures = 0
                emit({"event": "waiting", "detail": "主播当前未在直播"})

            if await _sleep_or_stop(interval, stop):
                break
    except asyncio.CancelledError:
        # 外部取消（Ctrl+C / UI 退出）：录制中的半成品由 LiveDownloader 保留
        raise
    finally:
        if homepage_fetcher is not None and hasattr(homepage_fetcher, "close"):
            await homepage_fetcher.close()  # type: ignore[attr-defined]
        if not login_lost:
            emit({"event": "stopped"})


class LoginRequiredInterrupt(Exception):
    """登录态失效，监听无法继续（由 download_fn 包装层抛出）。"""


async def _account_cycle(
    sec_uid: str,
    homepage_fetcher: HomepageFetcher,
    download_fn: DownloadFn,
    emit: EventCallback,
) -> Optional[DownloadResult]:
    """一轮主页探测：未开播返回空结果（按 waiting 结算），开播返回录制结果。"""
    live_url = await homepage_fetcher(sec_uid)
    if not live_url:
        emit({"event": "waiting", "detail": "主页未检测到直播"})
        return DownloadResult()
    web_rid = live_url.rsplit("/", 1)[-1]
    emit({"event": "live_detected", "detail": "主播直播中，开始录制", "room_id": web_rid})
    return await download_fn(live_url)


async def _resolve_short_link(url: str, cookies: Dict[str, str], proxy: str) -> Optional[str]:
    try:
        from core import DouyinAPIClient

        async with DouyinAPIClient(cookies, proxy=proxy or None) as client:
            return await client.resolve_short_url(normalize_short_url(url))
    except Exception as exc:
        logger.error("Short URL resolve failed: %s", exc)
        return None


async def _sleep_or_stop(seconds: float, stop: asyncio.Event) -> bool:
    """睡 seconds 秒；期间 stop 被置位则立刻返回 True。"""
    if seconds <= 0:
        return stop.is_set()
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
        return True
    except asyncio.TimeoutError:
        return False


def poll_interval_from_config(live_config: Any) -> float:
    """从配置的 live 段读取轮询间隔（秒），带默认值与下限钳制。"""
    cfg = live_config if isinstance(live_config, dict) else {}
    try:
        value = float(cfg.get("poll_interval_seconds") or DEFAULT_POLL_INTERVAL_SECONDS)
    except (TypeError, ValueError):
        value = DEFAULT_POLL_INTERVAL_SECONDS
    return max(MIN_POLL_INTERVAL_SECONDS, value)
