// Exposes a small, safe API to the renderer. No Node access leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibe', {
  list: () => ipcRenderer.invoke('vault:list'),
  chooseFolder: () => ipcRenderer.invoke('vault:choose'),
  read: (p) => ipcRenderer.invoke('note:read', p),
  save: (p, content) => ipcRenderer.invoke('note:save', p, content),
  create: (notebook) => ipcRenderer.invoke('note:create', notebook),
  move: (p, notebook) => ipcRenderer.invoke('note:move', p, notebook),
  trash: (p) => ipcRenderer.invoke('note:trash', p),
  reveal: (p) => ipcRenderer.invoke('note:reveal', p),
  createNotebook: (name) => ipcRenderer.invoke('notebook:create', name),
  flushed: () => ipcRenderer.send('app:flushed'),
  onChanged: (cb) => ipcRenderer.on('vault:changed', () => cb()),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd) => cb(cmd)),
});
