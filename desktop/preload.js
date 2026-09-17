const { contextBridge, ipcRenderer } = require('electron');

// 渲染层可用的白名单 API：所有能力都走显式命名通道，
// 事件类订阅返回取消函数，避免重复注册。
const EVENTS = [
  'env:changed',
  'login:state',
  'login:log',
  'deps:state',
  'deps:log',
  'monitor:event',
  'monitor:log',
  'monitor:exit',
];

contextBridge.exposeInMainWorld('api', {
  envStatus: () => ipcRenderer.invoke('env:status'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  chooseDownloadDir: () => ipcRenderer.invoke('dialog:chooseDownloadDir'),
  openPath: (target) => ipcRenderer.invoke('app:openPath', target),

  loginStart: () => ipcRenderer.invoke('login:start'),
  loginConfirm: () => ipcRenderer.invoke('login:confirm'),
  loginCancel: () => ipcRenderer.invoke('login:cancel'),
  depsInstall: () => ipcRenderer.invoke('deps:install'),

  linksAdd: (url) => ipcRenderer.invoke('links:add', url),
  linksRemove: (linkId) => ipcRenderer.invoke('links:remove', linkId),

  monitorStart: (linkId) => ipcRenderer.invoke('monitor:start', linkId),
  monitorStop: (linkId) => ipcRenderer.invoke('monitor:stop', linkId),
  monitorStopAll: () => ipcRenderer.invoke('monitor:stopAll'),

  on: (channel, listener) => {
    if (!EVENTS.includes(channel)) return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
