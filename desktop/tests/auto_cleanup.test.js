const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(stored = {}, overrides = {}) {
  const filename = path.resolve(__dirname, '../main.js');
  const realRequire = createRequire(filename);
  const handlers = new Map();
  const scheduled = [];
  const calls = { scans: 0, trashes: 0, dialogs: 0, saved: null, unlinks: [], recycled: [] };
  const electron = {
    app: { isPackaged: false, requestSingleInstanceLock: () => false, quit() {}, disableHardwareAcceleration() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showMessageBox: async () => { calls.dialogs += 1; return { response: 0 }; } },
    shell: { trashItem: async (target) => calls.recycled.push(target) },
  };
  const cleanup = {
    ...realRequire('./download_cleanup'),
    scanDownloads: async () => {
      calls.scans += 1;
      return { files: [{}], bytes: 5, errors: [] };
    },
    trashDownloads: async () => {
      calls.trashes += 1;
      return { count: 1, bytes: 5, skipped: 0, errors: [] };
    },
    ...overrides,
  };
  const context = {
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === './download_cleanup') return cleanup;
      if (name === 'child_process') return { spawnSync: () => ({ status: 1 }) };
      if (name === 'fs') return {
        promises: { mkdir: async () => {}, appendFile: async () => {},
          unlink: async (target) => calls.unlinks.push(target) },
        existsSync: () => false,
        readFileSync: () => JSON.stringify(stored),
        mkdirSync() {},
        writeFileSync: (_target, text) => { calls.saved = JSON.parse(text); },
        renameSync() {},
      };
      return realRequire(name);
    },
    __dirname: path.dirname(filename), module: { exports: {} }, process,
    setImmediate: (fn) => scheduled.push(fn), clearTimeout() {}, console,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    module.exports = { runAutoCleanup, cleanupDownloads, loadSettings, saveSettings,
      monitors, registerIpc, stopMonitorEntry, handleMonitorEvent };
  `, context, { filename });
  const api = context.module.exports;
  api.registerIpc();
  return { api, calls, handlers, scheduled };
}

test('auto cleanup defaults off and persists enabled state and retention days', async () => {
  const { api, calls, handlers, scheduled } = harness();
  assert.equal(api.loadSettings().autoCleanup, false);
  assert.equal(api.loadSettings().cleanupDays, 7);
  await api.runAutoCleanup();
  assert.equal(calls.scans, 0);
  handlers.get('settings:set')(null, { autoCleanup: true, cleanupDays: 14 });
  assert.equal(calls.saved.autoCleanup, true);
  assert.equal(calls.saved.cleanupDays, 14);
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(calls.trashes, 1);
  assert.equal(calls.dialogs, 0);
  const restarted = harness(calls.saved);
  await restarted.api.runAutoCleanup();
  assert.equal(restarted.calls.trashes, 1);
});

test('cleanup runs while multiple monitors are recording and after each completed recording', async () => {
  const { api, calls, scheduled } = harness({ autoCleanup: true, cleanupDays: 7 });
  api.monitors.set('one', { state: 'recording' });
  api.monitors.set('two', { state: 'recording' });
  await api.runAutoCleanup();
  assert.equal(calls.trashes, 1);
  api.handleMonitorEvent('one', { state: 'checking' });
  assert.equal(scheduled.length, 0);
  api.handleMonitorEvent('one', { state: 'finished' });
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(calls.trashes, 2);
  assert.equal(api.monitors.size, 2);
  assert.equal(api.monitors.get('two').state, 'recording');
  api.handleMonitorEvent('two', { state: 'finished' });
  await scheduled.shift()();
  assert.equal(calls.trashes, 3);
});

test('manual cleanup can confirm while monitoring is running', async () => {
  const { api, calls } = harness();
  api.monitors.set('one', { state: 'recording' });
  const result = await api.cleanupDownloads(7);
  assert.equal(result.canceled, true);
  assert.equal(calls.scans, 1);
  assert.equal(calls.dialogs, 1);
  assert.equal(api.monitors.get('one').state, 'recording');
});

test('manual cleanup still confirms; disabling auto cancels queued checks', async () => {
  const { api, calls, handlers, scheduled } = harness();
  const result = await api.cleanupDownloads(7);
  assert.equal(result.canceled, true);
  assert.equal(calls.dialogs, 1);
  assert.equal(calls.trashes, 0);
  handlers.get('settings:set')(null, { autoCleanup: true });
  handlers.get('settings:set')(null, { autoCleanup: false });
  await scheduled.shift()();
  assert.equal(calls.trashes, 0);
});

test('disabling auto during scan cancels trashing and overlapping runs are skipped', async () => {
  let finishScan;
  const { api, calls } = harness({ autoCleanup: true, cleanupDays: 7 }, {
    scanDownloads: () => new Promise((resolve) => { finishScan = resolve; }),
  });
  const running = api.runAutoCleanup();
  await api.runAutoCleanup();
  api.saveSettings({ autoCleanup: false });
  finishScan({ files: [{}], bytes: 5, errors: [] });
  await running;
  assert.equal(calls.trashes, 0);
});

test('invalid retention and switch values cannot be persisted', () => {
  const { api } = harness();
  assert.throws(() => api.saveSettings({ cleanupDays: 0 }), /整数/);
  assert.throws(() => api.saveSettings({ cleanupDays: 1.5 }), /整数/);
  assert.throws(() => api.saveSettings({ autoCleanup: 'true' }), /布尔/);
  assert.throws(() => api.saveSettings({ directDelete: 'true' }), /布尔/);
});

test('explicit direct delete uses unlink; default continues to use recycle bin', async () => {
  for (const directDelete of [false, true]) {
    const { api, calls } = harness({ autoCleanup: true, cleanupDays: 7, directDelete }, {
      trashDownloads: async (_plan, remove) => {
        await remove('verified-expired-file.flv');
        return { count: 1, bytes: 5, skipped: 0, errors: [] };
      },
    });
    await api.runAutoCleanup();
    assert.equal(calls.unlinks.length, directDelete ? 1 : 0);
    assert.equal(calls.recycled.length, directDelete ? 0 : 1);
  }
});
