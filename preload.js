// MacClippy — preload: a small, safe bridge between the service (main) and the animated frontend (renderer).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clippy', {
  // main -> renderer
  onSpeak:    (cb) => ipcRenderer.on('speak', (_e, payload) => cb(payload)),
  onThinking: (cb) => ipcRenderer.on('thinking', (_e, v) => cb(v)),
  onOpenChat: (cb) => ipcRenderer.on('open-chat', () => cb()),
  onSummoned: (cb) => ipcRenderer.on('summoned', () => cb()),
  onWebcamGlance: (cb) => ipcRenderer.on('webcam-glance', (_e, p) => cb(p)),
  onToggleChat: (cb) => ipcRenderer.on('toggle-chat', () => cb()),

  // renderer -> main
  getConfig:      () => ipcRenderer.invoke('get-config'),
  ask:            (q) => ipcRenderer.invoke('ask', q),
  webcamComment:  (b64) => ipcRenderer.invoke('webcam-comment', b64),
  requestSummon:  () => ipcRenderer.send('request-summon'),
  setIgnoreMouse:(ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setChatState:  (open) => ipcRenderer.send('chat-state', open),
  lookNow:       () => ipcRenderer.send('look-now'),
});
