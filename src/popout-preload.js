// Bridge for the small toolbar of a tab that lives in its own window.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('popout', {
  platform: process.platform,
  onState: (cb) => ipcRenderer.on('popout:state', (_e, s) => cb(s)),
  back: () => ipcRenderer.send('popout:cmd', 'back'),
  forward: () => ipcRenderer.send('popout:cmd', 'forward'),
  reload: () => ipcRenderer.send('popout:cmd', 'reload'),
  zoomReset: () => ipcRenderer.send('popout:cmd', 'zoom-reset'),
  home: () => ipcRenderer.send('popout:cmd', 'home'),
  go: (text) => ipcRenderer.send('popout:go', String(text || '')),
  ready: () => ipcRenderer.send('popout:cmd', 'ready'),
})
