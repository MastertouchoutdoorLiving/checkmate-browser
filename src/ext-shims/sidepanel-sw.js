// MultiSpace Browser: chrome.sidePanel for extension background workers.
// Added by the browser to extensions that use a side panel (Claude, etc.).
;(() => {
  const c = globalThis.chrome
  if (!c || c.sidePanel) return
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
