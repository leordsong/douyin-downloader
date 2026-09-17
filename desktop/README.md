# 抖音下载器 · Electron 桌面端

用 Electron 给 CLI 版 douyin-downloader 套一层简单 UI，聚焦三件事：

1. **登录抖音** —— 一键调起 `tools/cookie_fetcher`（Playwright 打开浏览器手动登录），在 UI 里点「完成登录」代替去终端按回车，Cookies 自动写入 `config/cookies.json` 和仓库根目录的 `config.yml`。
2. **直播监控录制** —— 添加任意多个直播链接，每个链接一个独立监控进程并行轮询；主播开播自动调用现有下载逻辑录制（FLV 优先），下播/达到单次录制上限后继续监控，适合分段录制（`单次录制上限` 填 3600 即每小时一个文件）。
3. **下载设置** —— 下载目录（原生文件夹选择器）、轮询间隔、`max_duration_seconds` / `chunk_size` / `idle_timeout_seconds` 等直播参数。

## 运行

前提：本机装好 [uv](https://docs.astral.sh/uv/) 和 Node.js。

```bash
cd desktop
npm install       # 安装 Electron
npm start
```

首次启动如果「Python 环境」或「浏览器组件」指示灯是红的，点登录卡片里的
**「安装运行依赖」**（等价于在仓库根目录执行 `uv sync --extra browser`，随后
`python -m playwright install chromium`），完成后即可登录。

## 打包成 exe

```bash
cd desktop
npm run dist          # portable 单文件 exe + NSIS 安装包，输出到 release/
npm run dist:portable # 只要 portable 单文件版
```

打包内容（`npm run prepare-dist` 负责暂存）：

- **应用本体**（main.js / preload.js / renderer，进 app.asar）；
- **Python 后端源码**（`pyproject.toml` + `uv.lock` + `auth/ cli/ config/ control/ core/
  storage/ utils/ tools/ server/` + `desktop/live_monitor.py`，白名单复制；本机的
  `config.yml`、`config/cookies.json` 等私密文件**不会**被打进去）；
- **uv.exe**（取自本机 `where uv`，放在 `resources/vendor/uv/`）。

**首次启动行为**（打包版）：自动把后端源码释放到可写目录
`%APPDATA%\douyin-downloader-ui\backend\`，然后用自带的 uv.exe 执行
`uv sync --extra browser` 安装全部依赖（含 `browser` 可选组，即 playwright），
再执行 `python -m playwright install chromium` 下载浏览器内核。全程需要联网，
进度显示在登录卡片的日志里；之后启动直接复用，不再重复安装。应用更新版本后
会自动同步新后端源码并重跑 `uv sync`（保留已有 venv 与登录数据）。

产物：

| 文件 | 说明 |
|------|------|
| `release/DouyinDownloader-1.0.0-portable.exe` | 单文件绿色版，双击即用 |
| `release/DouyinDownloader-Setup-1.0.0.exe` | NSIS 安装包（可选安装目录，per-user） |

> exe 未做代码签名，Windows SmartScreen 可能提示「已保护你的电脑」，选
> 「更多信息 → 仍要运行」即可。

## 使用流程

1. **登录**：点「打开浏览器登录」→ 在弹出的 Chromium 里登录抖音 → 回到 UI 点「完成登录」。
2. **设置**：选择下载保存目录，按需调整轮询间隔与直播参数。
3. **添加监听链接**：支持以下形式（每个链接独立监控，并行互不影响）：
   - `https://live.douyin.com/123456789`
   - `https://www.douyin.com/follow/live/123456789`
   - **主播主页** `https://www.douyin.com/user/{sec_uid}` —— 按抖音号监听：每轮拉取
     主页页面，从头像区（开播时头像外层会出现带直播间链接的锚点和「直播中」徽标）
     检测直播状态，开播即转入录制，适合"只知账号、不想先开直播间"的场景
   - `webcast.amemv.com/douyin/webcast/reflow/…` 回流链接
   - `v.douyin.com/…` 短链（监控进程启动时解析一次）
   - 纯房间号，如 `123456789`
4. **开始监控**：单行「开始」或右上角「全部开始」。状态含义：
   `检查中` → `等待开播`（未开播，按轮询间隔自动重试）→ `录制中` → `录制完成`（自动回到监控循环）。
   每行可展开实时日志。
5. **停止**：点「停止」时 UI 会向监控进程发优雅停止指令，录制中的半成品文件会被保留（`.tmp` 提升为正式文件），不会损坏。

## 目录结构与原理

```
desktop/
├── main.js            Electron 主进程：窗口、设置持久化、子进程编排、IPC、首启后端引导
├── preload.js         contextBridge 白名单 API
├── live_monitor.py    每个链接一个的常驻监控进程（core/live_watcher.py 的进程壳）
├── scripts/prepare-dist.js  打包前暂存后端源码白名单 + 捆绑 uv.exe
├── data/settings.json UI 设置（下载目录、直播参数、链接列表），运行时生成
└── renderer/          无框架的原生 HTML/CSS/JS
```

> 监听与开播检测的核心逻辑在 `core/live_watcher.py`（CLI 的 `link + mode: live`
> 与本 UI 共用）。`core/`、`cli/`、`config/` 属于与桌面版兄弟项目共享同步的目录，
> 改动这些文件后需要按 AGENTS.md 的约定同步到兄弟项目。

- **并行**：CLI 的多链接处理是串行的，所以这里为每个链接单独起一个
  `live_monitor.py` 进程，进程级并行，一个直播间录制不会阻塞其他直播间。
- **事件协议**：监控进程在 stdout 上输出 `[DW_EVENT] {json}` 结构化事件
  （`starting / checking / waiting / recording / finished / error / login_required / stopped`），
  其余输出按日志行展示；UI 写入一行 `stop` 到其 stdin 即优雅停止，stdin 关闭
  （UI 退出）也会自动停止，避免孤儿进程。
- **不改动现有 CLI**：`desktop/` 目录自包含，Python 侧只新增 `live_monitor.py`，
  下载逻辑完全复用现有代码（cookies、限速、重试、命名模板等与 CLI 行为一致）。

## 注意

- 登录态失效时对应链接会显示「需要登录」，重新登录后再点开始即可。
- `config.yml` 仍是 CLI 的唯一配置来源；UI 的「下载设置」仅通过命令行参数覆盖
  对应监控进程，不会改写你的 `config.yml`。
- 直播录制输出 `.flv`（选中 HLS 源时是 `.m3u8` 播放列表文本，见日志提示），
  文件落在 `下载目录/{作者昵称}/live/…` 下，命名模板沿用 `config.yml`。
