/* 渲染层逻辑：状态渲染 + IPC 调用，不持有任何 Node 能力。 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const STATE_LABELS = {
  idle: '未监控',
  starting: '启动中',
  checking: '检查中',
  waiting: '等待开播',
  recording: '录制中',
  finished: '录制完成',
  error: '出错',
  login_required: '需要登录',
  stopped: '已停止',
};

const state = {
  env: null,
  settings: null,
  // linkId -> { state, detail, file, logLines: [] }
  runtime: new Map(),
  loginPhase: 'idle', // idle | running | awaiting-confirm
  depsRunning: false,
};

function runtimeOf(linkId) {
  if (!state.runtime.has(linkId)) {
    state.runtime.set(linkId, { state: 'idle', detail: '', file: '', room: '', logLines: [] });
  }
  return state.runtime.get(linkId);
}

function appendLog(rt, stream, line) {
  rt.logLines.push(line);
  if (rt.logLines.length > 400) rt.logLines.splice(0, rt.logLines.length - 400);
  const box = rt.logEl;
  if (!box || box.classList.contains('hidden')) return;
  box.textContent = rt.logLines.join('\n');
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------ env chips & login card */

function chip(label, cls) {
  return `<span class="chip ${cls || ''}">${label}</span>`;
}

function renderEnv() {
  const env = state.env;
  if (!env) return;
  $('#envChips').innerHTML = [
    chip('uv', env.uvFound ? 'ok' : 'bad'),
    chip('Python 环境', env.venvReady ? 'ok' : 'bad'),
    chip('登录状态', env.cookiesReady ? 'ok' : 'bad'),
    chip('浏览器组件', env.playwrightReady ? 'ok' : 'bad'),
  ].join('');

  $('#cookieChip').textContent = env.cookiesReady ? '已登录' : '未登录';
  $('#cookieChip').className = `chip ${env.cookiesReady ? 'ok' : 'bad'}`;

  const depsNeeded = !env.venvReady || !env.playwrightReady;
  $('#btnDeps').classList.toggle('hidden', !(depsNeeded && !state.depsRunning));
  $('#btnDeps').textContent = env.venvReady ? '下载浏览器组件' : '安装运行依赖';

  $('#btnLogin').disabled = !env.venvReady || !env.playwrightReady || state.loginPhase === 'running';
  $('#btnLogin').textContent = state.loginPhase === 'running' ? '登录进行中…'
    : env.cookiesReady ? '重新登录' : '打开浏览器登录';
  $('#loginSpinner').classList.toggle('hidden', state.loginPhase !== 'running');
  $('#btnLoginConfirm').classList.toggle('hidden', state.loginPhase !== 'awaiting-confirm');
  $('#btnLoginCancel').classList.toggle('hidden', state.loginPhase !== 'running');
  if (state.loginPhase === 'idle') $('#loginLog').classList.add('hidden');

  $('#loginHint').textContent = depsNeeded
    ? '检测到 Python 环境 / 浏览器组件未就绪，请先点「安装运行依赖」（会运行 uv sync --extra browser 并下载 Chromium）。'
    : '点击「打开浏览器登录」后会弹出 Chromium 窗口，登录抖音；回到这里点「完成登录」即可保存 Cookies。';

  renderLinks(); // 开始按钮可用性依赖登录状态
}

/* ------------------------------------------------ settings */

let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.api.setSettings(collectSettings());
    $('#settingsSaved').classList.add('show');
    setTimeout(() => $('#settingsSaved').classList.remove('show'), 1200);
  }, 500);
}

function collectSettings() {
  const num = (v, fallback, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    downloadPath: $('#downloadPath').value.trim(),
    pollIntervalSeconds: num($('#pollInterval').value, 60, 15),
    live: {
      maxDurationSeconds: num($('#maxDuration').value, 0),
      chunkSize: num($('#chunkSize').value, 65536, 1024),
      idleTimeoutSeconds: num($('#idleTimeout').value, 30, 1),
    },
  };
}

function fillSettings(s) {
  $('#downloadPath').value = s.downloadPath || '';
  $('#pollInterval').value = s.pollIntervalSeconds;
  $('#maxDuration').value = s.live.maxDurationSeconds;
  $('#chunkSize').value = s.live.chunkSize;
  $('#idleTimeout').value = s.live.idleTimeoutSeconds;
}

/* ------------------------------------------------ link list */

function renderLinks() {
  const list = $('#linkList');
  const links = (state.settings && state.settings.links) || [];
  $('#emptyLinks').classList.toggle('hidden', links.length > 0);
  list.innerHTML = '';
  const tpl = $('#linkRowTpl');

  for (const link of links) {
    const rt = runtimeOf(link.id);
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = link.id;

    const running = isRunningState(rt.state);
    node.querySelector('.link-url').textContent = link.url;
    const roomPrefix = rt.room ? `房间 ${rt.room} · ` : '';
    node.querySelector('.link-detail').textContent = roomPrefix + (rt.detail || defaultDetail(rt.state));
    node.querySelector('.dot').className = `dot ${rt.state}`;
    const label = node.querySelector('.state-label');
    label.textContent = STATE_LABELS[rt.state] || rt.state;
    label.className = `state-label ${rt.state}`;

    const toggle = node.querySelector('.act-toggle');
    toggle.textContent = running ? '停止' : '开始';
    toggle.className = `btn small act-toggle ${running ? 'danger' : 'success'}`;
    toggle.disabled = running ? false : !state.env || !state.env.cookiesReady || !state.env.venvReady;
    toggle.title = toggle.disabled ? '需要先完成登录并确保 Python 环境就绪' : '';

    const logBox = node.querySelector('.logbox');
    rt.logEl = logBox;
    logBox.textContent = rt.logLines.join('\n');
    logBox.classList.toggle('hidden', !rt.logOpen);

    node.querySelector('.act-log').addEventListener('click', () => {
      rt.logOpen = !rt.logOpen;
      logBox.classList.toggle('hidden', !rt.logOpen);
      if (rt.logOpen) {
        logBox.textContent = rt.logLines.join('\n');
        logBox.scrollTop = logBox.scrollHeight;
      }
    });
    toggle.addEventListener('click', () => onToggle(link));
    node.querySelector('.act-remove').addEventListener('click', () => onRemove(link));

    list.appendChild(node);
  }
}

function isRunningState(s) {
  return !['idle', 'stopped', 'error', 'login_required'].includes(s);
}

function defaultDetail(s) {
  switch (s) {
    case 'idle': return '点击「开始」开始监控';
    case 'waiting': return '主播未开播，按轮询间隔自动检查';
    case 'recording': return '正在录制直播流…';
    case 'error': return '';
    case 'login_required': return '请先登录抖音，再重新开始监控';
    default: return '';
  }
}

async function onToggle(link) {
  const rt = runtimeOf(link.id);
  if (isRunningState(rt.state)) {
    await window.api.monitorStop(link.id);
    rt.state = 'stopped';
    rt.detail = '正在停止…（等待录制安全收尾）';
    renderLinks();
  } else {
    rt.state = 'starting';
    rt.detail = '正在启动监控进程…';
    renderLinks();
    const res = await window.api.monitorStart(link.id);
    if (!res.ok) {
      rt.state = 'error';
      rt.detail = res.error;
      renderLinks();
    }
  }
}

async function onRemove(link) {
  if (isRunningState(runtimeOf(link.id).state)) {
    await window.api.monitorStop(link.id);
  }
  const res = await window.api.linksRemove(link.id);
  if (res.ok) {
    state.settings = res.settings;
    state.runtime.delete(link.id);
    renderLinks();
  }
}

/* ------------------------------------------------ events from main */

window.api.on('env:changed', (env) => {
  state.env = env;
  // 进程退出等被动变化需要同步到对应链接的运行态
  for (const [id, rt] of state.runtime) {
    if (isRunningState(rt.state) && !(env.runningMonitorIds || []).includes(id)) {
      if (['starting', 'checking', 'waiting', 'recording'].includes(rt.state)) {
        rt.state = 'stopped';
        rt.detail = '监控进程已退出';
      }
    }
  }
  renderEnv();
});

window.api.on('login:state', ({ phase }) => {
  if (phase === 'running') state.loginPhase = 'running';
  else if (phase === 'awaiting-confirm') state.loginPhase = 'awaiting-confirm';
  else {
    state.loginPhase = 'idle';
  }
  renderEnv();
});

window.api.on('login:log', ({ stream, line }) => {
  const box = $('#loginLog');
  box.classList.remove('hidden');
  box.textContent += line + '\n';
  box.scrollTop = box.scrollHeight;
  if (/Playwright is not installed/i.test(line)) renderEnv();
});

window.api.on('deps:state', ({ phase }) => {
  state.depsRunning = phase === 'running';
  renderEnv();
});

window.api.on('deps:log', ({ line }) => {
  const box = $('#loginLog');
  box.classList.remove('hidden');
  box.textContent += line + '\n';
  box.scrollTop = box.scrollHeight;
});

window.api.on('monitor:event', ({ linkId, event }) => {
  const rt = runtimeOf(linkId);
  if (event.room_id) rt.room = event.room_id;
  if (event.state) {
    rt.state = event.state;
    rt.detail = event.detail || defaultDetail(event.state);
    if (event.file) rt.file = event.file;
    if (event.hint) rt.detail += ` · ${event.hint}`;
    if (event.state === 'stopped') rt.detail = '已停止监控';
    if (event.state === 'starting' && !rt.room) rt.detail = rt.detail || '正在启动监控进程…';
    renderLinks();
  }
});

window.api.on('monitor:log', ({ linkId, stream, line }) => {
  appendLog(runtimeOf(linkId), stream, line);
});

window.api.on('monitor:exit', ({ linkId, code }) => {
  const rt = runtimeOf(linkId);
  appendLog(rt, 'sys', `[进程退出 code=${code}]`);
  if (['starting', 'checking', 'waiting', 'recording'].includes(rt.state)) {
    rt.state = 'stopped';
    rt.detail = '监控进程已退出';
    renderLinks();
  }
});

/* ------------------------------------------------ wire static controls */

$('#btnLogin').addEventListener('click', async () => {
  const res = await window.api.loginStart();
  if (!res.ok) alert(res.error);
  else $('#loginLog').textContent = '';
});

$('#btnLoginConfirm').addEventListener('click', async () => {
  const res = await window.api.loginConfirm();
  if (!res.ok) alert(res.error);
});

$('#btnLoginCancel').addEventListener('click', () => window.api.loginCancel());

$('#btnDeps').addEventListener('click', async () => {
  const res = await window.api.depsInstall();
  if (!res.ok) alert(res.error);
});

$('#btnBrowse').addEventListener('click', async () => {
  const dir = await window.api.chooseDownloadDir();
  if (dir) {
    $('#downloadPath').value = dir;
    queueSave();
  }
});

$('#btnOpenDir').addEventListener('click', () => window.api.openPath($('#downloadPath').value.trim()));

for (const id of ['downloadPath', 'pollInterval', 'maxDuration', 'chunkSize', 'idleTimeout']) {
  $('#' + id).addEventListener('input', queueSave);
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#linkInput');
  const res = await window.api.linksAdd(input.value);
  $('#addError').textContent = res.ok ? '' : res.error;
  if (res.ok) {
    input.value = '';
    state.settings = res.settings;
    renderLinks();
  }
});

$('#btnStartAll').addEventListener('click', async () => {
  for (const link of (state.settings ? state.settings.links : [])) {
    const rt = runtimeOf(link.id);
    if (!isRunningState(rt.state)) await onToggle(link);
  }
});

$('#btnStopAll').addEventListener('click', async () => {
  await window.api.monitorStopAll();
});

/* ------------------------------------------------ boot */

(async function boot() {
  state.env = await window.api.envStatus();
  state.settings = await window.api.getSettings();
  // UI 重启后，已在跑的监控进程按“监控中”显示
  for (const id of state.env.runningMonitorIds || []) {
    const rt = runtimeOf(id);
    rt.state = 'checking';
    rt.detail = '监控进行中（重连显示）';
  }
  fillSettings(state.settings);
  renderEnv();
})();
