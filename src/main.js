// MultiSpace Browser: main process.
// Each "space" is an isolated Chromium session (own cookies, logins, storage),
// so you can be signed in to several Google/Slack/etc. accounts at once.
const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  Menu,
  dialog,
  shell,
  clipboard,
  net,
  nativeImage,
  Notification,
  safeStorage,
  nativeTheme,
  ClipboardItem,
} = require('electron')
const { pathToFileURL, fileURLToPath } = require('url')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const jtDownloads = new Map() // id -> { path, name, mime, wcId }: WhatsApp downloads the page may file on JobTread
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const contactParse = require('./imessage/contact-parse.js')
const jobtread = require('./jobtread.js')
const quo = require('./quo.js')
const calendar = require('./calendar.js')
const control = require('./control.js')
let teamExportFn = null, teamImportFn = null
const updater = require('./updater.js')
const {
  installChromeWebStore,
  uninstallExtension,
  updateExtensions,
} = require('electron-chrome-web-store')
const { Store, CATALOG, COLORS } = require('./store')
const { PasswordVault } = require('./passwords')
const imessage = require('./imessage')

// Built-in pages that aren't websites.
const IMESSAGE_URL = 'internal:imessage'
const INBOX_URL = 'internal:unread'
const TASKS_URL = 'internal:tasks'
const TODAY_URL = 'internal:today'
const isInternal = (url) => url === IMESSAGE_URL || url === INBOX_URL || url === TASKS_URL || url === TODAY_URL

// The app is shown as "CheckMate Browser". Its internal name stays "MultiSpace Browser" on purpose:
// that name picks the data folder and the Keychain key, so your logins and passwords carry over.
const DISPLAY_NAME = 'CheckMate Browser'
app.setName('MultiSpace Browser')
app.setAboutPanelOptions({ applicationName: DISPLAY_NAME })
// Hide Chromium's internal log noise (STUN lookups, Bluetooth/passkey probes) from the Terminal.
// Real crashes are still reported.
app.commandLine.appendSwitch('log-level', '3')

let store
let vault
let win
let contentBounds = { x: 0, y: 0, width: 0, height: 0 }
let overlayOpen = false // true while a modal is open in the UI, so the page view is hidden
let nextTabId = 1
const runtimes = new Map() // spaceId -> { session, extensions, tabs: Map, order: [], activeTabId }

const extensionsPath = () => path.join(app.getPath('userData'), 'Extensions')
const exts = (ses) => ses.extensions || ses // Electron 36+ moved extension APIs to session.extensions

// Present as regular Chrome so Google and others don't block sign-in as an "embedded browser".
function chromeUserAgent(ua) {
  return ua
    .replace(/\s?Electron\/[\d.]+/, '')
    .replace(new RegExp(`\\s?${app.getName().replace(/\s/g, '')}\\/[\\d.]+`), '')
    .replace(/\s?multispace-browser\/[\d.]+/i, '')
}

// Google refuses sign-in from browsers it thinks are "embedded apps" ("Couldn't sign you in /
// This browser or app may not be secure"). On Google's sign-in pages only, we present as Firefox,
// which Google accepts, and drop the Chrome-only "client hint" headers that would give it away.
// The same trick is used by other multi-account browsers (Ferdium, Rambox). page-preload.js does
// the matching change inside the page.
function firefoxUserAgent() {
  const version = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5)) // a release every 4 weeks
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
}
const GOOGLE_SIGNIN_URLS = ['*://accounts.google.com/*', '*://accounts.youtube.com/*', '*://myaccount.google.com/*']

function hostOf(url) {
  try {
    return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function normalizeUrl(input) {
  const text = (input || '').trim()
  if (!text) return 'about:blank'
  if (isInternal(text)) return text
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|chrome-extension|file):/i.test(text)) return text
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(text) || /^localhost(:\d+)?/.test(text)) return 'https://' + text
  return 'https://www.google.com/search?q=' + encodeURIComponent(text)
}

// ---------------------------------------------------------------- spaces / sessions

function getRuntime(spaceId) {
  if (runtimes.has(spaceId)) return runtimes.get(spaceId)
  const space = store.getSpace(spaceId)
  if (!space) return null

  const ses = session.fromPartition(`persist:space-${spaceId}`)
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()))
  ses.webRequest.onBeforeSendHeaders({ urls: GOOGLE_SIGNIN_URLS }, (details, callback) => {
    const h = details.requestHeaders
    for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k) || /^user-agent$/i.test(k)) delete h[k]
    h['User-Agent'] = firefoxUserAgent()
    callback({ requestHeaders: h })
  })
  // Turn off passkeys so Google etc. offer password sign-in instead of hanging.
  const pagePreload = { type: 'frame', id: 'multispace-page', filePath: path.join(__dirname, 'page-preload.js') }
  if (ses.registerPreloadScript) ses.registerPreloadScript(pagePreload)
  else ses.setPreloads([...ses.getPreloads(), pagePreload.filePath])
  // chrome.sidePanel for extension pages; must be registered before the extension library's preload.
  if (ses.registerPreloadScript) ses.registerPreloadScript({ type: 'frame', id: 'multispace-sidepanel', filePath: path.join(__dirname, 'sidepanel-preload.js') })
  ses.serviceWorkers.on('console-message', (_e, d) => {
    if (String(d.sourceUrl || '').startsWith('chrome-extension://')) logExt('worker ' + (d.level ?? ''), `${d.message} (${String(d.sourceUrl).split('/').pop()}:${d.lineNumber})`)
  })
  // Background workers reach the browser through a dummy address (see ext-shims/sidepanel-sw.js).
  ses.webRequest.onBeforeRequest({ urls: ['https://multispace-sidepanel.invalid/*'] }, (details, callback) => {
    try {
      const u = new URL(details.url)
      const extId = u.searchParams.get('ext') || ''
      const from = String(details.initiator || details.referrer || '')
      if (/^[a-p]{32}$/.test(extId) && (!from || from.startsWith(`chrome-extension://${extId}`))) {
        sidePanelOp(spaceId, extId, u.pathname.slice(1), JSON.parse(u.searchParams.get('arg') || '{}')).catch(() => {})
      }
    } catch {}
    callback({ cancel: true })
  })

  const rt = { spaceId, session: ses, tabs: new Map(), order: [], activeTabId: null, restored: false, sidePanel: new Map() }
  runtimes.set(spaceId, rt)

  // Full chrome.* extension API support (tabs, action popups, context menus, etc.)
  rt.extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: async (details) => {
      const tab = createTab(spaceId, { url: details.url || 'about:blank', select: details.active !== false })
      return [tab.view.webContents, win]
    },
    selectTab: (wc) => {
      const tab = findTabByWebContents(wc)
      if (tab && !rt.restoring) selectTab(tab.spaceId, tab.id)
    },
    removeTab: (wc) => {
      const tab = findTabByWebContents(wc)
      if (tab) closeTab(tab.spaceId, tab.id)
    },
    createWindow: async (details) => {
      const urls = [].concat(details.url || 'about:blank')
      urls.forEach((u) => createTab(spaceId, { url: u }))
      return win
    },
    requestPermissions: async () => true,
  })

  rt.extensions.on('browser-action-popup-created', () => {})

  // Extensions that live in a side panel (like Claude) open it when you click their icon.
  try {
    const ba = rt.extensions.api.browserAction
    const origClick = ba.activateClick.bind(ba)
    ba.activateClick = (details) => {
      try {
        const cfg = sidePanelConfig(spaceId, details.extensionId)
        const at = ba.ctx.store.getActiveTabOfCurrentWindow()
        const popup = at && ba.getPopupUrl(details.extensionId, at.id)
        if ((cfg.path || isClaudeExtension(cfg.ext)) && !popup) return toggleSidePanel(spaceId, details.extensionId)
      } catch (err) {
        console.error('side panel:', err)
      }
      return origClick(details)
    }
  } catch (err) {
    console.error('side panel hook failed:', err)
  }

  // Chrome Web Store: lets you click "Add to Chrome" on chromewebstore.google.com.
  // Extensions live in one shared folder and are loaded into every space.
  patchAllSidePanelExtensions()
  rt.ready = installChromeWebStore({
    session: ses,
    extensionsPath: extensionsPath(),
    allowUnpackedExtensions: true,
    autoUpdate: true,
  })
    .then(() => loadUnpacked(ses))
    .catch((err) => console.error('[webstore]', err))

  // When an extension is installed in one space, load it into the other open spaces too.
  exts(ses).on('extension-loaded', (_e, ext) => {
    // Extensions with a side panel get a small helper in their background worker; reload once if we just added it.
    if (patchSidePanelExtension(ext.path)) {
      exts(ses).removeExtension(ext.id)
      exts(ses).loadExtension(ext.path, { allowFileAccess: true }).catch(() => {})
      return
    }
    for (const other of runtimes.values()) {
      if (other === rt) continue
      const o = exts(other.session)
      if (!o.getExtension(ext.id)) o.loadExtension(ext.path, { allowFileAccess: true }).catch(() => {})
    }
    pushState()
  })
  exts(ses).on('extension-unloaded', () => pushState())

  ses.on('will-download', (_e, item, wc) => {
    // Use the default Chrome-like behaviour: ask where to save.
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return
      // A document saved from WhatsApp: offer to file it on the chat's JobTread job too.
      let fromWa = false
      try { fromWa = !!wc && !wc.isDestroyed() && hostOf(wc.getURL()) === 'web.whatsapp.com' } catch {}
      if (fromWa && jtKey()) {
        const id = crypto.randomBytes(8).toString('hex')
        const name = path.basename(item.getSavePath())
        jtDownloads.set(id, { path: item.getSavePath(), name, mime: item.getMimeType() || 'application/octet-stream', wcId: wc.id })
        if (jtDownloads.size > 30) jtDownloads.delete(jtDownloads.keys().next().value)
        wc.send('jt:downloaded', { id, name, mime: item.getMimeType() || '' })
        return
      }
      shell.showItemInFolder(item.getSavePath())
    })
  })

  return rt
}

// ---------------------------------------------------------------- side panel helper for extension workers
// File names must not start with "_" (Chrome reserves those and refuses to load the extension).
const SP_SHIM = 'multispace-sidepanel.js'
const SP_WRAPPER = 'multispace-background.js'
const OLD_SHIM = '__multispace_sidepanel.js'
const OLD_WRAPPER = '__multispace_background.js'
function patchSidePanelExtension(dir) {
  // Only extensions installed from the Chrome Web Store (never your own unpacked folders).
  if (!path.resolve(dir).startsWith(path.resolve(extensionsPath()) + path.sep)) return false
  try {
    const mf = path.join(dir, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
    let bg = m.background && m.background.service_worker
    let changed = false
    // Undo the first version of this patch (its "__" file names stopped the extension from loading).
    if (bg === OLD_WRAPPER) {
      const old = fs.readFileSync(path.join(dir, OLD_WRAPPER), 'utf8')
      const orig = [...old.matchAll(/['"]\.?\/?([^'"]+)['"]/g)].map((x) => x[1]).find((f) => f !== OLD_SHIM && f !== SP_SHIM)
      if (orig) {
        m.background.service_worker = bg = orig
        fs.writeFileSync(mf, JSON.stringify(m, null, 2))
        changed = true
      }
    }
    for (const f of [OLD_SHIM, OLD_WRAPPER]) {
      try {
        fs.unlinkSync(path.join(dir, f))
        changed = true
      } catch {}
    }
    const usesPanel = m.side_panel || (m.permissions || []).includes('sidePanel')
    if (m.manifest_version !== 3 || !usesPanel || !bg) return false
    const shim = fs.readFileSync(path.join(__dirname, 'ext-shims', 'sidepanel-sw.js'), 'utf8')
    const shimPath = path.join(dir, SP_SHIM)
    if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== shim) {
      fs.writeFileSync(shimPath, shim)
      changed = true
    }
    if (bg !== SP_WRAPPER) {
      const orig = String(bg).replace(/^\//, '')
      const wrapper =
        m.background.type === 'module'
          ? `import './${SP_SHIM}'\nimport './${orig.replace(/'/g, "\\'")}'\n`
          : `importScripts('/${SP_SHIM}', '/${orig.replace(/'/g, "\\'")}')\n`
      fs.writeFileSync(path.join(dir, SP_WRAPPER), wrapper)
      m.background.service_worker = SP_WRAPPER
      fs.writeFileSync(mf, JSON.stringify(m, null, 2))
      changed = true
    }
    return changed
  } catch (err) {
    console.error('[side panel patch]', dir, err.message)
    return false
  }
}
function patchAllSidePanelExtensions() {
  const dirs = []
  const walk = (d, depth) => {
    if (depth > 2) return
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(d, e.name)
      if (fs.existsSync(path.join(p, 'manifest.json'))) dirs.push(p)
      else walk(p, depth + 1)
    }
  }
  walk(extensionsPath(), 0)
  dirs.forEach((d) => patchSidePanelExtension(d))
}

function loadUnpacked(ses) {
  const list = store.state.settings.unpacked || []
  return Promise.all(
    list.map((dir) =>
      exts(ses).getAllExtensions().some((e) => e.path === dir)
        ? null
        : exts(ses).loadExtension(dir, { allowFileAccess: true }).catch((err) => console.error('[unpacked]', dir, err.message))
    )
  )
}

function restoreTabs(spaceId) {
  const rt = getRuntime(spaceId)
  if (!rt || rt.restored) return
  rt.restored = true
  rt.restoring = true
  const space = store.getSpace(spaceId)
  const saved = space.tabs || []
  const active = saved.find((t) => t.active) || saved[0]
  saved.forEach((t) => {
    if (t.appId && !space.apps.find((a) => a.id === t.appId)) return
    // Memory saver: only the tab you were on (and apps that must stay live) load at startup.
    const sleep = memorySaverOn() && t !== active && !keepAwakeUrl(normalizeUrl(t.url))
    createTab(spaceId, { url: t.url, appId: t.appId, select: false, persist: false, sleep })
  })
  rt.restoring = false
  const activeTab = active && [...rt.tabs.values()].find((t) => t.url === active.url)
  if (activeTab) rt.activeTabId = activeTab.id
  else if (rt.order.length) rt.activeTabId = rt.order[0]
  else if (space.apps[0]) openApp(spaceId, space.apps[0].id)
}

function persistTabs(spaceId) {
  const rt = runtimes.get(spaceId)
  if (!rt) return
  store.setTabs(
    spaceId,
    rt.order.map((id) => {
      const t = rt.tabs.get(id)
      return { url: t.url, appId: t.appId || null, active: id === rt.activeTabId }
    })
  )
}

function activateSpace(spaceId) {
  if (!store.getSpace(spaceId)) return
  store.state.activeSpaceId = spaceId
  store.save()
  restoreTabs(spaceId)
  const rt = runtimes.get(spaceId)
  const tab = rt && rt.tabs.get(rt.activeTabId)
  wakeTab(tab)
  layoutViews()
  if (tab && !tab.internal) rt.extensions.selectTab(tab.view.webContents)
  pushState()
}

// ---------------------------------------------------------------- tabs

function findTabByWebContents(wc) {
  for (const rt of runtimes.values()) {
    for (const tab of rt.tabs.values()) if (tab.view.webContents === wc) return tab
  }
  return null
}

function createTab(spaceId, { url, appId = null, select = true, persist = true, sleep = false } = {}) {
  const rt = getRuntime(spaceId)
  const internal = isInternal(normalizeUrl(url))
  const view = new WebContentsView({
    webPreferences: internal
      ? {
          // Built-in pages (iMessage, Unread): their own session, no extensions, only the built-in bridge.
          partition: 'internal-pages',
          preload: path.join(__dirname, 'imessage', 'preload.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        }
      : {
          session: rt.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          scrollBounce: true,
        },
  })
  const tab = {
    id: nextTabId++,
    spaceId,
    appId,
    view,
    url: normalizeUrl(url),
    title: (store.getSpace(spaceId)?.apps.find((a) => a.id === appId) || {}).name || hostOf(url) || 'New Tab',
    favicon: null,
    badge: 0,
    loading: false,
    internal,
    sleeping: !!sleep && !internal,
    lastActive: Date.now(),
  }
  rt.tabs.set(tab.id, tab)
  rt.order.push(tab.id)
  if (!internal) rt.extensions.addTab(view.webContents, win)
  wireTab(tab)
  win.contentView.addChildView(view)
  view.setVisible(false)

  if (internal) view.webContents.loadFile(path.join(__dirname, tab.url === INBOX_URL ? 'inbox' : tab.url === TASKS_URL ? 'tasks' : tab.url === TODAY_URL ? 'today' : 'imessage', 'index.html')).catch(() => {})
  else if (tab.sleeping) {} // loads when you click it
  // Wait until the space's extensions are loaded so content scripts run on the first page.
  else Promise.resolve(rt.ready).finally(() => view.webContents.loadURL(tab.url).catch(() => {}))

  if (select) selectTab(spaceId, tab.id)
  else layoutViews()
  if (persist) persistTabs(spaceId)
  pushState()
  return tab
}

function wireTab(tab) {
  const wc = tab.view.webContents
  const update = () => {
    pushState()
    persistTabs(tab.spaceId)
  }

  wc.on('did-start-loading', () => {
    if (tab.sleeping) return
    tab.loading = true
    pushState()
  })
  wc.on('did-stop-loading', () => {
    if (tab.sleeping) return
    tab.loading = false
    pushState()
  })
  // If a page's process crashes or runs out of memory, bring it back instead of leaving a dead tab.
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000)
  })
  wc.on('zoom-changed', () => setTimeout(pushState, 50))
  wc.on('did-finish-load', () => pushState())
  wc.on('did-navigate', (_e, url) => {
    if (tab.sleeping) return
    if (tab.internal) return
    tab.url = url
    update()
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (tab.sleeping) return
    if (isMainFrame && !tab.internal) {
      tab.url = url
      update()
    }
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (tab.sleeping) return
    if (!isMainFrame || code === -3) return // -3 = aborted (normal during redirects)
    tab.title = `Can't reach ${hostOf(url) || 'page'}`
    pushState()
  })
  wc.on('page-title-updated', (_e, title) => {
    if (tab.sleeping) return
    tab.title = title
    tab.badge = parseBadge(title)
    pushState()
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (tab.sleeping) return
    tab.favicon = favicons[0] || null
    // Remember the site's real icon for the apps list (Google's icon service misses many web apps).
    if (tab.appId && tab.favicon && !tab.favicon.startsWith('data:') && tab.favicon.length < 500) {
      const a = store.getSpace(tab.spaceId)?.apps.find((x) => x.id === tab.appId)
      if (a && a.icon !== tab.favicon) store.updateApp(tab.spaceId, tab.appId, { icon: tab.favicon })
    }
    pushState()
  })

  // Links with target=_blank open as new tabs in the same space. Real popups (OAuth sign-in
  // windows, etc.) stay popups so the opener relationship keeps working.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (tab.internal) return { action: 'deny' }
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, parent: win },
      }
    }
    createTab(tab.spaceId, { url, select: disposition !== 'background-tab' })
    return { action: 'deny' }
  })

  wc.on('context-menu', (_e, params) => showContextMenu(tab, params))

  // Notifications and other permissions: allow the usual web-app ones.
}

// "Inbox (3) - you@gmail.com" -> 3, "(12) Slack" -> 12, "* Slack" -> dot
function parseBadge(title) {
  const m = /\((\d+)\+?\)/.exec(title || '')
  if (m) return parseInt(m[1], 10)
  if (/^[*•]\s/.test(title || '')) return -1 // unread, no count
  return 0
}

// ---------------------------------------------------------------- tabs in their own window
// "Move to New Window" (or dragging a tab out of the strip) gives one tab its own window with a small
// toolbar. The tab stays in the same space and keeps its logins. Closing that window, or "Back to main
// window", puts the tab back in the main window, so nothing is lost.
const POPOUT_BAR = 44
function popoutTab(spaceId, tabId, at) {
  const rt = runtimes.get(spaceId)
  const tab = rt && rt.tabs.get(tabId)
  if (!tab || tab.popout || !win || win.isDestroyed()) return
  const b = win.getBounds()
  const pw = new BrowserWindow({
    icon: path.join(__dirname, 'ui', 'icon.png'),
    width: 1100,
    height: 800,
    minWidth: 520,
    minHeight: 360,
    x: at && Number.isFinite(at.x) ? Math.round(at.x - 120) : b.x + 40,
    y: at && Number.isFinite(at.y) ? Math.round(at.y - 20) : b.y + 40,
    title: tab.title || DISPLAY_NAME,
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'popout-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  pw.spaceId = spaceId
  pw.tabId = tabId
  tab.popout = pw
  // Main window shows the neighbouring tab instead.
  try { win.contentView.removeChildView(tab.view) } catch {}
  pw.contentView.addChildView(tab.view)
  const fit = () => {
    if (pw.isDestroyed()) return
    const [w, h] = pw.getContentSize()
    tab.view.setBounds({ x: 0, y: POPOUT_BAR, width: w, height: Math.max(0, h - POPOUT_BAR) })
    tab.view.setVisible(true)
  }
  pw.on('resize', fit)
  pw.on('enter-full-screen', fit)
  pw.on('leave-full-screen', fit)
  pw.once('ready-to-show', () => { fit(); pw.show() })
  pw.on('close', () => returnTab(tab))
  pw.loadFile(path.join(__dirname, 'ui', 'popout.html')).catch(() => {})
  if (rt.activeTabId === tabId) {
    const next = rt.order.map((id) => rt.tabs.get(id)).find((t) => t && !t.popout)
    rt.activeTabId = next ? next.id : null
    if (next && !next.internal) rt.extensions.selectTab(next.view.webContents)
  }
  layoutViews()
  persistTabs(spaceId)
  pushState()
}

function returnTab(tab) {
  const pw = tab.popout
  if (!pw) return
  tab.popout = null
  try { pw.contentView.removeChildView(tab.view) } catch {}
  if (quitting || !win || win.isDestroyed()) return
  win.contentView.addChildView(tab.view)
  tab.view.setVisible(false)
  if (pw && !pw.isDestroyed()) setTimeout(() => !pw.isDestroyed() && pw.destroy(), 0)
  selectTab(tab.spaceId, tab.id)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function popoutState(tab) {
  const wc = tab.view.webContents
  return {
    url: tab.url,
    title: tab.title,
    loading: !!tab.loading,
    canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    zoom: Math.round(100 * Math.pow(1.2, wc.getZoomLevel())),
  }
}
function pushPopouts() {
  for (const rt of runtimes.values()) {
    for (const tab of rt.tabs.values()) {
      if (!tab.popout || tab.popout.isDestroyed() || tab.view.webContents.isDestroyed()) continue
      tab.popout.setTitle(tab.title || DISPLAY_NAME)
      tab.popout.webContents.send('popout:state', popoutState(tab))
    }
  }
}
function popoutFromEvent(e) {
  const pw = BrowserWindow.fromWebContents(e.sender)
  const rt = pw && runtimes.get(pw.spaceId)
  return rt && rt.tabs.get(pw.tabId)
}

function selectTab(spaceId, tabId) {
  const rt = runtimes.get(spaceId)
  if (!rt || !rt.tabs.has(tabId)) return
  const target = rt.tabs.get(tabId)
  if (target.popout) {
    if (!target.popout.isDestroyed()) { if (target.popout.isMinimized()) target.popout.restore(); target.popout.show(); target.popout.focus() }
    return
  }
  const prev = rt.tabs.get(rt.activeTabId)
  if (prev) prev.lastActive = Date.now()
  rt.activeTabId = tabId
  wakeTab(rt.tabs.get(tabId))
  if (store.state.activeSpaceId !== spaceId) {
    store.state.activeSpaceId = spaceId
    store.save()
  }
  if (!rt.tabs.get(tabId).internal) rt.extensions.selectTab(rt.tabs.get(tabId).view.webContents)
  layoutViews()
  persistTabs(spaceId)
  pushState()
}

function closeTab(spaceId, tabId) {
  const rt = runtimes.get(spaceId)
  if (!rt || !rt.tabs.has(tabId)) return
  const tab = rt.tabs.get(tabId)
  const idx = rt.order.indexOf(tabId)
  rt.order.splice(idx, 1)
  rt.tabs.delete(tabId)
  if (tab.popout) {
    const pw = tab.popout
    tab.popout = null
    pw.removeAllListeners('close')
    try { pw.contentView.removeChildView(tab.view) } catch {}
    if (!pw.isDestroyed()) pw.destroy()
  } else win.contentView.removeChildView(tab.view)
  tab.view.webContents.close()
  if (rt.activeTabId === tabId) {
    rt.activeTabId = rt.order[Math.min(idx, rt.order.length - 1)] ?? null
    if (rt.activeTabId && !rt.tabs.get(rt.activeTabId).internal) rt.extensions.selectTab(rt.tabs.get(rt.activeTabId).view.webContents)
  }
  layoutViews()
  persistTabs(spaceId)
  pushState()
}

function openApp(spaceId, appId) {
  const space = store.getSpace(spaceId)
  const appEntry = space && space.apps.find((a) => a.id === appId)
  if (!appEntry) return
  const rt = getRuntime(spaceId)
  if (store.state.activeSpaceId !== spaceId) activateSpace(spaceId)
  const existing = [...rt.tabs.values()].find((t) => t.appId === appId)
  if (!existing) return createTab(spaceId, { url: appEntry.url, appId })
  // Clicking the app you're already on takes you back to its start page (like a Home button).
  if (rt.activeTabId === existing.id && existing.url !== appEntry.url) {
    existing.view.webContents.loadURL(appEntry.url).catch(() => {})
  }
  selectTab(spaceId, existing.id)
}

function activeTab() {
  const rt = runtimes.get(store.state.activeSpaceId)
  return rt ? rt.tabs.get(rt.activeTabId) : null
}

// ---------------------------------------------------------------- memory saver
// Apps you haven't looked at for a while are put to sleep (their page is unloaded, freeing memory).
// Clicking one wakes it up again. WhatsApp, Gmail, Quo and the built-in pages always stay awake,
// so unread counts and notifications keep working.
const SLEEP_AFTER_MS = Number(process.env.MULTISPACE_TEST_SLEEP_MS) || 30 * 60 * 1000
const memorySaverOn = () => store.state.settings.memorySaver !== false
function keepAwakeUrl(url) {
  if (isInternal(url)) return true
  const h = hostOf(url)
  return h === 'web.whatsapp.com' || h === 'mail.google.com' || /(^|\.)quo\.com$/.test(h) || /(^|\.)openphone\.com$/.test(h)
}
function sleepTab(tab) {
  if (!tab || tab.sleeping || tab.internal || keepAwakeUrl(tab.url)) return
  const wc = tab.view.webContents
  if (wc.isDestroyed() || wc.isCurrentlyAudible()) return
  tab.sleeping = true
  tab.loading = false
  wc.loadURL('about:blank').catch(() => {})
}
function wakeTab(tab) {
  if (!tab || !tab.sleeping) return
  tab.sleeping = false
  tab.lastActive = Date.now()
  const rt = runtimes.get(tab.spaceId)
  Promise.resolve(rt && rt.ready).finally(() => !tab.view.webContents.isDestroyed() && tab.view.webContents.loadURL(tab.url).catch(() => {}))
}
setInterval(() => {
  if (!memorySaverOn()) return
  const now = Date.now()
  for (const rt of runtimes.values()) {
    const showing = rt.spaceId === store.state.activeSpaceId ? rt.activeTabId : null
    for (const t of rt.tabs.values()) {
      if (t.id === rt.activeTabId) t.lastActive = rt.spaceId === store.state.activeSpaceId ? now : t.lastActive
      if (t.id === showing || t.popout) continue
      if (now - (t.lastActive || now) > SLEEP_AFTER_MS) sleepTab(t)
    }
  }
}, process.env.MULTISPACE_TEST_SLEEP_MS ? 2000 : 60 * 1000)

// ---------------------------------------------------------------- extension side panel
const SIDE_PANEL_WIDTH = 420
const extLog = [] // recent extension messages, for "Copy Extension Error Log"
function logExt(where, msg) {
  const line = `${new Date().toISOString().slice(11, 19)} [${where}] ${String(msg).slice(0, 1500)}`
  extLog.push(line)
  if (extLog.length > 400) extLog.splice(0, extLog.length - 400)
}
let sidePanel = null // { view, spaceId, extId }

function sidePanelConfig(spaceId, extId) {
  const rt = getRuntime(spaceId)
  const ext = rt.session.extensions ? rt.session.extensions.getExtension(extId) : rt.session.getExtension(extId)
  const saved = rt.sidePanel.get(extId) || {}
  const m = (ext && ext.manifest) || {}
  let p = saved.path || (m.side_panel && m.side_panel.default_path) || ''
  // Extensions that set their panel page from code: look for the usual file names.
  if (!p && ext && (m.permissions || []).includes('sidePanel')) {
    const guesses = ['sidepanel.html', 'side_panel.html', 'side-panel.html', 'sidepanel/index.html', 'side_panel/index.html', 'sidePanel.html', 'panel.html', 'src/sidepanel/index.html', 'pages/sidepanel.html']
    p = guesses.find((g) => fs.existsSync(path.join(ext.path, g))) || ''
    if (!p) {
      try {
        p = fs.readdirSync(ext.path).find((f) => /side.?panel.*\.html$/i.test(f)) || ''
      } catch {}
    }
  }
  return { path: p, openOnClick: saved.openOnClick, enabled: saved.enabled !== false, ext }
}

function closeSidePanel() {
  if (!sidePanel) return
  const { view } = sidePanel
  sidePanel = null
  try {
    win.contentView.removeChildView(view)
    view.webContents.close()
  } catch {}
  layoutViews()
}

// The Claude extension's own panel can't sign in inside this browser, so its icon opens
// claude.ai itself in the panel: full login and chat, next to whatever page you're on.
const CLAUDE_EXT_IDS = new Set(['fcoeoabgfenejglbffodgkkbkcdhcgfn'])
const CLAUDE_WEB = 'https://claude.ai/new'
const isClaudeExtension = (ext) => !!ext && (CLAUDE_EXT_IDS.has(ext.id) || /\bclaude\b/i.test(ext.name || ''))

function openSidePanel(spaceId, extId) {
  const cfg = sidePanelConfig(spaceId, extId)
  const webUrl = isClaudeExtension(cfg.ext) ? CLAUDE_WEB : null
  if ((!cfg.path && !webUrl) || !win) return false
  if (sidePanel && sidePanel.spaceId === spaceId && sidePanel.extId === extId) return true
  closeSidePanel()
  const rt = getRuntime(spaceId)
  const view = new WebContentsView({ webPreferences: { session: rt.session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  sidePanel = { view, spaceId, extId }
  win.contentView.addChildView(view)
  // Links the panel opens go to a normal tab.
  view.webContents.setWindowOpenHandler(({ url }) => {
    // sign-in pop-ups (Google, Apple) stay as small windows so the login can finish
    if (/^https:\/\/(accounts\.google\.com|appleid\.apple\.com)\//.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, parent: win, autoHideMenuBar: true } }
    }
    createTab(spaceId, { url })
    return { action: 'deny' }
  })
  const pwc = view.webContents
  pwc.on('console-message', (e) => logExt('panel ' + (e.level || ''), `${e.message} (${String(e.sourceId || '').split('/').pop()}:${e.lineNumber})`))
  pwc.on('did-fail-load', (_e, code, desc, url) => logExt('panel', `load failed ${code} ${desc} ${url}`))
  pwc.on('preload-error', (_e, p, err) => logExt('panel', `preload ${path.basename(p)}: ${err && err.message}`))
  pwc.on('render-process-gone', (_e, d) => logExt('panel', `crashed: ${d.reason}`))
  logExt('panel', `open ${extId} ${webUrl || cfg.path}`)
  view.webContents.loadURL(webUrl || `chrome-extension://${extId}/${cfg.path.replace(/^\//, '')}`).catch(() => {})
  layoutViews()
  return true
}

function toggleSidePanel(spaceId, extId) {
  if (sidePanel && sidePanel.spaceId === spaceId && sidePanel.extId === extId) closeSidePanel()
  else openSidePanel(spaceId, extId)
}

async function sidePanelOp(spaceId, extId, op, arg) {
  const rt = getRuntime(spaceId)
  const saved = rt.sidePanel.get(extId) || {}
  arg = arg || {}
  switch (op) {
    case 'open':
      openSidePanel(store.state.activeSpaceId === spaceId ? spaceId : spaceId, extId)
      return
    case 'close':
      if (sidePanel && sidePanel.extId === extId) closeSidePanel()
      return
    case 'setOptions':
      if (!arg.tabId) {
        if (typeof arg.path === 'string') saved.path = arg.path
        if (typeof arg.enabled === 'boolean') saved.enabled = arg.enabled
      }
      rt.sidePanel.set(extId, saved)
      return
    case 'getOptions': {
      const cfg = sidePanelConfig(spaceId, extId)
      return { path: cfg.path, enabled: cfg.enabled }
    }
    case 'setPanelBehavior':
      if (typeof arg.openPanelOnActionClick === 'boolean') saved.openOnClick = arg.openPanelOnActionClick
      rt.sidePanel.set(extId, saved)
      return
    case 'getPanelBehavior':
      return { openPanelOnActionClick: saved.openOnClick === true }
  }
}

function layoutViews() {
  if (!win) return
  const active = activeTab()
  const panelShown = !!sidePanel && sidePanel.spaceId === store.state.activeSpaceId && !overlayOpen
  const panelW = Math.min(SIDE_PANEL_WIDTH, Math.round(contentBounds.width * 0.5))
  if (sidePanel) {
    if (panelShown) sidePanel.view.setBounds({ x: contentBounds.x + contentBounds.width - panelW, y: contentBounds.y, width: panelW, height: contentBounds.height })
    sidePanel.view.setVisible(panelShown)
  }
  for (const rt of runtimes.values()) {
    for (const tab of rt.tabs.values()) {
      if (tab.popout) continue // lives in its own window
      const show = tab === active && !overlayOpen
      if (show) tab.view.setBounds(panelShown ? { ...contentBounds, width: Math.max(0, contentBounds.width - panelW) } : contentBounds)
      tab.view.setVisible(show)
    }
  }
}

// ---------------------------------------------------------------- UI state

function snapshot() {
  const s = store.state
  return {
    activeSpaceId: s.activeSpaceId,
    settings: s.settings,
    catalog: CATALOG.filter((c) => c.url !== IMESSAGE_URL || process.platform === 'darwin' || process.env.MULTISPACE_TEST_CHATDB),
    colors: COLORS,
    spaces: s.spaces.map((space) => {
      const rt = runtimes.get(space.id)
      const tabs = rt
        ? rt.order.map((id) => {
            const t = rt.tabs.get(id)
            const wc = t.view.webContents
            return {
              id: t.id,
              webContentsId: wc.id,
              appId: t.appId,
              title: t.title,
              url: t.url,
              favicon: t.favicon,
              badge: t.badge,
              loading: t.loading,
              zoom: Math.round(100 * Math.pow(1.2, wc.getZoomLevel())),
              popout: !!t.popout,
              canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
              canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
            }
          })
        : []
      const unread = tabs.filter((t) => t.url !== INBOX_URL).reduce((n, t) => n + Math.max(0, t.badge), 0)
      return {
        id: space.id,
        name: space.name,
        color: space.color,
        partition: `persist:space-${space.id}`,
        apps: space.apps,
        tabs,
        activeTabId: rt ? rt.activeTabId : null,
        unread,
        hasDot: tabs.some((t) => t.badge === -1),
      }
    }),
  }
}

let pushTimer
function pushState() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot())
    pushPopouts()
    updateBadgeCount()
  }, 16)
}

function updateBadgeCount() {
  const total = [...runtimes.values()].reduce(
    (n, rt) => n + [...rt.tabs.values()].reduce((m, t) => m + Math.max(0, t.badge), 0),
    0
  )
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(total)
}

// ---------------------------------------------------------------- IPC from the UI

function registerIpc() {
  // ---- iMessage (only the built-in iMessage page may call these)
  const imsgOnly = (fn) => async (e, ...args) => {
    const tab = findTabByWebContents(e.sender)
    if (!tab || !tab.internal) throw new Error('Not allowed')
    return fn(...args)
  }
  ipcMain.handle('imsg:status', imsgOnly(async () => ({ ...(await imessage.status()), packaged: app.isPackaged })))
  ipcMain.handle('imsg:chats', imsgOnly(() => imessage.listChats()))
  ipcMain.handle('imsg:messages', imsgOnly((id) => imessage.listMessages(id)))
  ipcMain.handle('imsg:send-chat', imsgOnly((guid, text) => imessage.sendToChat(String(guid), String(text))))
  ipcMain.handle('imsg:send-file', imsgOnly((target, name, bytes) => imessage.sendFile(target, name, bytes)))
  ipcMain.handle('imsg:contacts', imsgOnly(() => imessage.searchContacts()))
  // Pictures/files on the clipboard, read by the browser itself (covers Finder copies and
  // screenshots that the page's own paste event doesn't expose).
  ipcMain.handle('imsg:clipboard-files', imsgOnly(() => readClipboardFiles()))
  ipcMain.handle('imsg:add-contact', imsgOnly((c) => imessage.addContact(c || {})))
  // "Save contact" button on WhatsApp Web (see page-preload.js).
  const waOnly = (fn) => async (e, ...args) => {
    let h = ''
    try {
      h = new URL(e.senderFrame ? e.senderFrame.url : e.sender.getURL()).hostname
    } catch {}
    if (h !== 'web.whatsapp.com' || (e.senderFrame && e.senderFrame.parent)) throw new Error('Not allowed')
    return fn(...args)
  }
  ipcMain.handle('wa:parse-contact', waOnly((texts) => contactParse.fromMessages((Array.isArray(texts) ? texts : []).slice(0, 300).map((t) => String(t).slice(0, 5000)))))
  ipcMain.handle(
    'wa:add-contact',
    waOnly((c) => {
      if (process.platform !== 'darwin' && !process.env.MULTISPACE_TEST_CHATDB) throw new Error('Saving to Contacts works on a Mac only.')
      return imessage.addContact(c || {})
    })
  )
  ipcMain.handle('imsg:alerts', imsgOnly(() => imsgAlerts()))
  ipcMain.handle('imsg:set-alerts', imsgOnly((p) => {
    const patch = {}
    if (p && typeof p.sound === 'boolean') patch.sound = p.sound
    if (p && typeof p.banner === 'boolean') patch.banner = p.banner
    setImsgAlerts(patch)
    if (patch.sound) playAlertSound()
    return imsgAlerts()
  }))
  ipcMain.on('imsg:viewing', (e, guid) => {
    const tab = findTabByWebContents(e.sender)
    if (tab && tab.internal) imsgOpenChat = guid ? String(guid) : null
  })
  ipcMain.handle('timers:list', (e) => (qrAllowed(e) ? timersState() : { reminders: [], scheduled: [] }))
  ipcMain.handle('timers:remind', (e, r) => {
    if (!qrAllowed(e) || !r) throw new Error('Not allowed')
    const at = Number(r.at)
    if (!(at > Date.now() - 60000)) throw new Error('Pick a time in the future.')
    const kind = r.kind === 'wa' ? 'wa' : 'imsg'
    const item = { id: newId(), kind, at, title: String(r.title || '').slice(0, 120), note: String(r.note || '').slice(0, 200), ...(kind === 'wa' ? { name: String(r.name || '').slice(0, 120) } : { guid: String(r.guid || '') }) }
    reminders().push(item)
    store.save()
    notifyPages('timers:changed', timersState())
    return timersState()
  })
  ipcMain.handle('timers:schedule', (e, m) => {
    const tab = findTabByWebContents(e.sender)
    if (!tab || !tab.internal || !m) throw new Error('Not allowed')
    const at = Number(m.at)
    if (!(at > Date.now())) throw new Error('Pick a time in the future.')
    const text = String(m.text || '').slice(0, 5000)
    if (!text.trim()) throw new Error('Write the message first.')
    scheduled().push({ id: newId(), at, text, title: String(m.title || '').slice(0, 120), ...(m.guid ? { guid: String(m.guid) } : { handle: String(m.handle || '') }) })
    store.save()
    notifyPages('timers:changed', timersState())
    return timersState()
  })
  ipcMain.handle('timers:cancel', (e, id) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    store.state.settings.reminders = reminders().filter((r) => r.id !== id)
    store.state.settings.scheduled = scheduled().filter((m) => m.id !== id)
    store.save()
    notifyPages('timers:changed', timersState())
    return timersState()
  })
  // To-dos for the Tasks dashboard
  ipcMain.handle('todos:list', (e) => (qrAllowed(e) ? todos() : []))
  ipcMain.handle('todos:add', (e, t) => {
    if (!qrAllowed(e) || !t) throw new Error('Not allowed')
    const text = String(t.text || '').trim().slice(0, 500)
    if (!text) throw new Error('Write the to-do first.')
    const due = Number(t.due) || null
    todos().push({ id: newId(), text, due, done: false, created: Date.now() })
    store.save()
    notifyPages('todos:changed', todos())
    return todos()
  })
  ipcMain.handle('todos:update', (e, id, patch) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    const t = todos().find((x) => x.id === id)
    if (t && patch) {
      if (typeof patch.done === 'boolean') { t.done = patch.done; t.doneAt = patch.done ? Date.now() : null }
      if (typeof patch.text === 'string' && patch.text.trim()) t.text = patch.text.trim().slice(0, 500)
      if ('due' in patch) { t.due = Number(patch.due) || null; t.notified = false }
      store.save()
      notifyPages('todos:changed', todos())
    }
    return todos()
  })
  ipcMain.handle('todos:delete', (e, id) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    store.state.settings.todos = id === '*done' ? todos().filter((x) => !x.done) : todos().filter((x) => x.id !== id)
    store.save()
    notifyPages('todos:changed', todos())
    return todos()
  })
  // Open the conversation a reminder is about
  ipcMain.handle('timers:open', (e, id) => {
    if (!isInternalSender(e)) return false
    const r = reminders().find((x) => x.id === id)
    if (!r) return false
    if (r.kind === 'wa') openWhatsAppChat(r.name)
    else showImessageChat(r.guid)
    return true
  })
  // A conversation linked to one JobTread job
  ipcMain.handle('jt:link-get', (e, key) => (qrAllowed(e) ? jtLinks()[String(key)] || null : null))
  ipcMain.handle('jt:link-set', (e, key, link) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    key = String(key || '')
    if (!key) throw new Error('No conversation')
    if (!link) delete jtLinks()[key]
    else {
      const old = jtLinks()[key] || {}
      const L = {
        jobId: String(link.jobId || ''),
        jobName: String(link.jobName || '').slice(0, 120),
        jobNumber: String(link.jobNumber || '').slice(0, 20),
        status: String(link.status || '').slice(0, 60),
        accountId: String(link.accountId || ''),
        auto: !!link.auto,
        autoPhotos: typeof link.autoPhotos === 'boolean' ? link.autoPhotos : !!old.autoPhotos,
        photosSince: old.jobId === String(link.jobId || '') ? old.photosSince || 0 : 0,
        sentAtt: old.jobId === String(link.jobId || '') ? old.sentAtt || [] : [],
      }
      if (!L.jobId) throw new Error('Pick a job')
      if (L.autoPhotos && !old.autoPhotos) L.photosSince = Date.now()
      jtLinks()[key] = L
    }
    store.save()
    return jtLinks()[key] || null
  })
  ipcMain.handle('jt:comment', (e, c) => {
    if (!qrAllowed(e) || !c) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    return jobtread.addComment(key, { jobId: String(c.jobId || ''), message: String(c.message || ''), name: String(c.name || '') })
  })
  // JobTread tasks assigned to you (for Tasks), quick search, and the morning summary
  let myTasksCache = null
  ipcMain.handle('jt:my-tasks', async (e, fresh) => {
    if (!qrAllowed(e)) return { tasks: [] }
    const key = jtKey()
    if (!key) return { connected: false, tasks: [] }
    if (!fresh && myTasksCache && myTasksCache.key === key && Date.now() - myTasksCache.at < 120e3) return myTasksCache.data
    const data = { connected: true, ...(await jobtread.myTasks(key)) }
    myTasksCache = { key, at: Date.now(), data }
    return data
  })
  ipcMain.handle('jt:task-done', async (e, id) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    await jobtread.completeTask(key, String(id || ''))
    if (myTasksCache) myTasksCache.data = { ...myTasksCache.data, tasks: myTasksCache.data.tasks.filter((t) => t.id !== id) }
    return true
  })
  ipcMain.handle('jt:search', (e, q) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet. Open Settings: JobTread & AI Keys.')
    return jobtread.searchAll(key, String(q || ''))
  })
  // iMessages from customers you haven't answered in over a day (last 7 days)
  ipcMain.handle('summary:unanswered', async (e) => {
    if (!isInternalSender(e)) return []
    if (process.platform !== 'darwin' && !process.env.MULTISPACE_TEST_CHATDB) return []
    try {
      const now = Date.now()
      const hidden = store.state.settings.imsg?.hidden || {}
      return (await imessage.listChats(80))
        .filter((c) => !c.group && !c.lastFromMe && c.date < now - 24 * 3600e3 && c.date > now - 7 * 24 * 3600e3 && !(hidden[c.guid] >= c.date))
        .slice(0, 15)
        .map((c) => ({ guid: c.guid, title: c.title || c.handle, last: c.last, date: c.date, job: jobLabel(jtLinks()[c.guid]) }))
    } catch {
      return []
    }
  })
  // ---- Texting customers: iMessage (this Mac) or Quo (your team's numbers)
  const DEFAULT_TEMPLATES = {
    estimate: 'Hi {first}, this is Nilson from Master Touch Pools. Just checking in on the {job} proposal we sent. Any questions I can answer?',
    invoice: 'Hi {first}, this is Master Touch Pools. A friendly reminder that invoice #{number} for {job} has a balance of {amount}. Please let us know if you have any questions. Thank you!',
    onmyway: 'Hi {first}, this is Nilson from Master Touch Pools. I am on my way and should be there in about {eta} minutes.',
  }
  const sendSettings = () => {
    const q = store.state.settings.quoCfg || {}
    return { via: store.state.settings.sendVia || (process.platform === 'darwin' ? 'imessage' : 'quo'), quoConnected: !!secretGet('quo'), quoFrom: q.from || '', quoFromLabel: q.label || '', quoNumbers: q.numbers || [], templates: { ...DEFAULT_TEMPLATES, ...(store.state.settings.templates || {}) }, followed: store.state.settings.followed || {} }
  }
  ipcMain.handle('send:settings', (e) => (qrAllowed(e) ? sendSettings() : null))
  ipcMain.handle('send:set', (e, p) => {
    if (!isInternalSender(e) || !p) throw new Error('Not allowed')
    if (p.via === 'imessage' || p.via === 'quo') store.state.settings.sendVia = p.via
    if (typeof p.quoFrom === 'string') {
      const cfg = (store.state.settings.quoCfg = store.state.settings.quoCfg || {})
      const n = (cfg.numbers || []).find((x) => x.id === p.quoFrom)
      cfg.from = p.quoFrom
      cfg.label = n ? n.label : ''
    }
    if (p.templates) { const t = { ...(store.state.settings.templates || {}) }; for (const k of Object.keys(DEFAULT_TEMPLATES)) if (typeof p.templates[k] === 'string') t[k] = p.templates[k].slice(0, 1500); store.state.settings.templates = t }
    store.save()
    return sendSettings()
  })
  ipcMain.handle('quo:set-key', async (e, key) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    key = String(key || '').trim()
    if (!key) { secretSet('quo', ''); delete store.state.settings.quoCfg; store.save(); return sendSettings() }
    const nums = await quo.numbers(key)
    secretSet('quo', key)
    const old = store.state.settings.quoCfg || {}
    const from = nums.some((n) => n.id === old.from) ? old.from : (nums[0] || {}).id || ''
    store.state.settings.quoCfg = { numbers: nums, from, label: (nums.find((n) => n.id === from) || {}).label || '' }
    store.save()
    return sendSettings()
  })
  ipcMain.handle('send:text', async (e, m) => {
    if (!isInternalSender(e) || !m) throw new Error('Not allowed')
    const text = String(m.text || '').trim()
    if (!text) throw new Error('Write the message first.')
    const to = String(m.to || '').trim()
    if (!to) throw new Error('This customer has no phone number in JobTread.')
    const via = m.via === 'quo' ? 'quo' : 'imessage'
    if (via === 'quo') {
      const key = secretGet('quo')
      if (!key) throw new Error('Quo is not connected yet. Add your Quo API key in Settings (Tasks → ⚙ Settings).')
      await quo.send(key, { from: (store.state.settings.quoCfg || {}).from, to, content: text })
    } else {
      if (process.platform !== 'darwin' && !process.env.MULTISPACE_TEST_CHATDB) throw new Error('iMessage only works on a Mac. Pick Quo.')
      const d = to.replace(/\D/g, '')
      await imessage.sendToHandle(d.length === 10 ? '+1' + d : '+' + d, text)
    }
    if (m.docId) {
      const f = (store.state.settings.followed = store.state.settings.followed || {})
      f[String(m.docId)] = Date.now()
      for (const k of Object.keys(f)) if (Date.now() - f[k] > 60 * 864e5) delete f[k]
      store.save()
    }
    // a note on the job, so the team knows it was sent
    if (m.jobId && jtKey()) jobtread.addComment(jtKey(), { jobId: String(m.jobId), message: `Text sent by ${via === 'quo' ? 'Quo' : 'iMessage'} to ${to}:\n${text}`, name: m.docId ? 'Follow-up sent' : 'Text sent' }).catch(() => {})
    return true
  })
  ipcMain.handle('send:skip', (e, docId) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    const f = (store.state.settings.followed = store.state.settings.followed || {})
    f[String(docId)] = Date.now()
    store.save()
    return true
  })
  // ---- Today's appointments (Google Calendar secret iCal address), linked to JobTread customers
  let calCache = null
  const custCache = new Map()
  async function linkEvent(key, ev) {
    const text = [ev.title, ev.location, ev.description].join('\n')
    const phone = (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0] || ''
    const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || ''
    const ck = phone + '|' + email + '|' + ev.title + '|' + ev.location
    if (custCache.has(ck) && Date.now() - custCache.get(ck).at < 6 * 3600e3) return custCache.get(ck).v
    let v = null
    try {
      let c = phone || email ? await jobtread.findCustomer(key, { phone, email }) : null
      // no phone or e-mail in the event: try the street address, then each part of the title
      let job = null
      if (!c && ev.location) {
        const street = ev.location.split(',')[0].trim()
        if (street.length >= 5) job = (await jobtread.searchJobs(key, street))[0] || null
      }
      if (!c && !job) {
        for (const part of String(ev.title).split(/\s[-–|:·]\s|[-–|:·]\s|,\s/).map((s) => s.trim()).filter((s) => s.length >= 4 && /[a-z]/i.test(s)).slice(0, 3)) {
          c = await jobtread.findCustomer(key, { name: part }).catch(() => null)
          if (c) break
        }
      }
      if (c) {
        const open = (c.jobs || []).filter((j) => !j.closed)
        job = job || open[0] || (c.jobs || [])[0] || null
        v = { customer: { id: c.id, name: c.name, url: c.url }, phone: phone || c.phone || '', job: job ? { id: job.id, name: job.name, url: job.url || `https://app.jobtread.com/jobs/${job.id}` } : null }
      } else if (job) {
        v = { customer: job.accountId ? { id: job.accountId, name: job.customer, url: `https://app.jobtread.com/customers/${job.accountId}` } : null, phone, job: { id: job.id, name: job.name, url: job.url } }
        if (job.accountId && !phone) {
          const c2 = await jobtread.findCustomer(key, { name: job.customer }).catch(() => null)
          if (c2) v.phone = c2.phone || ''
        }
      } else if (phone) v = { customer: null, phone, job: null }
    } catch {}
    custCache.set(ck, { at: Date.now(), v })
    return v
  }
  ipcMain.handle('cal:today', async (e, fresh) => {
    if (!isInternalSender(e)) return null
    const url = secretGet('cal')
    if (!url) return { connected: false, events: [] }
    const day = new Date().toDateString()
    if (!fresh && calCache && calCache.url === url && calCache.day === day && Date.now() - calCache.at < 5 * 60e3) return calCache.data
    const events = await calendar.today(url)
    const key = jtKey()
    if (key) {
      const queue = [...events]
      await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const ev = queue.shift(); Object.assign(ev, await linkEvent(key, ev) || {}) } }))
    }
    const data = { connected: true, events, publicOnly: /\/public\/basic\.ics/.test(url) && events.length > 0 && events.every((x) => /^busy$/i.test(x.title)) }
    calCache = { url, day, at: Date.now(), data }
    return data
  })
  ipcMain.handle('cal:set-url', async (e, url) => {
    if (!isInternalSender(e)) throw new Error('Not allowed')
    url = String(url || '').trim().replace(/^webcal:/i, 'https:')
    calCache = null
    if (!url) { secretSet('cal', ''); return { connected: false, events: [] } }
    if (/calendar\.google\.com\/calendar\/(embed|r\b)/.test(url)) throw new Error('That is the calendar\'s web link, not the iCal address. In Google Calendar → Settings → your calendar → Integrate calendar, copy the "Secret address in iCal format" (it ends in basic.ics).')
    const evs = await calendar.today(url) // checks the address works
    if (/\/public\/basic\.ics/.test(url) && evs.length && evs.every((x) => /^busy$/i.test(x.title))) throw new Error('That is the PUBLIC address, so Google only sends "Busy" with no names. Copy the "Secret address in iCal format" instead (it has "private-" in it and ends in basic.ics).')
    secretSet('cal', url)
    return { connected: true }
  })

  // ---- Team setup: quick replies, message templates and apps in one file (never keys or passwords)
  const cleanApp = (a) => ({ name: String(a.name || '').slice(0, 80), url: String(a.url || ''), subtitle: String(a.subtitle || '').slice(0, 120), ...(typeof a.icon === 'string' && a.icon.length < 300000 ? { icon: a.icon } : {}) })
  const okAppUrl = (u) => /^(https?:\/\/|internal:)/i.test(u)
  async function teamExport() {
    const data = {
      kind: 'checkmate-team-setup',
      version: 1,
      exportedAt: new Date().toISOString(),
      spaces: store.state.spaces.map((s) => ({ name: s.name, color: s.color, apps: s.apps.map(cleanApp).filter((a) => okAppUrl(a.url)) })),
      quickReplies: quickReplies(),
      templates: { ...DEFAULT_TEMPLATES, ...(store.state.settings.templates || {}) },
    }
    const { canceled, filePath } = process.env.MULTISPACE_TEST_TEAMFILE ? { filePath: process.env.MULTISPACE_TEST_TEAMFILE } : await dialog.showSaveDialog(win, {
      title: 'Export team setup',
      defaultPath: path.join(app.getPath('desktop'), 'CheckMate Team Setup.json'),
      filters: [{ name: 'CheckMate team setup', extensions: ['json'] }],
    })
    if (canceled || !filePath) return null
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    const apps = data.spaces.reduce((n, s) => n + s.apps.length, 0)
    return { file: filePath, apps, quickReplies: data.quickReplies.length }
  }
  async function teamImport(file) {
    if (!file && process.env.MULTISPACE_TEST_TEAMFILE) file = process.env.MULTISPACE_TEST_TEAMFILE
    if (!file) {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Import team setup', properties: ['openFile'], filters: [{ name: 'CheckMate team setup', extensions: ['json'] }] })
      if (canceled || !filePaths[0]) return null
      file = filePaths[0]
    }
    let data
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error('That file could not be read.') }
    if (!data || data.kind !== 'checkmate-team-setup') throw new Error('That is not a CheckMate team setup file.')
    const spaces = (Array.isArray(data.spaces) ? data.spaces : []).slice(0, 30)
    const qr = Array.isArray(data.quickReplies) ? data.quickReplies : []
    const appCount = spaces.reduce((n, s) => n + (Array.isArray(s.apps) ? s.apps.length : 0), 0)
    if (!process.env.MULTISPACE_TEST_AUTOCONFIRM) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Import', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: 'Import this team setup?',
        detail: `${appCount} apps in ${spaces.length} space(s) are added (apps you already have are skipped).\n${qr.length} quick replies and the message templates replace yours.\n\nNo keys or passwords are in this file. Each person connects their own JobTread, Quo and AI keys.`,
      })
      if (response !== 0) return null
    }
    let added = 0
    for (const s of spaces) {
      const name = String(s.name || 'Space').slice(0, 60)
      let sp = store.state.spaces.find((x) => x.name.toLowerCase() === name.toLowerCase())
      if (!sp) sp = store.addSpace({ name, color: typeof s.color === 'string' ? s.color : undefined })
      for (const a of (Array.isArray(s.apps) ? s.apps : []).slice(0, 60).map(cleanApp)) {
        if (!okAppUrl(a.url) || !a.name) continue
        if (sp.apps.some((x) => x.url.replace(/\/+$/, '') === a.url.replace(/\/+$/, ''))) continue
        store.addApp(sp.id, a)
        added++
      }
    }
    if (qr.length) {
      store.state.settings.quickReplies = qr.slice(0, 60).map((q) => ({ title: String(q?.title || '').trim().slice(0, 60), text: String(q?.text || '').slice(0, 2000) })).filter((q) => q.text.trim())
      notifyQuickReplies()
    }
    if (data.templates && typeof data.templates === 'object') {
      const t = {}
      for (const k of Object.keys(DEFAULT_TEMPLATES)) if (typeof data.templates[k] === 'string' && data.templates[k].trim()) t[k] = data.templates[k].slice(0, 1500)
      store.state.settings.templates = t
    }
    store.save()
    pushState()
    return { added, quickReplies: qr.length }
  }
  teamExportFn = teamExport
  teamImportFn = teamImport
  ipcMain.handle('team:export', (e) => { if (!isInternalSender(e)) throw new Error('Not allowed'); return teamExport() })
  ipcMain.handle('team:import', (e) => { if (!isInternalSender(e)) throw new Error('Not allowed'); return teamImport() })
  let moneyCache = null
  ipcMain.handle('jt:money', async (e, fresh) => {
    if (!qrAllowed(e)) return null
    const key = jtKey()
    if (!key) return { connected: false, estimates: [], invoices: [] }
    if (!fresh && moneyCache && moneyCache.key === key && Date.now() - moneyCache.at < 5 * 60e3) return moneyCache.data
    const data = { connected: true, ...(await jobtread.moneyToChase(key)) }
    moneyCache = { key, at: Date.now(), data }
    return data
  })
  ipcMain.handle('jt:jobs-search', (e, q) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    return jobtread.searchJobs(key, String(q || ''))
  })
  // A Gmail attachment, downloaded with that space's Google sign-in, filed on a job.
  ipcMain.handle('jt:upload-url', async (e, t, f) => {
    if (!qrAllowed(e) || !f) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    let u
    try { u = new URL(String(f.url)) } catch { throw new Error('Bad attachment link') }
    if (u.protocol !== 'https:' || !/(^|\.)(mail\.google\.com|googleusercontent\.com)$/.test(u.hostname)) throw new Error('Not allowed')
    const res = await e.sender.session.fetch(u.href, { credentials: 'include' })
    if (!res.ok) throw new Error(`Could not download the attachment (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = String(f.mime || res.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream'
    const folder = /^image\//.test(mime) ? 'Photos' : 'Files'
    return jobtread.uploadFile(key, { ...jtTarget(t), name: String(f.name || 'Attachment').slice(0, 120), mime, bytes: buf, folder })
  })
  ipcMain.handle('jt:task', (e, t) => {
    if (!qrAllowed(e) || !t) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    return jobtread.addTask(key, { jobId: String(t.jobId || ''), name: String(t.name || ''), description: String(t.description || ''), due: String(t.due || '') })
  })
  ipcMain.handle('jt:find', (e, q) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) return null
    const c = q || {}
    return jobtread.findCustomer(key, { phone: String(c.phone || '').slice(0, 40), email: String(c.email || '').slice(0, 120), name: String(c.name || '').slice(0, 120) })
  })
  const jtTarget = (t) => ({ targetType: t && t.targetType === 'account' ? 'account' : 'job', targetId: String((t && t.targetId) || '') })
  ipcMain.handle('jt:upload', (e, t, file) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    const f = file || {}
    return jobtread.uploadFile(key, { ...jtTarget(t), name: String(f.name || 'Photo.jpg').slice(0, 120), mime: String(f.mime || 'image/jpeg').slice(0, 60), bytes: f.bytes })
  })
  ipcMain.handle('jt:upload-att', async (e, t, attId) => {
    const tab = findTabByWebContents(e.sender)
    if (!tab || !tab.internal) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    const a = await imessage.attachmentFile(Number(attId))
    const src = a.file || a.path
    const bytes = fs.readFileSync(src)
    let orig = ''
    try { orig = path.basename(await imessage.attachmentPath(Number(attId))) } catch {}
    const isImg = /^image\//.test(a.mime || '')
    let name = String(orig || path.basename(src || 'Photo.jpg'))
    if (isImg && path.extname(src).toLowerCase() === '.jpg' && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg' // HEIC was converted
    const mime = isImg ? (/heic|heif|tiff/i.test(a.mime) ? 'image/jpeg' : a.mime) : a.mime || 'application/octet-stream'
    return jobtread.uploadFile(key, { ...jtTarget(t), name: name.slice(0, 120), mime, bytes, folder: isImg ? 'Photos' : 'Files' })
  })
  // A file dropped from Finder (or a picture/document read by the page): bytes + name, filed by type.
  ipcMain.handle('jt:upload-file', (e, t, file) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    const f = file || {}
    const mime = String(f.mime || '').slice(0, 100) || 'application/octet-stream'
    return jobtread.uploadFile(key, { ...jtTarget(t), name: String(f.name || 'File').slice(0, 120), mime, bytes: f.bytes, folder: /^image\//.test(mime) ? 'Photos' : 'Files' })
  })
  // A file just downloaded from WhatsApp (a document someone sent): the page only gets an id, never a path.
  ipcMain.handle('jt:upload-download', (e, t, id) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const key = jtKey()
    if (!key) throw new Error('JobTread is not connected yet.')
    const d = jtDownloads.get(String(id))
    if (!d || d.wcId !== e.sender.id) throw new Error('That download is gone. Download it again.')
    const bytes = fs.readFileSync(d.path)
    return jobtread.uploadFile(key, { ...jtTarget(t), name: d.name.slice(0, 120), mime: d.mime, bytes, folder: /^image\//.test(d.mime) ? 'Photos' : 'Files' })
  })
  // Clipboard text for the "Paste" buttons next to our key boxes.
  ipcMain.handle('clip:text', async (e) => (qrAllowed(e) ? String((await clipboard.readText()) || '') : ''))
  ipcMain.handle('dictate', (e) => {
    if (!qrAllowed(e) || process.platform !== 'darwin') return false
    e.sender.focus()
    Menu.sendActionToFirstResponder('startDictation:')
    return true
  })
  ipcMain.handle('ai:status', (e) => ({ connected: qrAllowed(e) && !!secretGet('ai') }))
  ipcMain.handle('ai:set-key', async (e, key) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    key = String(key || '').trim()
    if (!key) { secretSet('ai', ''); return { connected: false } }
    await aiCall(key, 'Reply with OK.', 'Say OK.', 5)
    secretSet('ai', key)
    return { connected: true }
  })
  ipcMain.handle('ai:suggest', (e, q) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    const c = q || {}
    return aiSuggest({ name: String(c.name || '').slice(0, 120), messages: c.messages, draft: String(c.draft || '') })
  })
  ipcMain.handle('jt:status', (e) => (qrAllowed(e) ? jtStatus() : { connected: false }))
  ipcMain.handle('jt:set-key', (e, key) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    return jtSetKey(key)
  })
  ipcMain.handle('jt:set-on', (e, on) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    if (store.state.settings.jobtread) store.state.settings.jobtread.on = !!on
    store.save()
    return jtStatus()
  })
  ipcMain.handle('jt:add', (e, c) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    return jtAdd(c)
  })
  ipcMain.on('jt:open', (e, url) => {
    if (!qrAllowed(e) || !/^https:\/\/app\.jobtread\.com\//.test(String(url))) return
    const t = findTabByWebContents(e.sender)
    createTab((t && t.spaceId) || store.state.activeSpaceId, { url: String(url) })
  })
  ipcMain.handle('qr:list', (e) => (qrAllowed(e) ? quickReplies() : []))
  ipcMain.handle('qr:set', (e, list) => {
    if (!qrAllowed(e)) throw new Error('Not allowed')
    store.state.settings.quickReplies = (Array.isArray(list) ? list : []).slice(0, 60)
      .map((q) => ({ title: String(q?.title || '').trim().slice(0, 60), text: String(q?.text || '').slice(0, 2000) }))
      .filter((q) => q.text.trim())
    store.save()
    notifyQuickReplies()
    return quickReplies()
  })
  ipcMain.on('wa:unread', (e, list) => {
    let h = ''
    try { h = new URL(e.senderFrame ? e.senderFrame.url : e.sender.getURL()).hostname } catch {}
    if (h !== 'web.whatsapp.com' || (e.senderFrame && e.senderFrame.parent)) return
    const tab = findTabByWebContents(e.sender)
    if (!tab) return
    const clean = (Array.isArray(list) ? list : []).slice(0, 50).map((c) => ({
      name: String(c?.name || '').slice(0, 120), preview: String(c?.preview || '').slice(0, 200), count: Math.max(0, Number(c?.count) | 0), time: String(c?.time || '').slice(0, 20),
    })).filter((c) => c.name)
    waUnread.set(e.sender.id, { spaceId: tab.spaceId, tabId: tab.id, list: clean })
    if (!e.sender._msUnreadHook) {
      e.sender._msUnreadHook = true
      e.sender.once('destroyed', () => waUnread.delete(e.sender.id))
    }
  })
  ipcMain.handle('unified:list', imsgOnly(() => unifiedList()))
  ipcMain.handle('unified:open', imsgOnly((it) => openUnified(it)))
  // Reply from the Unread page without opening the chat
  ipcMain.handle('imsg:mark-in-messages', imsgOnly((guid) => markInMessagesApp(guid)))
  ipcMain.handle('unified:mark-read', imsgOnly((guid, date) => {
    markInMessagesApp(guid)
    const p = (store.state.settings.imsg = store.state.settings.imsg || { favorites: [], readUpTo: {}, manualUnread: {}, hidden: {} })
    p.readUpTo = p.readUpTo || {}
    p.readUpTo[String(guid)] = Math.max(Number(date) || 0, p.readUpTo[String(guid)] || 0)
    if (p.manualUnread) delete p.manualUnread[String(guid)]
    store.save()
    for (const rt of runtimes.values()) for (const t of rt.tabs.values()) if (t.url === IMESSAGE_URL && !t.view.webContents.isDestroyed()) t.view.webContents.send('imsg:prefs-changed')
    return true
  }))
  let waReq = 0
  ipcMain.handle('unified:wa-send', imsgOnly(async (it, text) => {
    text = String(text || '').trim()
    if (!text) throw new Error('Write the message first.')
    const rt = runtimes.get(String(it && it.spaceId))
    const t = rt && rt.tabs.get(Number(it && it.tabId))
    if (!t || t.view.webContents.isDestroyed() || hostOf(t.url) !== 'web.whatsapp.com') throw new Error('WhatsApp is not open anymore. Open WhatsApp and try again.')
    const id = ++waReq
    const wc = t.view.webContents
    return new Promise((resolve, reject) => {
      const done = (e, rid, res) => {
        if (e.sender !== wc || rid !== id) return
        clearTimeout(timer)
        ipcMain.removeListener('wa:send-result', done)
        res && res.ok ? resolve(true) : reject(new Error((res && res.error) || 'Could not send on WhatsApp.'))
      }
      const timer = setTimeout(() => { ipcMain.removeListener('wa:send-result', done); reject(new Error('WhatsApp did not answer. Open the chat and send it there.')) }, 15000)
      ipcMain.on('wa:send-result', done)
      wc.send('wa:send-chat', id, String(it.name || ''), text)
    })
  }))
  ipcMain.handle('imsg:send-handle', imsgOnly((h, text) => imessage.sendToHandle(String(h), String(text))))
  // Favorites and read/unread marks live in the browser (Messages' own database is read-only).
  ipcMain.handle('imsg:prefs', imsgOnly(() => store.state.settings.imsg || { favorites: [], readUpTo: {}, manualUnread: {}, hidden: {} }))
  ipcMain.handle(
    'imsg:set-prefs',
    imsgOnly((prefs) => {
      const p = prefs || {}
      store.state.settings.imsg = {
        favorites: Array.isArray(p.favorites) ? p.favorites.map(String).slice(0, 500) : [],
        readUpTo: p.readUpTo && typeof p.readUpTo === 'object' ? p.readUpTo : {},
        manualUnread: p.manualUnread && typeof p.manualUnread === 'object' ? p.manualUnread : {},
        hidden: p.hidden && typeof p.hidden === 'object' ? p.hidden : {},
        team: Array.isArray(p.team) ? p.team.slice(0, 100).map((t) => ({ name: String(t?.name || '').slice(0, 80), phone: String(t?.phone || '').slice(0, 40) })).filter((t) => t.name) : [],
      }
      store.save()
      return true
    })
  )
  // Links inside messages open as a normal tab in the same space.
  ipcMain.on('imsg:open-url', (e, url) => {
    const tab = findTabByWebContents(e.sender)
    if (!tab || !tab.internal || !/^https?:\/\//i.test(String(url))) return
    createTab(tab.spaceId, { url: String(url) })
  })
  // Forward a text to a teammate on WhatsApp: opens your WhatsApp Web chat with them, message typed in.
  // You still press Enter yourself. Without a phone (e.g. a group) the text is copied to paste.
  ipcMain.handle('imsg:whatsapp', (e, phone, text) => {
    const from = findTabByWebContents(e.sender)
    if (!from || !from.internal) return false
    const digits = String(phone || '').replace(/\D/g, '')
    const msg = String(text || '').slice(0, 4000)
    if (!digits) clipWriteText(msg)
    const url = digits ? `https://web.whatsapp.com/send?phone=${digits}&text=${encodeURIComponent(msg)}` : 'https://web.whatsapp.com/'
    const isWa = (u) => /^https:\/\/web\.whatsapp\.com\//.test(u || '')
    const spaces = [from.spaceId, ...store.state.spaces.map((x) => x.id).filter((id) => id !== from.spaceId)]
    for (const sid of spaces) {
      const rt = runtimes.get(sid)
      const tab = rt && [...rt.tabs.values()].find((t) => isWa(t.url))
      if (tab) {
        if (store.state.activeSpaceId !== sid) activateSpace(sid)
        selectTab(sid, tab.id)
        if (digits) tab.view.webContents.loadURL(url).catch(() => {})
        return true
      }
    }
    for (const sid of spaces) {
      const a = store.getSpace(sid)?.apps.find((x) => isWa(x.url))
      if (a) {
        if (store.state.activeSpaceId !== sid) activateSpace(sid)
        createTab(sid, { url, appId: a.id })
        return true
      }
    }
    createTab(from.spaceId, { url })
    return true
  })
  // Show an attachment's file in Finder (for files the page can't display).
  ipcMain.on('imsg:reveal-attachment', async (e, id) => {
    if (!findTabByWebContents(e.sender)?.internal) return
    try {
      shell.showItemInFolder(await imessage.attachmentPath(id))
    } catch {}
  })
  // Save or copy a photo/file from a message
  ipcMain.handle('imsg:save-attachment', async (e, id, mode) => {
    if (!findTabByWebContents(e.sender)?.internal) throw new Error('Not allowed')
    const a = await imessage.attachmentFile(Number(id))
    const src = a.file || a.path
    if (mode === 'copy') {
      const img = nativeImage.createFromPath(src)
      if (img.isEmpty()) throw new Error('This file can not be copied as a picture.')
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })])
      return { copied: true }
    }
    let orig = ''
    try { orig = path.basename(await imessage.attachmentPath(Number(id))) } catch {}
    let name = (orig || path.basename(src)).replace(/[\/:*?"<>|]/g, '_')
    if (path.extname(src).toLowerCase() === '.jpg' && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]+$/, '') + '.jpg'
    const { canceled, filePath } = process.env.MULTISPACE_TEST_SAVEDIR
      ? { filePath: path.join(process.env.MULTISPACE_TEST_SAVEDIR, name) }
      : await dialog.showSaveDialog(win, { title: 'Save picture', defaultPath: path.join(app.getPath('downloads'), name) })
    if (canceled || !filePath) return null
    fs.copyFileSync(src, filePath)
    return { file: filePath }
  })
  ipcMain.on('imsg:open-messages', (e, handle) => {
    if (!findTabByWebContents(e.sender)?.internal) return
    const h = String(handle || '').replace(/[^\w@.+\-]/g, '')
    shell.openExternal(h ? 'imessage://' + h : 'imessage://')
  })
  ipcMain.on('imsg:open-privacy', (e) => {
    if (findTabByWebContents(e.sender)?.internal) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })

  // ---- passwords
  // Only tabs (not the browser UI or other windows) can ask for logins, and only for the
  // frame's own real URL, which comes from the main process rather than from the page.
  ipcMain.handle('pw:lookup', (e) => {
    const tab = findTabByWebContents(e.sender) || (e.sender.hostWebContents && findTabByWebContents(e.sender.hostWebContents))
    const isPopup = !tab && BrowserWindow.fromWebContents(e.sender)?.getParentWindow() === win
    if (!tab && !isPopup) return []
    try {
      return vault.forUrl(e.senderFrame ? e.senderFrame.url : e.sender.getURL())
    } catch {
      return []
    }
  })
  ipcMain.on('pw:offer-save', async (e, { username, password }) => {
    const url = e.senderFrame ? e.senderFrame.url : e.sender.getURL()
    if (!password || !/^https:/.test(url) || !vault.available()) return
    let known
    try {
      known = vault.forUrl(url)
    } catch {
      return
    }
    if (known.some((l) => l.username === username && l.password === password)) return
    const host = new URL(url).hostname.replace(/^www\./, '')
    if ((store.state.settings.neverSave || []).includes(host)) return
    const update = known.some((l) => l.username === username)
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [update ? 'Update password' : 'Save password', 'Not now', 'Never for this site'],
      defaultId: 0,
      cancelId: 1,
      message: `${update ? 'Update' : 'Save'} password for ${host}?`,
      detail: username ? `Username: ${username}` : 'No username detected.',
    })
    if (response === 0) {
      vault.add({ url, username, password })
      vault.save()
    } else if (response === 2) {
      store.state.settings.neverSave = [...(store.state.settings.neverSave || []), host]
      store.save()
    }
  })
  ipcMain.handle('pw:list', () => {
    try {
      return { ok: true, items: vault.list(), secure: vault.available() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  ipcMain.handle('pw:remove', (_e, id) => vault.remove(id))
  ipcMain.handle('pw:add', (_e, entry) => {
    if (!vault.add(entry)) return false
    vault.save()
    return true
  })
  ipcMain.handle('pw:import', importPasswordsDialog)

  ipcMain.handle('get-state', () => snapshot())
  ipcMain.handle('ms-sidepanel', (e, extId, op, arg) => {
    const rt = [...runtimes.values()].find((r) => r.session === e.sender.session)
    if (!rt || !String(e.sender.getURL()).startsWith(`chrome-extension://${extId}/`)) throw new Error('Not allowed')
    return sidePanelOp(rt.spaceId, extId, op, arg)
  })
  ipcMain.on('content-bounds', (_e, b) => {
    contentBounds = {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height)),
    }
    layoutViews()
  })
  ipcMain.on('overlay', (_e, open) => {
    overlayOpen = !!open
    layoutViews()
  })

  ipcMain.on('space:activate', (_e, id) => activateSpace(id))
  ipcMain.handle('space:add', (_e, data) => {
    const s = store.addSpace(data || {})
    ;(data && data.apps ? data.apps : []).forEach((a) => store.addApp(s.id, a))
    activateSpace(s.id)
    return s.id
  })
  ipcMain.on('space:update', (_e, id, patch) => {
    store.updateSpace(id, patch)
    pushState()
  })
  ipcMain.on('space:move', (_e, id, delta) => {
    store.moveSpace(id, delta)
    pushState()
  })
  ipcMain.handle('space:remove', async (_e, id) => {
    const space = store.getSpace(id)
    if (!space) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete space', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${space.name}"?`,
      detail: 'This signs you out of every site in this space and deletes its cookies and data.',
    })
    if (response !== 0) return
    const rt = runtimes.get(id)
    if (rt) {
      for (const tab of rt.tabs.values()) {
        win.contentView.removeChildView(tab.view)
        tab.view.webContents.close()
      }
      await rt.session.clearStorageData().catch(() => {})
      runtimes.delete(id)
    }
    store.removeSpace(id)
    if (store.state.spaces.length === 0) store.addSpace({ name: 'Personal' })
    activateSpace(store.state.activeSpaceId || store.state.spaces[0].id)
  })

  ipcMain.on('app:open', (_e, spaceId, appId) => openApp(spaceId, appId))
  ipcMain.on('app:add', (_e, spaceId, entry) => {
    const icon = typeof entry.icon === 'string' && entry.icon.startsWith('data:image/svg+xml') ? entry.icon : undefined
    const a = store.addApp(spaceId, { name: entry.name, url: normalizeUrl(entry.url), subtitle: entry.subtitle, icon })
    if (!a) return
    // Saving the page you're on: turn the current tab into the app instead of opening a duplicate.
    const rt = runtimes.get(spaceId)
    // Dragged a tab from the top strip onto the apps panel: that tab becomes the app, at the drop position.
    const dragged = rt && Number.isInteger(entry.fromTabId) ? rt.tabs.get(entry.fromTabId) : null
    if (Number.isInteger(entry.index)) {
      const s = store.getSpace(spaceId)
      const ids = s.apps.map((x) => x.id).filter((x) => x !== a.id)
      ids.splice(Math.max(0, Math.min(entry.index, ids.length)), 0, a.id)
      store.reorder(s.apps, ids)
    }
    if (dragged && !dragged.appId) {
      dragged.appId = a.id
      persistTabs(spaceId)
      pushState()
      return
    }
    const cur = rt && rt.tabs.get(rt.activeTabId)
    if (entry.fromCurrentTab && cur && !cur.appId) {
      cur.appId = a.id
      persistTabs(spaceId)
    } else openApp(spaceId, a.id)
    pushState()
  })
  ipcMain.on('app:update', (_e, spaceId, appId, patch) => {
    if (patch.url) patch.url = normalizeUrl(patch.url)
    const before = store.getSpace(spaceId)?.apps.find((a) => a.id === appId)?.url
    const a = store.updateApp(spaceId, appId, patch)
    if (a && patch.url && patch.url !== before) {
      const tab = [...(runtimes.get(spaceId)?.tabs.values() || [])].find((t) => t.appId === appId)
      if (tab) tab.view.webContents.loadURL(a.url).catch(() => {})
    }
    pushState()
  })
  ipcMain.on('app:reorder', (_e, spaceId, ids) => {
    const s = store.getSpace(spaceId)
    if (s) store.reorder(s.apps, ids)
    pushState()
  })
  ipcMain.on('space:reorder', (_e, ids) => {
    store.reorder(store.state.spaces, ids)
    pushState()
  })
  ipcMain.on('app:move', (_e, spaceId, appId, delta) => {
    store.moveApp(spaceId, appId, delta)
    pushState()
  })
  ipcMain.on('app:remove', (_e, spaceId, appId) => {
    const rt = runtimes.get(spaceId)
    if (rt) for (const t of [...rt.tabs.values()]) if (t.appId === appId) closeTab(spaceId, t.id)
    store.removeApp(spaceId, appId)
    pushState()
  })

  ipcMain.on('tab:new', (_e, url) => createTab(store.state.activeSpaceId, { url: url || 'https://www.google.com/' }))
  ipcMain.on('tab:select', (_e, spaceId, tabId) => selectTab(spaceId, tabId))
  ipcMain.on('tab:close', (_e, spaceId, tabId) => closeTab(spaceId, tabId))
  ipcMain.on('tab:popout', (e, spaceId, tabId, at) => { if (e.sender === win.webContents) popoutTab(spaceId, tabId, at) })
  ipcMain.on('tab:menu', (e, spaceId, tabId) => {
    if (e.sender !== win.webContents) return
    const tab = runtimes.get(spaceId)?.tabs.get(tabId)
    if (!tab) return
    Menu.buildFromTemplate([
      tab.popout
        ? { label: 'Move Back to Main Window', click: () => returnTab(tab) }
        : { label: 'Move Tab to New Window', click: () => popoutTab(spaceId, tabId) },
      { label: 'Reload', click: () => tab.view.webContents.reload() },
      { type: 'separator' },
      { label: 'Close Tab', click: () => closeTab(spaceId, tabId) },
    ]).popup({ window: win })
  })
  ipcMain.on('popout:cmd', (e, cmd) => {
    const tab = popoutFromEvent(e)
    if (!tab) return
    const wc = tab.view.webContents
    if (cmd === 'back') wc.navigationHistory.goBack()
    else if (cmd === 'forward') wc.navigationHistory.goForward()
    else if (cmd === 'reload') (tab.loading ? wc.stop() : wc.reload())
    else if (cmd === 'zoom-reset') { wc.setZoomLevel(0); pushState() }
    else if (cmd === 'home') returnTab(tab)
    else if (cmd === 'ready') e.sender.send('popout:state', popoutState(tab))
  })
  ipcMain.on('popout:go', (e, text) => {
    const tab = popoutFromEvent(e)
    if (tab && text.trim()) tab.view.webContents.loadURL(normalizeUrl(text.trim())).catch(() => {})
  })
  ipcMain.on('nav:go', (_e, input) => {
    const tab = activeTab()
    const url = normalizeUrl(input)
    if (tab) tab.view.webContents.loadURL(url).catch(() => {})
    else createTab(store.state.activeSpaceId, { url })
  })
  ipcMain.on('nav:back', () => activeTab()?.view.webContents.navigationHistory.goBack())
  ipcMain.on('nav:forward', () => activeTab()?.view.webContents.navigationHistory.goForward())
  ipcMain.on('nav:reload', () => activeTab()?.view.webContents.reload())
  ipcMain.on('nav:zoom-reset', () => { activeTab()?.view.webContents.setZoomLevel(0); pushState() })
  ipcMain.on('nav:stop', () => activeTab()?.view.webContents.stop())

  ipcMain.on('settings:set', (_e, patch) => {
    Object.assign(store.state.settings, patch)
    store.save()
    pushState()
  })

  ipcMain.handle('ext:list', () => {
    const rt = runtimes.get(store.state.activeSpaceId)
    if (!rt) return []
    return exts(rt.session)
      .getAllExtensions()
      .filter((e) => e.manifest && !/^chrome-web-store/i.test(e.name))
      .map((e) => ({ id: e.id, name: e.name, version: e.version, path: e.path, description: e.manifest.description || '' }))
  })
  ipcMain.handle('ext:remove', async (_e, extId) => {
    const unpacked = store.state.settings.unpacked || []
    let removedFiles = false
    for (const rt of runtimes.values()) {
      const e = exts(rt.session)
      const ext = e.getExtension(extId)
      if (!ext) continue
      if (unpacked.includes(ext.path)) {
        store.state.settings.unpacked = unpacked.filter((p) => p !== ext.path)
        store.save()
        e.removeExtension(extId)
      } else if (!removedFiles) {
        await uninstallExtension(extId, { session: rt.session, extensionsPath: extensionsPath() }).catch(() => e.removeExtension(extId))
        removedFiles = true
      } else {
        e.removeExtension(extId)
      }
    }
    pushState()
  })
  ipcMain.handle('ext:load-unpacked', loadUnpackedDialog)
  ipcMain.handle('ext:update', async () => {
    for (const rt of runtimes.values()) await updateExtensions(rt.session).catch(() => {})
  })
}

async function importPasswordsDialog() {
  if (!vault.available()) {
    dialog.showErrorBox('Passwords', 'Secure storage (Keychain) is not available, so passwords cannot be saved safely.')
    return null
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose the passwords file you exported (CSV)',
    properties: ['openFile'],
    filters: [{ name: 'Passwords CSV', extensions: ['csv'] }],
  })
  if (canceled || !filePaths[0]) return null
  try {
    const res = vault.importCsv(fs.readFileSync(filePaths[0], 'utf8'))
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Move file to Trash', 'Keep file'],
      defaultId: 0,
      message: `Imported ${res.added} password${res.added === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} skipped)` : ''}.`,
      detail: 'They are now encrypted with your Keychain. The exported CSV file is NOT encrypted, so anyone who opens it can read your passwords. We recommend moving it to the Trash.',
    })
    if (response === 0) await shell.trashItem(filePaths[0]).catch(() => {})
    return res
  } catch (err) {
    dialog.showErrorBox('Import failed', err.message)
    return null
  }
}

async function loadUnpackedDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose an unpacked Chrome extension folder (the one with manifest.json)',
    properties: ['openDirectory'],
  })
  if (canceled || !filePaths[0]) return
  const dir = filePaths[0]
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    dialog.showErrorBox('Not an extension', 'That folder has no manifest.json.')
    return
  }
  const list = store.state.settings.unpacked || []
  if (!list.includes(dir)) store.state.settings.unpacked = [...list, dir]
  store.save()
  for (const rt of runtimes.values()) await loadUnpacked(rt.session)
  pushState()
}

// ---------------------------------------------------------------- menus

function showContextMenu(tab, params) {
  const wc = tab.view.webContents
  const items = []
  if (params.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => createTab(tab.spaceId, { url: params.linkURL, select: false }) },
      {
        label: 'Open link in another space',
        submenu: store.state.spaces
          .filter((s) => s.id !== tab.spaceId)
          .map((s) => ({ label: s.name, click: () => (activateSpace(s.id), createTab(s.id, { url: params.linkURL })) })),
      },
      { label: 'Copy link address', click: () => clipWriteText(params.linkURL) },
      { type: 'separator' }
    )
  }
  if (params.hasImageContents && params.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => createTab(tab.spaceId, { url: params.srcURL }) },
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { type: 'separator' }
    )
  }
  if ((params.mediaType === 'image' || params.mediaType === 'video') && params.srcURL && hostOf(tab.url) === 'web.whatsapp.com' && jtKey()) {
    items.push({ label: params.mediaType === 'video' ? 'Send video to JobTread job…' : 'Send picture to JobTread job…', click: () => wc.send('jt:photo', params.srcURL) }, { type: 'separator' })
  }
  if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
  else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' })

  // The built-in iMessage page only gets copy/paste (it has its own right-click menu for conversations).
  if (tab.internal) {
    while (items.length && items[items.length - 1].type === 'separator') items.pop()
    if (!items.length) return
    return Menu.buildFromTemplate(items).popup({ window: win })
  }

  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() }
  )

  const rt = runtimes.get(tab.spaceId)
  let extItems = []
  try {
    extItems = rt ? rt.extensions.getContextMenuItems(wc, params) : []
  } catch {}
  if (extItems.length) items.push({ type: 'separator' }, ...extItems)

  items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
  Menu.buildFromTemplate(items).popup({ window: win })
}

const CLIP_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4' }
// Electron's clipboard is the async ClipboardItem API (no writeText/writeImage).
function clipWriteText(text) {
  return clipboard.write([new ClipboardItem({ 'text/plain': String(text || '') })]).catch(() => {})
}
// Electron's clipboard is the async ClipboardItem API: walk every format on offer.
async function readClipboardFiles() {
  let items = []
  try {
    items = await clipboard.read()
  } catch {
    return []
  }
  const paths = new Set()
  const images = []
  const blobOf = async (it, t) => {
    const b = await it.getType(t)
    return typeof b === 'string' ? Buffer.from(b) : Buffer.from(await b.arrayBuffer())
  }
  for (const it of items) {
    for (const t of it.types || []) {
      const raw = (t.match(/format="([^"]+)"/) || [])[1] || ''
      try {
        if (t === 'text/uri-list' || /file-url|NSFilenamesPboardType|FileURL/i.test(raw)) {
          const txt = (await blobOf(it, t)).toString('utf8')
          for (const m of txt.matchAll(/file:\/\/[^\s<"]+/g)) paths.add(fileURLToPath(m[0]))
          for (const m of txt.matchAll(/<string>(\/[^<]+)<\/string>/g)) paths.add(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"'))
        } else if (/^image\/(png|jpeg|gif|webp)$/.test(t)) {
          images.push({ type: t, bytes: await blobOf(it, t) })
        } else if (/^public\.(png|jpeg|tiff)$|^image\/tiff$|^TIFF$|NSTIFFPboardType/.test(raw || t)) {
          const img = nativeImage.createFromBuffer(await blobOf(it, t))
          if (!img.isEmpty()) images.push({ type: 'image/png', bytes: img.toPNG() })
        }
      } catch {}
    }
  }
  const out = []
  for (const p of paths) {
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size > 100 * 1024 * 1024) continue
      const name = path.basename(p)
      out.push({ name, type: CLIP_MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream', bytes: fs.readFileSync(p) })
    } catch {}
  }
  if (!out.length && images.length) {
    const best = images.find((x) => x.type === 'image/png') || images[0]
    out.push({ name: `pasted-${Date.now()}.${best.type.split('/')[1].replace('jpeg', 'jpg')}`, type: best.type, bytes: best.bytes })
  }
  return out
}

const secretbox = require('./secretbox.js')
// Reads a stored key; entries saved by older versions (Keychain) are re-saved with the local key.
function migrateSecret(slot) {
  const e = store.state.settings[slot]
  if (!e || !e.key) return ''
  const v = secretbox.open(e)
  if (v && e.enc !== 'local') {
    const { key, enc, ...rest } = e
    store.state.settings[slot] = secretbox.pack(v, rest)
    store.save()
  }
  return v
}
// ---------------------------------------------------------------- JobTread (Save contact → also add the customer)
function jtKey() {
  return migrateSecret('jobtread')
}
function jtStatus() {
  const j = store.state.settings.jobtread || {}
  return { connected: !!jtKey(), org: j.org || '', on: j.on !== false }
}
async function jtSetKey(key) {
  key = String(key || '').trim()
  if (!key) {
    delete store.state.settings.jobtread
    store.save()
    return jtStatus()
  }
  const org = await jobtread.whoAmI(key)
  store.state.settings.jobtread = secretbox.pack(key, { org: org.name || '', on: true })
  store.save()
  return jtStatus()
}
async function jtAdd(c) {
  const key = jtKey()
  if (!key) throw new Error('JobTread is not connected yet.')
  const clean = {}
  for (const k of ['first', 'company', 'phone', 'email', 'street', 'city', 'state', 'zip', 'note']) clean[k] = String((c && c[k]) || '').trim().slice(0, 500)
  return jobtread.addCustomer(key, clean)
}

// ---------------------------------------------------------------- reminders + scheduled iMessages
// Both run while the browser is open (if it was closed at the time, they fire when it opens again).
const reminders = () => (store.state.settings.reminders = store.state.settings.reminders || [])
const scheduled = () => (store.state.settings.scheduled = store.state.settings.scheduled || [])
// ---------------------------------------------------------------- iMessage chats linked to JobTread jobs
// settings.jtLinks: chat guid -> { jobId, jobName, jobNumber, status, accountId, auto, autoPhotos, photosSince, sentAtt }
const jtLinks = () => (store.state.settings.jtLinks = store.state.settings.jtLinks || {})
const jtLookedUp = new Map() // chat guid -> time we last looked it up (so we don't ask JobTread again and again)
let jtLookupBusy = false
// For the Unread list: find the customer of chats we haven't linked yet, a few at a time, and link
// the job when the customer has exactly one open job.
async function jtAutoLink(chats) {
  const key = jtKey()
  if (!key || jtLookupBusy) return
  const todo = chats.filter((c) => !c.group && !jtLinks()[c.guid] && Date.now() - (jtLookedUp.get(c.guid) || 0) > 6 * 3600e3).slice(0, 3)
  if (!todo.length) return
  jtLookupBusy = true
  try {
    for (const c of todo) {
      jtLookedUp.set(c.guid, Date.now())
      try {
        const raw = c.rawHandle || c.handle || ''
        const d = await jobtread.findCustomer(key, { phone: /@/.test(raw) ? '' : raw, email: /@/.test(raw) ? raw : '', name: c.saved ? c.title : '' })
        const open = d ? d.jobs.filter((j) => !j.closed) : []
        if (open.length === 1 && !jtLinks()[c.guid]) {
          const j = open[0]
          jtLinks()[c.guid] = { jobId: j.id, jobName: j.name, jobNumber: String(j.number || ''), status: j.status || '', accountId: d.id, auto: true, autoPhotos: false, photosSince: 0, sentAtt: [] }
          store.save()
        }
      } catch {}
    }
  } finally {
    jtLookupBusy = false
  }
}
const jobLabel = (L) => (L ? `${L.jobNumber ? '#' + L.jobNumber + ' ' : ''}${L.jobName}` : '')

// "Send every photo from this chat to the job": checks linked chats for new pictures every 30 s.
let photoBusy = false
async function jtAutoPhotos() {
  const key = jtKey()
  const links = Object.entries(jtLinks()).filter(([, L]) => L.autoPhotos && L.jobId)
  if (!key || !links.length || photoBusy || process.platform !== 'darwin' && !process.env.MULTISPACE_TEST_CHATDB) return
  photoBusy = true
  try {
    const chats = await imessage.listChats(60)
    for (const [guid, L] of links) {
      const c = chats.find((x) => x.guid === guid)
      if (!c || c.date <= (L.photosSince || 0)) continue
      const msgs = await imessage.listMessages(c.id, 40)
      for (const m of msgs) {
        if (m.date <= (L.photosSince || 0)) continue
        for (const a of m.attachments || []) {
          if (!/^image\//.test(a.mime) || (L.sentAtt || []).includes(a.id)) continue
          try {
            const f = await imessage.attachmentFile(a.id)
            const name = String(a.name || path.basename(f.file)).replace(/\.(heic|heif|tiff?)$/i, '.jpg')
            await jobtread.uploadFile(key, { targetType: 'job', targetId: L.jobId, name, mime: f.mime, bytes: fs.readFileSync(f.file) })
            L.sentAtt = [...(L.sentAtt || []), a.id].slice(-300)
            store.save()
          } catch {}
        }
      }
    }
  } catch {
  } finally {
    photoBusy = false
  }
}
setInterval(() => jtAutoPhotos().catch(() => {}), 30 * 1000)

const todos = () => (store.state.settings.todos = store.state.settings.todos || [])
const isInternalSender = (e) => !!(findTabByWebContents(e.sender) || {}).internal
function showTasks() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  for (const sp of store.state.spaces) {
    const a = sp.apps.find((x) => x.url === TASKS_URL)
    if (a) return openApp(sp.id, a.id)
  }
  // Removed it from the sidebar? Put it back.
  const sp = store.state.spaces.find((x) => x.id === store.state.activeSpaceId) || store.state.spaces[0]
  if (!sp) return
  const a = store.addApp(sp.id, CATALOG.find((x) => x.url === TASKS_URL))
  store.save()
  pushState()
  openApp(sp.id, a.id)
}
// Settings: the JobTread and AI keys live in the Tasks app, under Connections.
function showConnections() { showTasksAnd('tasks:show-conn') }
function showTasksAnd(channel, ...args) {
  showTasks()
  for (const rt of runtimes.values())
    for (const t of rt.tabs.values())
      if (t.url === TASKS_URL) {
        const send = () => t.view.webContents.send(channel, ...args)
        if (t.view.webContents.isLoading()) t.view.webContents.once('did-finish-load', () => setTimeout(send, 300))
        else send()
      }
}
ipcMain.handle('settings:open', (e) => { if (qrAllowed(e)) showConnections() })
// ---- "Today": the summary of your day
function showToday() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  for (const sp of store.state.spaces) {
    const a = sp.apps.find((x) => x.url === TODAY_URL)
    if (a) {
      openApp(sp.id, a.id)
      for (const t of getRuntime(sp.id).tabs.values()) if (t.appId === a.id && !t.view.webContents.isLoading()) t.view.webContents.send('today:refresh')
      return
    }
  }
  const sp = store.state.spaces.find((x) => x.id === store.state.activeSpaceId) || store.state.spaces[0]
  if (!sp) return
  const a = store.addApp(sp.id, CATALOG.find((x) => x.url === TODAY_URL))
  sp.apps.splice(sp.apps.indexOf(a), 1)
  sp.apps.unshift(a)
  store.save()
  pushState()
  openApp(sp.id, a.id)
}
// Open Tasks and ask it to open one item there (the "Text" box for a follow-up, "On my way" for a visit).
ipcMain.on('today:open-tasks', (e, what, id) => {
  if (!isInternalSender(e)) return
  if (what === 'followup' || what === 'omw') showTasksAnd('tasks:open-item', what, String(id || ''))
  else showTasks()
})
// Unread Gmail: Google's unread-inbox feed, read with each space's own Gmail sign-in (no extra login).
let gmailCache = null
function gmailSpaces() {
  const out = []
  for (const sp of store.state.spaces) {
    const app = sp.apps.find((a) => hostOf(a.url) === 'mail.google.com')
    const rt = runtimes.get(sp.id)
    const tab = rt && [...rt.tabs.values()].find((t) => hostOf(t.url) === 'mail.google.com')
    if (app || tab) out.push({ sp, app, tab })
  }
  return out
}
const xmlText = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim()
function parseGmailFeed(xml) {
  const tag = (s, n) => { const m = s.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return m ? xmlText(m[1]) : '' }
  const head = xml.split('<entry>')[0]
  const emails = xml.split('<entry>').slice(1).map((en) => {
    const link = (en.match(/<link[^>]*href="([^"]+)"/) || [])[1] || ''
    const mid = (xmlText(link).match(/message_id=([0-9a-f]+)/i) || [])[1] || ''
    const author = (en.match(/<author>([\s\S]*?)<\/author>/) || [])[1] || ''
    return { id: mid || tag(en, 'id'), messageId: mid, subject: tag(en, 'title') || '(no subject)', preview: tag(en, 'summary'), from: tag(author, 'name') || tag(author, 'email'), email: tag(author, 'email'), date: Date.parse(tag(en, 'issued') || tag(en, 'modified')) || 0 }
  })
  return { account: (tag(head, 'title').match(/[^\s]+@[^\s]+/) || [''])[0], count: Number(tag(head, 'fullcount')) || emails.length, emails }
}
ipcMain.handle('today:gmail', async (e, fresh) => {
  if (!isInternalSender(e)) return []
  if (!fresh && gmailCache && Date.now() - gmailCache.at < 90e3) return gmailCache.data
  const data = await Promise.all(gmailSpaces().map(async ({ sp, app, tab }) => {
    const base = { spaceId: sp.id, space: sp.name, appId: app ? app.id : null, tabId: tab ? tab.id : null }
    try {
      const rt = getRuntime(sp.id)
      const res = await rt.session.fetch('https://mail.google.com/mail/u/0/feed/atom', { credentials: 'include', redirect: 'manual' })
      if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) return { ...base, state: 'signed-out', count: 0, emails: [] }
      if (!res.ok) return { ...base, state: 'error', count: 0, emails: [] }
      const xml = await res.text()
      if (!/<feed/.test(xml)) return { ...base, state: 'signed-out', count: 0, emails: [] }
      return { ...base, state: 'ok', ...parseGmailFeed(xml) }
    } catch {
      return { ...base, state: 'error', count: 0, emails: [] }
    }
  }))
  gmailCache = { at: Date.now(), data }
  return data
})
ipcMain.handle('today:open-gmail', (e, spaceId, messageId) => {
  if (!isInternalSender(e)) return
  const g = gmailSpaces().find((x) => x.sp.id === String(spaceId))
  if (!g) return
  const mid = /^[0-9a-f]{6,24}$/i.test(String(messageId || '')) ? String(messageId) : ''
  const url = 'https://mail.google.com/mail/u/0/#inbox' + (mid ? '/' + mid : '')
  const rt = getRuntime(g.sp.id)
  if (store.state.activeSpaceId !== g.sp.id) activateSpace(g.sp.id)
  let t = g.app ? [...rt.tabs.values()].find((x) => x.appId === g.app.id) : g.tab
  if (!t) return createTab(g.sp.id, { url, appId: g.app ? g.app.id : null })
  selectTab(g.sp.id, t.id)
  if (t.sleeping) { t.url = url; wakeTab(t) } else t.view.webContents.loadURL(url).catch(() => {})
})
function fireTodo(t) {
  playAlertSound()
  if (!Notification.isSupported()) return
  const n = new Notification({ title: 'To-do due', body: t.text, silent: true })
  n.on('click', showTasks)
  n.show()
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
function notifyPages(channel, data) {
  for (const rt of runtimes.values())
    for (const t of rt.tabs.values()) if (!t.view.webContents.isDestroyed() && (t.internal || hostOf(t.url) === 'web.whatsapp.com')) t.view.webContents.send(channel, data)
}
function openWhatsAppChat(name) {
  for (const sp of store.state.spaces) {
    const rt = runtimes.get(sp.id)
    const t = rt && [...rt.tabs.values()].find((x) => hostOf(x.url) === 'web.whatsapp.com')
    if (t) {
      if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
      openUnified({ kind: 'wa', spaceId: sp.id, tabId: t.id, name })
      return
    }
  }
}
function fireReminder(r) {
  playAlertSound()
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `Reply to ${r.title || 'this conversation'}`, body: r.note || (r.kind === 'wa' ? 'WhatsApp reminder' : 'iMessage reminder'), silent: true })
  n.on('click', () => (r.kind === 'wa' ? openWhatsAppChat(r.name) : showImessageChat(r.guid)))
  n.show()
}
let schedBusy = false
async function tickTimers() {
  const now = Date.now()
  const due = reminders().filter((r) => r.at <= now)
  if (due.length) {
    store.state.settings.reminders = reminders().filter((r) => r.at > now)
    store.save()
    due.forEach(fireReminder)
    notifyPages('timers:changed', timersState())
  }
  const dueTodos = todos().filter((t) => !t.done && t.due && t.due <= now && !t.notified)
  if (dueTodos.length) {
    dueTodos.forEach((t) => { t.notified = true; fireTodo(t) })
    store.save()
    notifyPages('todos:changed', todos())
  }
  if (schedBusy) return
  const send = scheduled().filter((m) => m.at <= now && !m.failed)
  if (!send.length) return
  schedBusy = true
  try {
    for (const m of send) {
      try {
        if (m.guid) await imessage.sendToChat(m.guid, m.text)
        else await imessage.sendToHandle(m.handle, m.text)
        store.state.settings.scheduled = scheduled().filter((x) => x.id !== m.id)
      } catch (e) {
        m.failed = String(e.message || e).slice(0, 200)
        if (Notification.isSupported()) new Notification({ title: `Scheduled message to ${m.title || 'contact'} not sent`, body: m.failed }).show()
      }
      store.save()
    }
    notifyPages('timers:changed', timersState())
  } finally {
    schedBusy = false
  }
}
const timersState = () => ({ reminders: reminders(), scheduled: scheduled() })
setInterval(() => tickTimers().catch(() => {}), 20 * 1000)

// ---------------------------------------------------------------- dictation (macOS) + AI reply suggestion
// Dictation uses the Mac's own Dictation (no extra memory). The AI suggestion asks Claude for a short
// reply, using an Anthropic API key the user pastes once (stored encrypted).
function secretGet(slot) {
  return migrateSecret(slot)
}
function secretSet(slot, value, extra = {}) {
  if (!value) {
    delete store.state.settings[slot]
  } else {
    store.state.settings[slot] = secretbox.pack(value, extra)
  }
  store.save()
}
const AI_API = process.env.MULTISPACE_TEST_AI_API || 'https://api.anthropic.com/v1/messages'
const AI_MODEL = 'claude-haiku-5-5'
async function aiCall(key, system, content, maxTokens = 400) {
  const res = await net.fetch(AI_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`
    throw new Error(res.status === 401 ? 'The Claude API key was not accepted. Make a new one at console.anthropic.com and paste it again.' : 'Claude: ' + msg)
  }
  return ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
}
async function aiSuggest({ name, messages, draft }) {
  const key = secretGet('ai')
  if (!key) throw new Error('NO_KEY')
  const convo = (Array.isArray(messages) ? messages : []).slice(-25)
    .map((m) => `${m.fromMe ? 'Me (Master Touch Pools)' : name || 'Customer'}: ${String(m.text || '').slice(0, 1500)}`)
    .filter((l) => !/:\s*$/.test(l))
    .join('\n')
  const system =
    'You write text-message replies for Master Touch Pools, a pool construction and service company in Florida. ' +
    "Write the next message from \"Me\". Use the same language as the customer's latest message (English, Portuguese or Spanish). " +
    'Be friendly, professional and short (1 to 3 sentences), like a real business owner texting. Never invent prices, dates or promises that are not in the conversation. ' +
    'Do not use placeholders like [name]. Output only the message text.'
  const content = `Conversation with ${name || 'a customer'}:\n${convo || '(no messages yet)'}\n\n${draft ? `My draft so far (improve it, keep my meaning): ${String(draft).slice(0, 1500)}\n\n` : ''}Write my reply.`
  return aiCall(key, system, content)
}

// ---------------------------------------------------------------- quick replies (iMessage + WhatsApp)
const DEFAULT_QUICK_REPLIES = [
  { title: 'On my way', text: "Hi {name}! I'm on my way, I'll be there in about 20 minutes." },
  { title: 'Running late', text: "Hi {name}, sorry, I'm running about 15 minutes late. See you soon!" },
  { title: 'Estimate sent', text: 'Hi {name}! I just sent your estimate. Let me know if you have any questions.' },
  { title: 'Ask for details', text: 'Could you please send me your full name, address and email?' },
  { title: 'Thank you', text: 'Thank you for choosing Master Touch Pools! 🙏' },
  { title: 'Ask for a review', text: "If you're happy with our work, a quick Google review would mean a lot to us. Thank you!" },
]
const quickReplies = () => (Array.isArray(store.state.settings.quickReplies) ? store.state.settings.quickReplies : DEFAULT_QUICK_REPLIES)
function qrAllowed(e) {
  const tab = findTabByWebContents(e.sender)
  if (tab && tab.internal) return true
  let h = ''
  try { h = new URL(e.senderFrame ? e.senderFrame.url : e.sender.getURL()).hostname } catch {}
  return (h === 'web.whatsapp.com' || h === 'mail.google.com' || /(^|\.)(quo\.com|openphone\.com)$/.test(h)) && !(e.senderFrame && e.senderFrame.parent)
}
function notifyQuickReplies() {
  for (const rt of runtimes.values())
    for (const t of rt.tabs.values()) {
      if (t.view.webContents.isDestroyed()) continue
      if (t.internal || hostOf(t.url) === 'web.whatsapp.com') t.view.webContents.send('qr:changed', quickReplies())
    }
}

// ---------------------------------------------------------------- one "Unread" view
// iMessage (from the Messages database), WhatsApp (read from its chat list) and every other
// app's unread count (Quo, Gmail, Slack… from the number in its tab title), in one list.
const waUnread = new Map() // webContents id -> { spaceId, tabId, list }
function imsgIsUnread(c, p) {
  if (p.manualUnread?.[c.guid]) return true
  if (!c.unread || c.lastFromMe) return false
  return !(p.readUpTo?.[c.guid] >= c.date)
}
async function unifiedList() {
  const items = []
  const unreadChats = []
  let imsgState = 'off'
  if (process.platform === 'darwin' || process.env.MULTISPACE_TEST_CHATDB) {
    try {
      const st = await imessage.status()
      if (st.ok) {
        imsgState = 'ok'
        const p = store.state.settings.imsg || {}
        for (const c of await imessage.listChats(120)) {
          if (p.hidden?.[c.guid] >= c.date || !imsgIsUnread(c, p)) continue
          items.push({ kind: 'imsg', key: 'i:' + c.guid, guid: c.guid, chatId: c.id, name: c.title || c.handle, preview: c.last, count: c.unread || 0, date: c.date, job: jobLabel(jtLinks()[c.guid]), jobUrl: jtLinks()[c.guid] ? `https://app.jobtread.com/jobs/${jtLinks()[c.guid].jobId}` : '' })
          unreadChats.push(c)
        }
        jtAutoLink(unreadChats).catch(() => {})
      } else imsgState = 'no-access'
    } catch {
      imsgState = 'error'
    }
  }
  const apps = []
  let waOpen = false
  for (const sp of store.state.spaces) {
    const rt = runtimes.get(sp.id)
    if (!rt) continue
    for (const t of rt.tabs.values()) {
      if (t.internal || t.view.webContents.isDestroyed()) continue
      const host = hostOf(t.url)
      const app = t.appId ? sp.apps.find((a) => a.id === t.appId) : null
      if (host === 'web.whatsapp.com') {
        waOpen = true
        const w = waUnread.get(t.view.webContents.id)
        for (const c of (w && w.list) || [])
          items.push({ kind: 'wa', key: `w:${t.id}:${c.name}`, spaceId: sp.id, tabId: t.id, name: c.name, preview: c.preview, count: c.count, time: c.time, space: sp.name, job: jobLabel(jtLinks()['wa:' + c.name]) })
        continue
      }
      if (t.badge) apps.push({ kind: 'app', key: `a:${t.id}`, spaceId: sp.id, tabId: t.id, name: app ? app.name : String(t.title || host).replace(/^\s*[*•]\s*/, '').replace(/\(\d+\+?\)\s*/, '').trim() || host, count: t.badge, space: sp.name, favicon: t.favicon || (app && app.icon) || null })
    }
  }
  items.sort((a, b) => (b.date || 0) - (a.date || 0))
  return { items: items.concat(apps), imsgState, waOpen, multiSpace: store.state.spaces.length > 1 }
}
function openUnified(it) {
  if (!it || typeof it !== 'object') return
  if (it.kind === 'imsg') return showImessageChat(String(it.guid || ''))
  const rt = runtimes.get(String(it.spaceId))
  const t = rt && rt.tabs.get(Number(it.tabId))
  if (!t) return
  if (store.state.activeSpaceId !== t.spaceId) activateSpace(t.spaceId)
  selectTab(t.spaceId, t.id)
  if (it.kind === 'wa') t.view.webContents.send('wa:open-chat', String(it.name || ''))
}

// ---------------------------------------------------------------- new iMessage alerts
// Watches Messages in the background (even when the iMessage app isn't open) and
// plays a sound and/or shows a Mac notification for each new incoming message.
const imsgAlertDefaults = { sound: true, banner: true }
const imsgAlerts = () => ({ ...imsgAlertDefaults, ...(store.state.settings.imsgAlerts || {}) })
function setImsgAlerts(patch) {
  store.state.settings.imsgAlerts = { ...imsgAlerts(), ...patch }
  store.save()
  buildAppMenu()
  for (const rt of runtimes.values())
    for (const t of rt.tabs.values()) if (t.url === IMESSAGE_URL) t.view.webContents.send('imsg:alerts-changed', imsgAlerts())
}
function playAlertSound() {
  if (process.platform === 'darwin') {
    require('child_process').execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {})
  } else shell.beep()
}
function findImessageApp() {
  for (const sp of store.state.spaces) {
    const a = sp.apps.find((x) => x.url === IMESSAGE_URL)
    if (a) return { spaceId: sp.id, appId: a.id }
  }
  return null
}
function showImessageChat(guid) {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  const where = findImessageApp()
  if (!where) return
  openApp(where.spaceId, where.appId)
  const t = [...getRuntime(where.spaceId).tabs.values()].find((x) => x.appId === where.appId)
  if (!t) return
  const send = () => t.view.webContents.send('imsg:open-chat', guid)
  if (t.view.webContents.isLoading()) t.view.webContents.once('did-finish-load', () => setTimeout(send, 800))
  else send()
}
// Are you already looking at this conversation? Then no alert.
let imsgOpenChat = null
const imsgSeen = new Map() // chat guid -> date of the newest message we know about
let imsgWatchReady = false
async function checkNewImessages() {
  const cfg = imsgAlerts()
  if (!cfg.sound && !cfg.banner) return
  let chats
  try {
    chats = await imessage.listChats(40)
  } catch {
    return
  }
  const fresh = []
  for (const c of chats) {
    const before = imsgSeen.get(c.guid)
    imsgSeen.set(c.guid, c.date)
    if (!imsgWatchReady || c.lastFromMe) continue
    if (before != null && c.date <= before) continue
    if (before == null && Date.now() - c.date > 60000) continue
    const hidden = store.state.settings.imsg?.hidden?.[c.guid]
    if (hidden && hidden >= c.date) continue
    const t = activeTab()
    if (win && win.isFocused() && t && t.url === IMESSAGE_URL && imsgOpenChat === c.guid) continue
    fresh.push(c)
  }
  imsgWatchReady = true
  if (!fresh.length) return
  if (cfg.sound) playAlertSound()
  if (cfg.banner && Notification.isSupported()) {
    for (const c of fresh.slice(0, 3)) {
      const n = new Notification({ title: c.title || c.handle || 'New message', body: String(c.last || '').slice(0, 200), silent: true })
      n.on('click', () => showImessageChat(c.guid))
      n.show()
    }
  }
}
async function startImessageWatcher() {
  if (process.platform !== 'darwin') return
  try {
    const st = await imessage.status()
    if (!st.ok) return setTimeout(startImessageWatcher, 60000) // e.g. Full Disk Access not given yet
  } catch {
    return
  }
  await checkNewImessages()
  setInterval(checkNewImessages, 5000)
}

function claudeControlCtx() {
  return {
    userData: app.getPath('userData'),
    runtimes,
    activeSpaceId: () => store.state.activeSpaceId,
    openUrl: (spaceId, url) => createTab(spaceId, { url }).id,
    selectTab,
  }
}
if (process.env.MULTISPACE_TEST_CONTROL) app.whenReady().then(() => setTimeout(() => control.start(claudeControlCtx()), 2500))
async function toggleClaudeControl() {
  try {
    if (control.isOn()) control.stop()
    else {
      const r = await control.start(claudeControlCtx())
      dialog.showMessageBox(win, { type: 'info', message: 'Claude can now control this browser', detail: `Only on this Mac, only until you switch it off or quit ${DISPLAY_NAME}. Claude can open pages, read them and click in your websites (not the iMessage, Unread or Tasks pages).\n\nIt turns itself off when you quit.` })
    }
  } catch (e) {
    dialog.showErrorBox('Could not change this setting', e.message)
  }
  buildAppMenu()
}

// Experimental: showing the conversation in the Messages app (hidden, in the background) is the only way to make
// Messages itself, and so the iPhone, count it as read. Off unless you turn it on in the Messages menu.
const markedInMessages = new Map()
function markInMessagesApp(guid) {
  if (process.platform !== 'darwin' || !store.state.settings.imsgMarkInMessages) return false
  const parts = String(guid || '').split(';')
  const h = parts[parts.length - 1]
  if (parts[1] !== '-' || !/^(\+?\d{7,15}|[^\s@;]+@[^\s@;]+\.[^\s@;]+)$/.test(h)) return false // one-to-one chats only
  if (Date.now() - (markedInMessages.get(h) || 0) < 60e3) return false
  markedInMessages.set(h, Date.now())
  require('child_process').execFile('/usr/bin/open', ['-g', '-j', `imessage://${encodeURI(h)}`], () => {})
  return true
}

function buildAppMenu() {
  const send = (channel, ...args) => () => win && win.webContents.send(channel, ...args)
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [
          {
            label: DISPLAY_NAME,
            submenu: [
              { role: 'about', label: `About ${DISPLAY_NAME}` },
              { label: 'Check for Updates…', click: () => updater.check({ manual: true }) },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: showConnections },
              { label: 'Search JobTread…', accelerator: 'CmdOrCtrl+K', click: () => showTasksAnd('tasks:search') },
              { label: 'Today: Summary of My Day', accelerator: 'CmdOrCtrl+Shift+T', click: showToday },
              { label: 'Appearance', submenu: [['system', 'Match My Mac'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => ({ label: l, type: 'radio', checked: (store.state.settings.theme || 'system') === v, click: () => { store.state.settings.theme = v; store.save(); nativeTheme.themeSource = v } })) },
              { label: 'Let Claude Control This Browser', type: 'checkbox', checked: control.isOn(), click: toggleClaudeControl },
              { label: 'Export Team Setup…', click: () => teamExportFn && teamExportFn().then((r) => r && dialog.showMessageBox(win, { message: 'Team setup saved', detail: `${r.apps} apps and ${r.quickReplies} quick replies were saved to:\n${r.file}\n\nSend this file to your team. No keys or passwords are in it.` })).catch((err) => dialog.showErrorBox('Export failed', err.message)) },
              { label: 'Import Team Setup…', click: () => teamImportFn && teamImportFn().then((r) => r && dialog.showMessageBox(win, { message: 'Team setup imported', detail: `${r.added} apps added and ${r.quickReplies} quick replies imported.` })).catch((err) => dialog.showErrorBox('Import failed', err.message)) },
              {
                label: 'Show Today When I Start',
                type: 'checkbox',
                checked: store.state.settings.morningSummary !== false,
                click: (mi) => { store.state.settings.morningSummary = mi.checked; store.save() },
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${DISPLAY_NAME}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${DISPLAY_NAME}` },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('ui:new-tab') },
        { label: 'New Space…', accelerator: 'CmdOrCtrl+Shift+N', click: send('ui:new-space') },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const t = activeTab()
            // Apps aren't tabs: Cmd+W never closes them (WhatsApp etc. stay loaded and signed in).
            if (t && !t.appId) closeTab(t.spaceId, t.id)
          },
        },
        { type: 'separator' },
        { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: send('ui:focus-address') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => activeTab()?.view.webContents.reload() },
        { label: 'Toggle Apps Panel', accelerator: 'CmdOrCtrl+B', click: send('ui:toggle-apps') },
        { label: 'Apps Panel: Icons Only / Full', accelerator: 'CmdOrCtrl+Shift+B', click: send('ui:toggle-compact') },
        {
          label: 'Save Memory (sleep apps unused for 30 min)',
          type: 'checkbox',
          checked: memorySaverOn(),
          click: (m) => {
            store.state.settings.memorySaver = m.checked
            store.save()
          },
        },
        {
          label: 'Developer Tools (page)',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => activeTab()?.view.webContents.toggleDevTools(),
        },
        { label: 'Developer Tools (browser UI)', click: () => win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => { activeTab()?.view.webContents.setZoomLevel(0); pushState() } },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => activeTab()?.view.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => activeTab()?.view.webContents.navigationHistory.goForward() },
      ],
    },
    {
      label: 'Spaces',
      submenu: Array.from({ length: 9 }, (_, i) => ({
        label: `Go to Space ${i + 1}`,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => {
          const s = store.state.spaces[i]
          if (s) activateSpace(s.id)
        },
      })),
    },
    {
      label: 'Passwords',
      submenu: [
        { label: 'Manage Passwords…', click: send('ui:passwords') },
        { label: 'Import Passwords from Chrome / Shift (CSV)…', click: importPasswordsDialog },
      ],
    },
    {
      label: 'Extensions',
      submenu: [
        { label: 'Manage Extensions…', click: send('ui:extensions') },
        { label: 'Open Chrome Web Store', click: () => createTab(store.state.activeSpaceId, { url: 'https://chromewebstore.google.com/' }) },
        { label: 'Load Unpacked Extension…', click: loadUnpackedDialog },
        { type: 'separator' },
        {
          label: 'Copy Extension Error Log',
          click: () => {
            clipWriteText(extLog.length ? extLog.join('\n') : '(no extension messages yet)')
            dialog.showMessageBox(win, { message: 'Copied the extension log.', detail: 'Paste it (Cmd+V) in the chat with Claude.' })
          },
        },
        { label: 'Inspect Side Panel', enabled: true, click: () => sidePanel && sidePanel.view.webContents.openDevTools({ mode: 'detach' }) },
      ],
    },
    {
      label: 'Messages',
      submenu: [
        { label: 'Sound for New iMessages', type: 'checkbox', checked: imsgAlerts().sound, click: (m) => setImsgAlerts({ sound: m.checked }) },
        { label: 'Notification for New iMessages', type: 'checkbox', checked: imsgAlerts().banner, click: (m) => setImsgAlerts({ banner: m.checked }) },
        { type: 'separator' },
        { label: '(Experimental) Also Mark as Read in the Messages App', type: 'checkbox', checked: !!store.state.settings.imsgMarkInMessages, click: (m) => { store.state.settings.imsgMarkInMessages = m.checked; store.save() } },
        { label: 'Play Test Sound', click: playAlertSound },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]
function zoom(delta) {
  const wc = activeTab()?.view.webContents
  if (!wc) return
  const cur = 100 * Math.pow(1.2, wc.getZoomLevel())
  let i = ZOOM_STEPS.findIndex((z) => z >= cur - 0.5)
  if (i < 0) i = ZOOM_STEPS.length - 1
  if (delta > 0 && ZOOM_STEPS[i] <= cur + 0.5) i++
  else if (delta < 0) i--
  i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i))
  wc.setZoomLevel(Math.log(ZOOM_STEPS[i] / 100) / Math.log(1.2))
  pushState()
}

// ---------------------------------------------------------------- startup

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, 'ui', 'icon.png'),
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: DISPLAY_NAME,
    backgroundColor: '#eceef2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 24, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the UI preload needs require() for the extension toolbar component
    },
  })
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.on('closed', () => (win = null))
  win.webContents.once('did-finish-load', () => activateSpace(store.state.activeSpaceId))
}

// ---------------------------------------------------------------- keeping logins (WhatsApp etc.)
// Only one copy of the browser may use the saved profile at a time. A second copy (for example
// running `npm start` again while it's already open) can't open the login storage and makes sites
// like WhatsApp Web think you're signed out. So a second launch just focuses the open window.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

// Write cookies, IndexedDB and localStorage to disk now, not "eventually".
// WhatsApp Web keeps its login keys in IndexedDB; if the browser is killed before they are
// written (closing the Terminal window, Ctrl+C, a crash, the Mac restarting), it logs out.
async function flushAllSessions() {
  const jobs = []
  for (const rt of runtimes.values()) {
    try {
      rt.session.flushStorageData()
    } catch {}
    jobs.push(rt.session.cookies.flushStore().catch(() => {}))
  }
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 3000))])
}
setInterval(() => flushAllSessions(), 30 * 1000).unref?.()

let quitting = false
function quitGracefully() {
  if (quitting) return
  quitting = true
  try {
    for (const rt of runtimes.values()) persistTabs(rt.spaceId)
    store && store.saveNow()
  } catch {}
  flushAllSessions().finally(() => app.exit(0))
}
// Ctrl+C or closing the Terminal window: save everything before exiting.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, quitGracefully)
// A bug in one feature should never pop up an error box or stop the browser; log it instead.
process.on('uncaughtException', (err) => console.error('[error]', err))
process.on('unhandledRejection', (err) => console.error('[error]', err))

// Used by the release build: start the real app, then quit with code 0 if it got this far (a launch crash gives a non-zero exit).
if (process.env.MULTISPACE_SMOKE) app.whenReady().then(() => setTimeout(() => app.exit(0), 8000))
app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, 'ui', 'icon.png')) } catch {}
  }
  store = new Store(app.getPath('userData'))
  nativeTheme.themeSource = store.state.settings.theme || 'system'
  vault = new PasswordVault(app.getPath('userData'))
  // Lets the extension toolbar in the browser UI show extension icons.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  registerIpc()
  // Photos from your Messages, served only to the built-in iMessage page as imsg-att://file/<id>
  imessage.setCacheDir(path.join(app.getPath('userData'), 'imessage-cache'))
  session.fromPartition('internal-pages').protocol.handle('imsg-att', async (req) => {
    try {
      const id = Number(new URL(req.url).pathname.replace(/\D/g, ''))
      const { file, mime } = await imessage.attachmentFile(id)
      const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers })
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  buildAppMenu()
  createWindow()
  // Start every space's session in the background so extensions and notifications are ready.
  store.state.spaces.forEach((s) => getRuntime(s.id))
  setTimeout(startImessageWatcher, 3000)
  updater.start(() => win)
  // "Today": every time you open the browser, start on the summary of your day
  // (unread messages, visits, tasks and follow-ups). Turn off in the CheckMate menu.
  if (!store.state.settings.todayAppAdded) {
    store.state.settings.todayAppAdded = true
    const sp = store.state.spaces.find((x) => x.id === store.state.activeSpaceId) || store.state.spaces[0]
    if (sp && !sp.apps.some((a) => a.url === TODAY_URL)) {
      const a = store.addApp(sp.id, CATALOG.find((x) => x.url === TODAY_URL))
      sp.apps.splice(sp.apps.indexOf(a), 1)
      sp.apps.unshift(a)
      store.save()
      pushState()
    }
  }
  if (store.state.settings.morningSummary !== false) setTimeout(showToday, 1500)
  if (!store.state.settings.tasksAppAdded) {
    store.state.settings.tasksAppAdded = true
    const sp = store.state.spaces.find((x) => x.id === store.state.activeSpaceId) || store.state.spaces[0]
    if (sp && !sp.apps.some((a) => a.url === TASKS_URL)) {
      const a = store.addApp(sp.id, CATALOG.find((x) => x.url === TASKS_URL))
      sp.apps.splice(sp.apps.indexOf(a), 1)
      const at = sp.apps.findIndex((x) => x.url === INBOX_URL)
      sp.apps.splice(at + 1, 0, a)
      store.save()
      pushState()
    }
  }
  if (!store.state.settings.unreadAppAdded) {
    store.state.settings.unreadAppAdded = true
    const sp = store.state.spaces.find((x) => x.id === store.state.activeSpaceId) || store.state.spaces[0]
    if (sp && !sp.apps.some((a) => a.url === INBOX_URL)) {
      const c = CATALOG.find((x) => x.url === INBOX_URL)
      const a = store.addApp(sp.id, c)
      sp.apps.splice(sp.apps.indexOf(a), 1)
      sp.apps.unshift(a)
      store.save()
      pushState()
    }
  }
})

app.on('before-quit', (e) => {
  control.stop()
  if (quitting) return
  e.preventDefault() // finish writing logins to disk first, then quit
  quitGracefully()
})
app.on('window-all-closed', () => app.quit())
