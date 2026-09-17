"""core.live_watcher 的单元测试：全程离线，fetcher/download_fn 用替身。"""

import asyncio

import pytest

import core.live_watcher as lw
from core.downloader_base import DownloadResult
from core.live_watcher import (
    LoginRequiredInterrupt,
    detect_user_live_web_rid,
    poll_interval_from_config,
    resolve_watch_target,
    watch_live,
)

LIVE_AVATAR_HTML = (
    '<a href="https://live.douyin.com/837842834415?action_type=click&amp;room_id=7686342775331162943" '
    'data-e2e="web_others_homepage"><img alt="主播头像">'
    '<span data-e2e="user-info-living"><span> 直播中</span></span></a>'
)
NOT_LIVE_AVATAR_HTML = (
    '<div><span data-e2e="live-avatar" class="semi-avatar">'
    '<img src="https://p3-pc.douyinpic.com/img/aweme-avatar/x.jpeg" alt="某主播头像"></span></div>'
)
SEC_UID = "MS4wLjABAAAA" + "x" * 10
USER_URL = f"https://www.douyin.com/user/{SEC_UID}"
ROOM_URL = "https://live.douyin.com/123456789"


class EventRecorder:
    def __init__(self):
        self.events = []

    def __call__(self, event):
        self.events.append(event)

    def __iter__(self):
        return iter(self.events)

    def kinds(self):
        return [e.get("event") for e in self.events]


# ---------------------------------------------------------------- 检测函数


def test_detect_live_avatar_extracts_web_rid():
    assert detect_user_live_web_rid(LIVE_AVATAR_HTML) == "837842834415"


def test_detect_not_live_returns_none():
    assert detect_user_live_web_rid(NOT_LIVE_AVATAR_HTML) is None
    assert detect_user_live_web_rid("") is None


def test_detect_ignores_live_keyword_in_unrelated_text():
    # 作品标题提到「直播中」但头像区没有开播徽标：不能误判
    html = NOT_LIVE_AVATAR_HTML + '<span class="title">昨晚直播中说的福利</span>'
    assert detect_user_live_web_rid(html) is None


# ---------------------------------------------------------------- 目标解析


def test_resolve_watch_target_kinds():
    assert resolve_watch_target(ROOM_URL)["kind"] == "room"
    assert resolve_watch_target(USER_URL)["kind"] == "account"
    assert resolve_watch_target("https://v.douyin.com/iAbc123/")["kind"] == "short"
    assert resolve_watch_target("https://www.douyin.com/video/74123")["kind"] == "unsupported"


# ---------------------------------------------------------------- 监听循环


@pytest.fixture(autouse=True)
def fast_poll(monkeypatch):
    """把轮询下限钳到 0，让循环测试无需真实等待。"""
    monkeypatch.setattr(lw, "MIN_POLL_INTERVAL_SECONDS", 0)


@pytest.mark.asyncio
async def test_watch_account_mode_detects_then_records_then_stops():
    """未开播→等待；开播→live_detected→录制成功→宽限后停止。"""
    events = EventRecorder()
    calls = []
    stop = asyncio.Event()

    async def fetcher(sec_uid):
        calls.append(("fetch", sec_uid))
        if len([c for c in calls if c[0] == "fetch"]) >= 2:
            stop.set()  # 第二轮录制完成后的宽限等待里直接停
        return None if len(calls) == 1 else "https://live.douyin.com/837842834415"

    async def download_fn(url):
        calls.append(("download", url))
        result = DownloadResult()
        result.success = 1
        return result

    await watch_live(
        USER_URL,
        download_fn=download_fn,
        cookies={},
        poll_interval_seconds=0.01,
        stop_event=stop,
        on_event=events,
        homepage_fetcher=fetcher,
    )

    assert calls[0] == ("fetch", SEC_UID)
    assert ("download", "https://live.douyin.com/837842834415") in calls
    kinds = events.kinds()
    assert kinds[0] == "starting"
    assert "waiting" in kinds
    live_detected = next(e for e in events if e["event"] == "live_detected")
    assert live_detected["room_id"] == "837842834415"
    assert "finished" in kinds
    assert kinds[-1] == "stopped"


@pytest.mark.asyncio
async def test_watch_room_mode_polls_until_success():
    """房间模式：第一轮 skipped→waiting，第二轮成功→finished。"""
    events = EventRecorder()
    stop = asyncio.Event()
    downloads = []

    async def download_fn(url):
        downloads.append(url)
        result = DownloadResult()
        if len(downloads) == 1:
            result.skipped = 1  # 未开播
            return result
        stop.set()  # 成功后的宽限等待里直接停
        result.success = 1
        return result

    await watch_live(
        ROOM_URL,
        download_fn=download_fn,
        cookies={},
        poll_interval_seconds=0.01,
        stop_event=stop,
        on_event=events,
    )

    assert downloads == [ROOM_URL, ROOM_URL]
    kinds = events.kinds()
    assert kinds[0] == "starting"
    assert "waiting" in kinds
    assert "finished" in kinds
    assert kinds[-1] == "stopped"


@pytest.mark.asyncio
async def test_watch_reports_errors_and_hint():
    """download_fn 持续失败：error 事件重复出现，达到阈值后带 hint。"""
    events = EventRecorder()
    stop = asyncio.Event()

    async def download_fn(url):
        result = DownloadResult()
        result.failed = 1
        if events.kinds().count("error") >= 3:  # 三次失败后停
            stop.set()
        return result

    await watch_live(
        ROOM_URL,
        download_fn=download_fn,
        cookies={},
        poll_interval_seconds=0.01,
        stop_event=stop,
        on_event=events,
    )

    errors = [e for e in events if e["event"] == "error"]
    assert len(errors) >= 2
    assert any(e.get("hint") for e in errors)


@pytest.mark.asyncio
async def test_watch_login_required_stops_without_stopped_event():
    """登录失效：login_required 事件后监听结束，不再发 stopped。"""
    events = EventRecorder()

    async def download_fn(url):
        raise LoginRequiredInterrupt("登录态失效")

    await watch_live(
        ROOM_URL,
        download_fn=download_fn,
        cookies={},
        poll_interval_seconds=0.01,
        on_event=events,
    )

    assert "login_required" in events.kinds()
    assert "stopped" not in events.kinds()


@pytest.mark.asyncio
async def test_watch_unsupported_url_reports_error():
    events = EventRecorder()

    async def download_fn(url):  # pragma: no cover - 不应被调用
        raise AssertionError("download_fn should not be called")

    await watch_live(
        "https://www.douyin.com/video/74123",
        download_fn=download_fn,
        cookies={},
        on_event=events,
    )

    assert events.kinds() == ["error"]


def test_poll_interval_clamped():
    # fast_poll fixture 会把 MIN 钳到 0，因此期望值按当前下限计算
    assert poll_interval_from_config({}) == lw.DEFAULT_POLL_INTERVAL_SECONDS
    assert poll_interval_from_config({"poll_interval_seconds": 5}) == max(
        lw.MIN_POLL_INTERVAL_SECONDS, 5
    )
    assert poll_interval_from_config({"poll_interval_seconds": 120}) == 120
    assert poll_interval_from_config({"poll_interval_seconds": "bad"}) == lw.DEFAULT_POLL_INTERVAL_SECONDS
