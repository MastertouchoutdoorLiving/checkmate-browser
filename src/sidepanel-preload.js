// Adds chrome.sidePanel for extensions (Claude, Grammarly, etc. open in a panel on the right).
// The extension library doesn't provide it, so we bridge it to the browser window here.
// This runs before the library's own preload, which then keeps it and freezes `chrome`.
const { contextBridge, ipcRenderer } = require('electron')

const isWorker = process.type === 'service-worker'
const isExtPage = !isWorker && typeof location !== 'undefined' && location.href.startsWith('chrome-extension://')
if (isWorker || isExtPage) {
  try {
    const api = {
      call: (extId, op, arg) => ipcRenderer.invoke('ms-sidepanel', String(extId), String(op), arg == null ? null : JSON.parse(JSON.stringify(arg))),
    }
    // Service workers run without context isolation: then this script shares the extension's world.
    if (process.contextIsolated) contextBridge.exposeInMainWorld('__msSidePanel', api)
    else globalThis.__msSidePanel = api
    const inject = () => {
      const bridge = globalThis.__msSidePanel
      try {
        delete globalThis.__msSidePanel
      } catch {}
      if (!bridge || !globalThis.chrome || globalThis.chrome.sidePanel || Object.isFrozen(globalThis.chrome)) return
      const extId = location.host
      const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false })
      const fn = (op) => (arg, cb) => {
        if (typeof arg === 'function') (cb = arg), (arg = null)
        const r = bridge.call(extId, op, arg)
        if (typeof cb === 'function') r.then((v) => cb(v), () => cb())
        return r
      }
      globalThis.chrome.sidePanel = {
        open: fn('open'),
        close: fn('close'),
        setOptions: fn('setOptions'),
        getOptions: fn('getOptions'),
        setPanelBehavior: fn('setPanelBehavior'),
        getPanelBehavior: fn('getPanelBehavior'),
        setLayout: async () => {},
        getLayout: async () => ({ side: 'right' }),
        onOpened: ev(),
        onClosed: ev(),
      }
    }
    if (!process.contextIsolated) inject()
    else if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: inject })
    else require('electron').webFrame.executeJavaScript(`(${inject})()`)
  } catch {}
}
