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
      if (!bridge || !globalThis.chrome || Object.isFrozen(globalThis.chrome)) return

      // Stand-ins for Chrome features this browser doesn't have, so the extension keeps running
      // instead of stopping at the first missing one.
      const evt = () => {
        const ls = new Set()
        return { addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f), hasListener: (f) => ls.has(f), hasListeners: () => ls.size > 0, _fire: (...a) => ls.forEach((f) => { try { f(...a) } catch (e) { console.error(e) } }) }
      }
      const stubNs = (name) =>
        new Proxy({}, {
          get(t, p) {
            if (p in t) return t[p]
            if (typeof p !== 'string' || p === 'then') return undefined
            if (/^on[A-Z]/.test(p)) return (t[p] = evt())
            if (/^[A-Z]/.test(p)) return (t[p] = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k !== 'then' ? k.toLowerCase() : undefined) }))
            return (t[p] = (...a) => {
              const cb = a.find((x) => typeof x === 'function')
              const r = Promise.resolve(p.startsWith('getAll') || p === 'query' || p === 'search' ? [] : undefined)
              if (cb) r.then((v) => cb(v))
              return r
            })
          },
        })
      const addStubs = (c, names) => {
        for (const n of names) {
          if (c[n]) continue
          try {
            c[n] = n === 'alarms' ? makeAlarms() : stubNs(n)
          } catch {}
        }
      }
      function makeAlarms() {
        const timers = new Map()
        const info = new Map()
        const onAlarm = evt()
        const clear = (name = '') => {
          const t = timers.get(name)
          if (t) clearTimeout(t), clearInterval(t)
          timers.delete(name)
          return info.delete(name)
        }
        const cbify = (fn) => (...a) => {
          const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null
          const r = Promise.resolve(fn(...a))
          if (cb) r.then((v) => cb(v))
          return r
        }
        return {
          create: cbify((name, o) => {
            if (typeof name === 'object') (o = name), (name = '')
            o = o || {}
            clear(name)
            const delay = o.when ? Math.max(0, o.when - Date.now()) : (o.delayInMinutes ?? o.periodInMinutes ?? 1) * 60000
            const period = o.periodInMinutes ? o.periodInMinutes * 60000 : 0
            const fire = () => {
              const a = { name, scheduledTime: Date.now(), periodInMinutes: o.periodInMinutes }
              if (!period) info.delete(name), timers.delete(name)
              onAlarm._fire(a)
            }
            info.set(name, { name, scheduledTime: Date.now() + delay, periodInMinutes: o.periodInMinutes })
            timers.set(name, setTimeout(() => {
              fire()
              if (period) timers.set(name, setInterval(fire, period))
            }, delay))
          }),
          get: cbify((name = '') => info.get(name)),
          getAll: cbify(() => [...info.values()]),
          clear: cbify((name = '') => clear(name)),
          clearAll: cbify(() => { [...timers.keys()].forEach(clear); return true }),
          onAlarm,
        }
      }
    
      addStubs(globalThis.chrome, ['alarms', 'tabGroups', 'debugger', 'offscreen', 'identity', 'declarativeNetRequest', 'idle', 'downloads', 'history', 'bookmarks', 'sessions', 'tts', 'power', 'topSites', 'search'])
      if (globalThis.chrome.sidePanel) return
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
