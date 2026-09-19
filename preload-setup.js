const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  bootstrap: (payload) => ipcRenderer.invoke('setup:bootstrap', payload),
  onProgress: (cb) => ipcRenderer.on('setup:progress', (_e, msg) => cb(msg)),
});
