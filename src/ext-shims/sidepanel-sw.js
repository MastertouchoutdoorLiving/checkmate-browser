// MultiSpace Browser: chrome.sidePanel for extension background workers.
// Added by the browser to extensions that use a side panel (Claude, etc.).
;(() => {
  const c = globalThis.chrome
  if (!c) return

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
  const hadWindows = !!c.windows
  addStubs(c, ['alarms', 'contextMenus', 'tabGroups', 'debugger', 'offscreen', 'notifications', 'commands', 'webNavigation', 'declarativeNetRequest', 'identity', 'idle', 'cookies', 'downloads', 'history', 'bookmarks', 'sessions', 'tts', 'power', 'omnibox', 'privacy', 'proxy', 'search', 'topSites', 'fontSettings', 'system', 'windows'])
  if (!hadWindows && c.windows) {
    const w = { id: 1, focused: true, type: 'normal', state: 'normal', incognito: false, alwaysOnTop: false }
    const one = (cb) => { const r = Promise.resolve({ ...w }); if (typeof cb === 'function') r.then(cb); return r }
    try { Object.assign(c.windows, { getCurrent: (o, cb) => one(typeof o === 'function' ? o : cb), getLastFocused: (o, cb) => one(typeof o === 'function' ? o : cb), WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1 }) } catch {}
  }
  if (c.sidePanel) return
  const manifest = (c.runtime && c.runtime.getManifest && c.runtime.getManifest()) || {}
  const behavior = { openPanelOnActionClick: false }
  const opts = {}
  const ping = (op, arg) =>
    fetch('https://multispace-sidepanel.invalid/' + op + '?' + new URLSearchParams({ ext: c.runtime.id, arg: JSON.stringify(arg || {}) }))
      .then(() => undefined, () => undefined)
  const wrap = (fn) => (arg, cb) => {
    if (typeof arg === 'function') (cb = arg), (arg = undefined)
    const p = Promise.resolve(fn(arg))
    if (typeof cb === 'function') p.then((v) => cb(v), () => cb())
    return p
  }
  const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false })
  c.sidePanel = {
    open: wrap((a) => ping('open', a)),
    close: wrap((a) => ping('close', a)),
    setPanelBehavior: wrap((b) => {
      Object.assign(behavior, b || {})
      return ping('setPanelBehavior', b)
    }),
    getPanelBehavior: wrap(() => ({ ...behavior })),
    setOptions: wrap((o) => {
      if (o && !o.tabId) Object.assign(opts, o)
      return ping('setOptions', o)
    }),
    getOptions: wrap(() => ({ path: opts.path || (manifest.side_panel && manifest.side_panel.default_path) || '', enabled: opts.enabled !== false })),
    setLayout: wrap(() => undefined),
    getLayout: wrap(() => ({ side: 'right' })),
    onOpened: ev(),
    onClosed: ev(),
  }
})()
