const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';
// userData 固定用 ASCII 目录名，避免中文路径影响 venv / uv / playwright
const APP_DATA_NAME = 'douyin-downloader-ui';

// ---------------------------------------------------------------- 路径层
// 开发模式：BACKEND_DIR = 仓库根，UI 直接用仓库里的 .venv / config.yml。
// 打包模式：只读资源在 process.resourcesPath（python-project/、vendor/uv/），
// 首次启动把 Python 后端释放到 %APPDATA%/douyin-downloader-ui/backend，
// 之后的 .venv、config.yml、cookies、数据库都落在那个可写目录。
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), APP_DATA_NAME));
}

const DEV_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = app.isPackaged ? process.resourcesPath : DEV_ROOT;
const BACKEND_DIR = app.isPackaged
  ? path.join(app.getPath('appData'), APP_DATA_NAME, 'backend')
  : DEV_ROOT;
const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CONFIG_YML = path.join(BACKEND_DIR, 'config.yml');
const COOKIES_JSON = path.join(BACKEND_DIR, 'config', 'cookies.json');
const MONITOR_SCRIPT = path.join(BACKEND_DIR, 'desktop', 'live_monitor.py');
const BUNDLED_UV = path.join(RESOURCES_DIR, 'vendor', 'uv', IS_WIN ? 'uv.exe' : 'uv');
const VENV_PYTHON = path.join(
  BACKEND_DIR, '.venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python'
);

let mainWindow = null;
let settings = null;
let loginChild = null;
let depsChild = null;
const monitors = new Map(); // linkId -> { child, state, killTimer }
let cachedUvPath = null;

// ---------------------------------------------------------------- utilities

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.send(channel, payload);
  }
}

function defaultDownloadPath() {
  if (!app.isPackaged) return path.join(DEV_ROOT, 'Downloaded');
  try {
    return path.join(app.getPath('videos'), '抖音下载器');
  } catch {
    return path.join(DATA_DIR, 'Downloaded');
  }
}

function defaultSettings() {
  return {
    downloadPath: defaultDownloadPath(),
    pollIntervalSeconds: 60,
    live: {
      maxDurationSeconds: 0, // 0 = 录到主播下播
      chunkSize: 65536,
      idleTimeoutSeconds: 30,
    },
    links: [], // { id, url }
  };
}

function loadSettings() {
  if (settings) return settings;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  const defaults = defaultSettings();
  settings = {
    ...defaults,
    ...stored,
    live: { ...defaults.live, ...(stored.live || {}) },
    links: Array.isArray(stored.links) ? stored.links : [],
  };
  return settings;
}

function saveSettings(next) {
  const current = loadSettings();
  settings = {
    ...defaultSettings(),
    ...current,
    ...next,
    live: { ...defaultSettings().live, ...current.live, ...(next.live || {}) },
    links: next.links !== undefined ? next.links : current.links,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return settings;
}

function findUv() {
  if (cachedUvPath) return cachedUvPath;
  const candidates = [];
  if (process.env.DOUYIN_UI_UV) candidates.push(process.env.DOUYIN_UI_UV);
  if (fs.existsSync(BUNDLED_UV)) candidates.push(BUNDLED_UV);
  try {
    const probe = spawnSync(IS_WIN ? 'where' : 'which', ['uv'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0) {
      const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) candidates.push(first);
    }
  } catch {
    /* not found */
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedUvPath = candidate;
      return cachedUvPath;
    } catch {
      /* next */
    }
  }
  return null;
}

function venvExists() {
  return fs.existsSync(VENV_PYTHON);
}

function cookiesConfigured() {
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_JSON, 'utf8'));
    if (raw && raw.msToken && raw.msToken !== 'YOUR_MS_TOKEN') return true;
  } catch {
    /* fallthrough */
  }
  try {
    const text = fs.readFileSync(CONFIG_YML, 'utf8');
    return /cookies:/i.test(text) && !text.includes('YOUR_MS_TOKEN');
  } catch {
    return false;
  }
}

let playwrightProbe = { ok: false, ts: 0 };
function playwrightInstalled() {
  // 结果缓存 10s：envStatus 调用频繁，且安装过程中别让同步探测卡住主进程
  if (Date.now() - playwrightProbe.ts < 10000) return playwrightProbe.ok;
  let ok = false;
  if (venvExists()) {
    const probe = spawnSync(VENV_PYTHON, ['-c', 'import playwright'], { windowsHide: true });
    ok = probe.status === 0;
  }
  playwrightProbe = { ok, ts: Date.now() };
  return ok;
}

function envStatus() {
  return {
    platform: process.platform,
    isPackaged: Boolean(app.isPackaged),
    projectRoot: BACKEND_DIR,
    configYmlExists: fs.existsSync(CONFIG_YML),
    uvFound: Boolean(findUv()),
    venvReady: venvExists(),
    cookiesReady: cookiesConfigured(),
    playwrightReady: playwrightInstalled(),
    loginRunning: Boolean(loginChild),
    depsRunning: Boolean(depsChild),
    runningMonitorIds: [...monitors.keys()],
  };
}

// ---------------------------------------------------------------- 首启后端引导
// 打包模式下把随包的 Python 后端释放到可写目录；版本变化时覆盖式更新
// （保留 .venv / config.yml / cookies 等运行期产物）。

function backendCopyFilter(srcPath) {
  const rel = path.relative(path.join(RESOURCES_DIR, 'python-project'), srcPath);
  if (!rel) return true;
  const parts = rel.split(/[\\/]/);
  const preserved = ['.venv', 'data', '.ui-build.json', 'config.yml', '.cookies.json', 'dy_downloader.db'];
  if (preserved.includes(parts[0])) return false;
  if (parts[0] === 'config' && parts[1] === 'cookies.json') return false;
  if (parts.includes('__pycache__')) return false;
  return true;
}

function ensureBackend() {
  if (!app.isPackaged) return { needsSync: false, firstRun: false };
  const src = path.join(RESOURCES_DIR, 'python-project');
  if (!fs.existsSync(path.join(src, 'pyproject.toml'))) {
    send('deps:log', { stream: 'err', line: '[启动] 随包资源缺少 python-project，无法初始化后端' });
    return { needsSync: false, firstRun: false, broken: true };
  }
  const markerPath = path.join(BACKEND_DIR, '.ui-build.json');
  let marker = {};
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    marker = {};
  }
  const version = app.getVersion();
  const firstRun = !fs.existsSync(path.join(BACKEND_DIR, 'pyproject.toml'));
  const versionChanged = marker.version !== version;

  if (firstRun || versionChanged) {
    fs.mkdirSync(BACKEND_DIR, { recursive: true });
    fs.cpSync(src, BACKEND_DIR, { recursive: true, force: true, filter: backendCopyFilter });
    fs.writeFileSync(markerPath, JSON.stringify({ version, updated: new Date().toISOString() }, null, 2));
    send('deps:log', {
      stream: 'out',
      line: firstRun
        ? `[启动] 已释放 Python 后端到 ${BACKEND_DIR}`
        : `[启动] 应用更新到 v${version}，后端源码已同步`,
    });
  }
  return { needsSync: firstRun || versionChanged || !venvExists() || !playwrightInstalled(), firstRun, versionChanged };
}

// ---------------------------------------------------------------- 行缓冲

function attachLineReader(child, onLine) {
  const buffers = { stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      buffers[stream] += chunk;
      let idx;
      while ((idx = buffers[stream].indexOf('\n')) >= 0) {
        let line = buffers[stream].slice(0, idx);
        buffers[stream] = buffers[stream].slice(idx + 1);
        line = line.replace(/\r$/, '');
        if (line) onLine(stream, line);
      }
      if (buffers[stream].length > 8192) {
        onLine(stream, buffers[stream]);
        buffers[stream] = '';
      }
    });
  }
}

function spawnPython(args, { cwd = BACKEND_DIR } = {}) {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8:replace',
    PYTHONUTF8: '1',
  };
  return spawn(VENV_PYTHON, args, { cwd, env, windowsHide: true });
}

// ---------------------------------------------------------------- login flow

function startLogin() {
  if (loginChild) return { ok: false, error: '登录流程已在进行中' };
  if (!venvExists()) return { ok: false, error: 'Python 环境未就绪，请先安装运行依赖' };
  if (!playwrightInstalled()) {
    return { ok: false, error: '缺少 playwright，请先安装登录依赖' };
  }
  loginChild = spawnPython(['-m', 'tools.cookie_fetcher', '--config', 'config.yml']);
  send('login:state', { phase: 'running' });
  attachLineReader(loginChild, (stream, line) => {
    send('login:log', { stream, line });
    if (/Press Enter/i.test(line)) {
      send('login:state', { phase: 'awaiting-confirm' });
    }
  });
  loginChild.on('error', (err) => {
    send('login:log', { stream: 'err', line: String(err) });
    finishLogin(1);
  });
  loginChild.on('close', (code) => finishLogin(code));
  return { ok: true };
}

function finishLogin(code) {
  loginChild = null;
  send('login:state', { phase: 'done', code });
  send('env:changed', envStatus());
}

function confirmLogin() {
  if (!loginChild || !loginChild.stdin.writable) {
    return { ok: false, error: '登录进程不在运行' };
  }
  loginChild.stdin.write('\n');
  return { ok: true };
}

function cancelLogin() {
  if (loginChild) {
    try {
      loginChild.kill();
    } catch {
      /* ignore */
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- deps install

function startDepsInstall() {
  if (depsChild) return { ok: false, error: '依赖安装正在进行中' };
  const uvPath = findUv();
  if (!uvPath) {
    return {
      ok: false,
      error: '未找到 uv。打包版应自带 uv.exe（resources/vendor/uv），开发机请安装 uv 并加入 PATH',
    };
  }
  send('deps:state', { phase: 'running' });
  console.log(`[deps] uv sync start: uv=${uvPath} cwd=${BACKEND_DIR}`);
  send('deps:log', { stream: 'out', line: `$ uv sync --extra browser  (cwd: ${BACKEND_DIR})` });

  const sync = spawn(uvPath, ['sync', '--extra', 'browser'], {
    cwd: BACKEND_DIR,
    windowsHide: true,
  });
  depsChild = sync;
  attachLineReader(sync, (stream, line) => send('deps:log', { stream, line }));
  sync.on('error', (err) => {
    send('deps:log', { stream: 'err', line: String(err) });
    finishDeps(1);
  });
  sync.on('close', (code) => {
    if (code !== 0) {
      finishDeps(code);
      return;
    }
    // 浏览器二进制单独下载（playwright install chromium）
    send('deps:log', { stream: 'out', line: '$ python -m playwright install chromium' });
    const browser = spawnPython(['-m', 'playwright', 'install', 'chromium']);
    depsChild = browser;
    attachLineReader(browser, (stream, line) => send('deps:log', { stream, line }));
    browser.on('error', (err) => {
      send('deps:log', { stream: 'err', line: String(err) });
      finishDeps(1);
    });
    browser.on('close', (bcode) => finishDeps(bcode));
  });
  return { ok: true };
}

function finishDeps(code) {
  depsChild = null;
  console.log(`[deps] install finished, exit=${code}`);
  playwrightProbe = { ok: false, ts: 0 }; // 清掉安装期间的旧探测缓存
  send('deps:state', { phase: 'done', code });
  send('env:changed', envStatus());
}

// ---------------------------------------------------------------- monitors

function monitorArgs(link) {
  const s = loadSettings();
  return [
    MONITOR_SCRIPT,
    '--url', link.url,
    '--config', CONFIG_YML,
    '--download-path', s.downloadPath || defaultDownloadPath(),
    '--max-duration', String(s.live.maxDurationSeconds),
    '--chunk-size', String(s.live.chunkSize),
    '--idle-timeout', String(s.live.idleTimeoutSeconds),
    '--poll-interval', String(s.pollIntervalSeconds),
  ];
}

function startMonitor(linkId) {
  if (monitors.has(linkId)) return { ok: false, error: '该链接已在监控中' };
  const link = loadSettings().links.find((l) => l.id === linkId);
  if (!link) return { ok: false, error: '链接不存在' };
  if (!venvExists()) return { ok: false, error: 'Python 环境未就绪，请先安装运行依赖' };
  if (!cookiesConfigured()) return { ok: false, error: '尚未登录抖音，请先完成登录' };

  let child;
  try {
    child = spawnPython(monitorArgs(link));
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  monitors.set(linkId, { child, state: 'starting', killTimer: null });

  attachLineReader(child, (stream, line) => {
    if (stream === 'stdout' && line.startsWith('[DW_EVENT] ')) {
      try {
        const event = JSON.parse(line.slice('[DW_EVENT] '.length));
        const entry = monitors.get(linkId);
        if (entry && event.state) entry.state = event.state;
        send('monitor:event', { linkId, event });
      } catch {
        send('monitor:log', { linkId, stream, line });
      }
      return;
    }
    send('monitor:log', { linkId, stream, line });
  });

  child.on('error', (err) => {
    send('monitor:log', { linkId, stream: 'err', line: String(err) });
    stopMonitorEntry(linkId, -1);
  });
  child.on('close', (code) => stopMonitorEntry(linkId, code));
  return { ok: true };
}

function stopMonitorEntry(linkId, code) {
  const entry = monitors.get(linkId);
  monitors.delete(linkId);
  if (entry && entry.killTimer) {
    clearTimeout(entry.killTimer);
  }
  send('monitor:exit', { linkId, code });
  send('env:changed', envStatus());
}

function requestStopMonitor(linkId) {
  const entry = monitors.get(linkId);
  if (!entry) return { ok: false, error: '该链接未在监控' };
  const { child } = entry;
  try {
    // 优雅停止：监控进程收到 stop 后取消录制任务，半成品 .tmp 会被保留
    if (child.stdin && child.stdin.writable) {
      child.stdin.write('stop\n');
    } else {
      child.kill();
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  entry.killTimer = setTimeout(() => {
    if (monitors.has(linkId)) {
      try {
        monitors.get(linkId).child.kill();
      } catch {
        /* ignore */
      }
    }
  }, 10000);
  return { ok: true };
}

// ---------------------------------------------------------------- ipc

function registerIpc() {
  ipcMain.handle('env:status', () => envStatus());

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch || {}));

  ipcMain.handle('dialog:chooseDownloadDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载保存目录',
      defaultPath: loadSettings().downloadPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('app:openPath', (_e, target) => {
    const allowed = [loadSettings().downloadPath, BACKEND_DIR];
    const resolved = path.resolve(String(target || ''));
    if (!allowed.some((dir) => resolved === path.resolve(dir))) {
      return { ok: false, error: '路径不在允许范围内' };
    }
    return shell.openPath(resolved).then((msg) => (msg ? { ok: false, error: msg } : { ok: true }));
  });

  ipcMain.handle('login:start', () => startLogin());
  ipcMain.handle('login:confirm', () => confirmLogin());
  ipcMain.handle('login:cancel', () => cancelLogin());
  ipcMain.handle('deps:install', () => startDepsInstall());

  ipcMain.handle('monitor:start', (_e, linkId) => startMonitor(String(linkId)));
  ipcMain.handle('monitor:stop', (_e, linkId) => requestStopMonitor(String(linkId)));
  ipcMain.handle('monitor:stopAll', () => {
    for (const linkId of monitors.keys()) requestStopMonitor(linkId);
    return { ok: true };
  });

  ipcMain.handle('links:add', (_e, rawUrl) => {
    const url = normalizeLiveUrl(String(rawUrl || '').trim());
    if (!url) {
      return { ok: false, error: '链接格式不正确。支持 live.douyin.com/{房间号}、douyin.com/follow/live/{房间号}、主播主页 douyin.com/user/{sec_uid}、webcast.amemv.com 回流链接、v.douyin.com 短链或纯房间号' };
    }
    const s = loadSettings();
    if (s.links.some((l) => l.url === url)) {
      return { ok: false, error: '该链接已存在' };
    }
    const link = { id: crypto.randomUUID(), url };
    saveSettings({ links: [...s.links, link] });
    return { ok: true, link, settings: settings };
  });

  ipcMain.handle('links:remove', (_e, linkId) => {
    const id = String(linkId);
    if (monitors.has(id)) requestStopMonitor(id);
    const s = loadSettings();
    saveSettings({ links: s.links.filter((l) => l.id !== id) });
    return { ok: true, settings: settings };
  });
}

function normalizeLiveUrl(raw) {
  if (!raw) return null;
  let candidate = raw.replace(/^["'<]|[">']$/g, '').trim();
  const pureRoomId = candidate.match(/^(\d{5,})$/);
  if (pureRoomId) return `https://live.douyin.com/${pureRoomId[1]}`;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const u = new URL(candidate);
    const host = u.hostname.toLowerCase();
    if (host === 'live.douyin.com' && /^\/\d+\/?$/.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
    if (/^(www\.)?douyin\.com$/.test(host) && /^\/(?:follow|share)\/live\/\d+/.test(u.pathname)) {
      return `${u.origin}${u.pathname.split('/').slice(0, 4).join('/')}`;
    }
    if (host === 'webcast.amemv.com' && /^\/douyin\/webcast\/reflow\/\d+/.test(u.pathname)) {
      return `${u.origin}${u.pathname.split('/').slice(0, 5).join('/')}`;
    }
    if (/^(www\.)?douyin\.com$/.test(host) && /^\/user\/[A-Za-z0-9_-]+/.test(u.pathname)) {
      // 主播主页：监控进程每轮拉主页 SSR 检测头像区直播状态，开播即录
      return `${u.origin}${u.pathname.split('/').slice(0, 3).join('/')}`;
    }
    if (/^(v\.douyin\.com|v\.iesdouyin\.com)$/.test(host)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- window

function createWindow() {
  // DW_CAPTURE 模式用离屏渲染截图：窗口不显示、不抢焦点，适合自动化验证
  const offscreen = Boolean(process.env.DW_CAPTURE);
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '抖音下载器',
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    show: !offscreen,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: offscreen,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (process.env.DW_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

async function waitForBackendReady(timeoutMs) {
  // 每 3s 轮询一次直到环境就绪或超时。不能因「安装进程暂时不在运行」提前退出：
  // 自动安装在 ready 后 500ms 才启动，截图流程可能跑在它前面。
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const env = envStatus();
    if (env.venvReady && env.playwrightReady) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId('com.douyin.downloader.desktop');

  app.whenReady().then(async () => {
    const bootstrap = ensureBackend();
    registerIpc();
    createWindow();

    // 首次启动 / 版本更新后自动补齐后端依赖：uv sync --extra browser + chromium
    if (bootstrap.needsSync) {
      setTimeout(() => startDepsInstall(), 500);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // 冒烟/截图：DW_SMOKE=1 加载完成后退出；DW_CAPTURE=<path> 先存一张渲染截图，
    // DW_CAPTURE_WAIT_BACKEND=1 时先等首启依赖安装完成再截（上限 10 分钟）。
    if ((process.env.DW_SMOKE === '1' || process.env.DW_CAPTURE) && mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => {
        (async () => {
          try {
            if (process.env.DW_CAPTURE) {
              if (process.env.DW_CAPTURE_WAIT_BACKEND === '1') {
                await waitForBackendReady(10 * 60 * 1000);
              }
              await new Promise((r) => setTimeout(r, 1500));
              const image = await mainWindow.webContents.capturePage();
              fs.writeFileSync(process.env.DW_CAPTURE, image.toPNG());
              process.stdout.write('DW_CAPTURE_OK\n');
            } else {
              process.stdout.write('DW_SMOKE_OK\n');
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch (err) {
            process.stderr.write(`DW_SMOKE_ERR ${err}\n`);
          } finally {
            app.quit();
          }
        })();
      });
    }
  });

  app.on('window-all-closed', () => {
    for (const [, entry] of monitors) {
      try {
        if (entry.child.stdin && entry.child.stdin.writable) entry.child.stdin.write('stop\n');
        else entry.child.kill();
      } catch {
        /* ignore */
      }
    }
    if (loginChild) {
      try {
        loginChild.kill();
      } catch {
        /* ignore */
      }
    }
    if (depsChild) {
      try {
        depsChild.kill();
      } catch {
        /* ignore */
      }
    }
    app.quit();
  });
}

// 便于单元测试直接复用链接归一化逻辑（Electron 入口不使用导出）
module.exports = { normalizeLiveUrl };
