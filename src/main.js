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
} = require('electron')
const path = require('path')
const fs = require('fs')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const {
  installChromeWebStore,
  uninstallExtension,
  updateExtensions,
} = require('electron-chrome-web-store')
const { Store, CATALOG, COLORS } = require('./store')

app.setName('MultiSpace Browser')

let store
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
  if (tab) rt.extensions.selectTab(tab.view.webContents)
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
  const view = new WebContentsView({
    webPreferences: {
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
  }
  rt.tabs.set(tab.id, tab)
  rt.order.push(tab.id)
  rt.extensions.addTab(view.webContents, win)
  wireTab(tab)
  win.contentView.addChildView(view)
  view.setVisible(false)

  // Wait until the space's extensions are loaded so content scripts run on the first page.
  Promise.resolve(rt.ready).finally(() => view.webContents.loadURL(tab.url).catch(() => {}))

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
  wc.on('did-navigate', (_e, url) => {
    tab.url = url
    update()
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) {
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
    pushState()
  })

  // Links with target=_blank open as new tabs in the same space. Real popups (OAuth sign-in
  // windows, etc.) stay popups so the opener relationship keeps working.
  wc.setWindowOpenHandler(({ url, disposition }) => {
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
  rt.extensions.selectTab(rt.tabs.get(tabId).view.webContents)
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
    if (rt.activeTabId) rt.extensions.selectTab(rt.tabs.get(rt.activeTabId).view.webContents)
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
    catalog: CATALOG,
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
    const a = store.addApp(spaceId, { name: entry.name, url: normalizeUrl(entry.url), subtitle: entry.subtitle })
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

  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() }
  )

  const rt = runtimes.get(tab.spaceId)
  const extItems = rt ? rt.extensions.getContextMenuItems(wc, params) : []
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
            if (t) closeTab(t.spaceId, t.id)
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
    backgroundColor: '#1e1f22',
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

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'))
  // Lets the extension toolbar in the browser UI show extension icons.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  registerIpc()
  buildAppMenu()
  createWindow()
  // Start every space's session in the background so extensions and notifications are ready.
  store.state.spaces.forEach((s) => getRuntime(s.id))
})

app.on('before-quit', () => {
  for (const rt of runtimes.values()) persistTabs(rt.spaceId)
  store && store.saveNow()
})
app.on('window-all-closed', () => app.quit())
