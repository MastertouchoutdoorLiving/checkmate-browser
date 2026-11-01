// Bridge between the browser UI (index.html) and the main process.
const { contextBridge, ipcRenderer } = require('electron')
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action')

// Registers the <browser-action-list> element (extension toolbar icons + popups).
injectBrowserAction()

const on = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

contextBridge.exposeInMainWorld('browser', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('get-state'),
  onState: on('state'),
  onCommand: (cb) => {
    for (const c of ['ui:new-tab', 'ui:new-space', 'ui:focus-address', 'ui:toggle-apps', 'ui:toggle-compact', 'ui:extensions', 'ui:passwords']) {
      ipcRenderer.on(c, () => cb(c))
    }
  },
  setContentBounds: (rect) => ipcRenderer.send('content-bounds', rect),
  setOverlay: (open) => ipcRenderer.send('overlay', open),

  activateSpace: (id) => ipcRenderer.send('space:activate', id),
  addSpace: (data) => ipcRenderer.invoke('space:add', data),
  updateSpace: (id, patch) => ipcRenderer.send('space:update', id, patch),
  moveSpace: (id, delta) => ipcRenderer.send('space:move', id, delta),
  removeSpace: (id) => ipcRenderer.invoke('space:remove', id),

  openApp: (spaceId, appId) => ipcRenderer.send('app:open', spaceId, appId),
  addApp: (spaceId, entry) => ipcRenderer.send('app:add', spaceId, entry),
  updateApp: (spaceId, appId, patch) => ipcRenderer.send('app:update', spaceId, appId, patch),
  moveApp: (spaceId, appId, delta) => ipcRenderer.send('app:move', spaceId, appId, delta),
  reorderApps: (spaceId, ids) => ipcRenderer.send('app:reorder', spaceId, ids),
  reorderSpaces: (ids) => ipcRenderer.send('space:reorder', ids),
  removeApp: (spaceId, appId) => ipcRenderer.send('app:remove', spaceId, appId),

  newTab: (url) => ipcRenderer.send('tab:new', url),
  selectTab: (spaceId, tabId) => ipcRenderer.send('tab:select', spaceId, tabId),
  closeTab: (spaceId, tabId) => ipcRenderer.send('tab:close', spaceId, tabId),
  go: (input) => ipcRenderer.send('nav:go', input),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),

  setSettings: (patch) => ipcRenderer.send('settings:set', patch),
  listPasswords: () => ipcRenderer.invoke('pw:list'),
  removePassword: (id) => ipcRenderer.invoke('pw:remove', id),
  addPassword: (entry) => ipcRenderer.invoke('pw:add', entry),
  importPasswords: () => ipcRenderer.invoke('pw:import'),
  listExtensions: () => ipcRenderer.invoke('ext:list'),
  removeExtension: (id) => ipcRenderer.invoke('ext:remove', id),
  loadUnpacked: () => ipcRenderer.invoke('ext:load-unpacked'),
  updateExtensions: () => ipcRenderer.invoke('ext:update'),
})
