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
} = require('electron')
const { pathToFileURL } = require('url')
const path = require('path')
const fs = require('fs')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
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
const isInternal = (url) => url === IMESSAGE_URL

app.setName('MultiSpace Browser')
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

  const rt = { spaceId, session: ses, tabs: new Map(), order: [], activeTabId: null, restored: false }
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
      if (tab) selectTab(tab.spaceId, tab.id)
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

  // Chrome Web Store: lets you click "Add to Chrome" on chromewebstore.google.com.
  // Extensions live in one shared folder and are loaded into every space.
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
    for (const other of runtimes.values()) {
      if (other === rt) continue
      const o = exts(other.session)
      if (!o.getExtension(ext.id)) o.loadExtension(ext.path, { allowFileAccess: true }).catch(() => {})
    }
    pushState()
  })
  exts(ses).on('extension-unloaded', () => pushState())

  ses.on('will-download', (_e, item) => {
    // Use the default Chrome-like behaviour: ask where to save.
    item.once('done', (_ev, state) => {
      if (state === 'completed') shell.showItemInFolder(item.getSavePath())
    })
  })

  return rt
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
  const space = store.getSpace(spaceId)
  const saved = space.tabs || []
  saved.forEach((t) => {
    if (t.appId && !space.apps.find((a) => a.id === t.appId)) return
    createTab(spaceId, { url: t.url, appId: t.appId, select: false, persist: false })
  })
  const active = saved.find((t) => t.active)
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
  layoutViews()
  const rt = runtimes.get(spaceId)
  const tab = rt && rt.tabs.get(rt.activeTabId)
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

function createTab(spaceId, { url, appId = null, select = true, persist = true } = {}) {
  const rt = getRuntime(spaceId)
  const internal = isInternal(normalizeUrl(url))
  const view = new WebContentsView({
    webPreferences: internal
      ? {
          // Built-in iMessage page: its own session, no extensions, only the iMessage bridge.
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
  }
  rt.tabs.set(tab.id, tab)
  rt.order.push(tab.id)
  if (!internal) rt.extensions.addTab(view.webContents, win)
  wireTab(tab)
  win.contentView.addChildView(view)
  view.setVisible(false)

  if (internal) view.webContents.loadFile(path.join(__dirname, 'imessage', 'index.html')).catch(() => {})
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
    tab.loading = true
    pushState()
  })
  wc.on('did-stop-loading', () => {
    tab.loading = false
    pushState()
  })
  // If a page's process crashes or runs out of memory, bring it back instead of leaving a dead tab.
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000)
  })
  wc.on('did-navigate', (_e, url) => {
    if (tab.internal) return
    tab.url = url
    update()
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame && !tab.internal) {
      tab.url = url
      update()
    }
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted (normal during redirects)
    tab.title = `Can't reach ${hostOf(url) || 'page'}`
    pushState()
  })
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title
    tab.badge = parseBadge(title)
    pushState()
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
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

function selectTab(spaceId, tabId) {
  const rt = runtimes.get(spaceId)
  if (!rt || !rt.tabs.has(tabId)) return
  rt.activeTabId = tabId
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
  win.contentView.removeChildView(tab.view)
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

function layoutViews() {
  if (!win) return
  const active = activeTab()
  for (const rt of runtimes.values()) {
    for (const tab of rt.tabs.values()) {
      const show = tab === active && !overlayOpen
      if (show) tab.view.setBounds(contentBounds)
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
    catalog: CATALOG.filter((c) => !isInternal(c.url) || process.platform === 'darwin' || process.env.MULTISPACE_TEST_CHATDB),
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
              canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
              canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
            }
          })
        : []
      const unread = tabs.reduce((n, t) => n + Math.max(0, t.badge), 0)
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
  ipcMain.handle('imsg:contacts', imsgOnly(() => imessage.searchContacts()))
  ipcMain.handle('imsg:add-contact', imsgOnly((c) => imessage.addContact(c || {})))
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
    if (!digits) clipboard.writeText(msg)
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
  ipcMain.on('nav:go', (_e, input) => {
    const tab = activeTab()
    const url = normalizeUrl(input)
    if (tab) tab.view.webContents.loadURL(url).catch(() => {})
    else createTab(store.state.activeSpaceId, { url })
  })
  ipcMain.on('nav:back', () => activeTab()?.view.webContents.navigationHistory.goBack())
  ipcMain.on('nav:forward', () => activeTab()?.view.webContents.navigationHistory.goForward())
  ipcMain.on('nav:reload', () => activeTab()?.view.webContents.reload())
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
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
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

function buildAppMenu() {
  const send = (channel, ...args) => () => win && win.webContents.send(channel, ...args)
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
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
          label: 'Developer Tools (page)',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => activeTab()?.view.webContents.toggleDevTools(),
        },
        { label: 'Developer Tools (browser UI)', click: () => win.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => activeTab()?.view.webContents.setZoomLevel(0) },
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
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function zoom(delta) {
  const wc = activeTab()?.view.webContents
  if (wc) wc.setZoomLevel(wc.getZoomLevel() + delta)
}

// ---------------------------------------------------------------- startup

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'MultiSpace Browser',
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

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'))
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
})

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault() // finish writing logins to disk first, then quit
  quitGracefully()
})
app.on('window-all-closed', () => app.quit())
