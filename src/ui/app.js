// Browser UI: spaces rail, apps panel, tab strip, toolbar, modals.
const api = window.browser
const $ = (sel) => document.querySelector(sel)
let state = null
let addressFocused = false
let actionListPartition = null

document.body.classList.add(api.platform)

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const hostOf = (url) => {
  try { return new URL(url).hostname } catch { return '' }
}
const iconFor = (url) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=64`
const initials = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
const badgeHtml = (n) => (n > 0 ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '')

const activeSpace = () => state && state.spaces.find((s) => s.id === state.activeSpaceId)
const activeTab = () => {
  const s = activeSpace()
  return s && s.tabs.find((t) => t.id === s.activeTabId)
}

// ------------------------------------------------------------------ rendering

function render() {
  const space = activeSpace()
  if (!space) return
  document.body.classList.toggle('apps-hidden', !state.settings.appsPanelOpen)
  if (!resizing) setPanelWidth(clampW(state.settings.panelWidth || 230))

  // Spaces rail (not redrawn mid-drag, or the drag would be cancelled)
  if (!dragging) $('#spaces').innerHTML = state.spaces
    .map(
      (s, i) => `
      <button draggable="true" class="space ${s.id === space.id ? 'active' : ''}" data-id="${s.id}"
        style="background:${esc(s.color)}" title="${esc(s.name)} (Ctrl/Cmd+${i + 1})">
        ${esc(initials(s.name))}
        ${s.unread ? badgeHtml(s.unread) : s.hasDot ? '<span class="dot"></span>' : ''}
      </button>`
    )
    .join('')

  // Apps panel
  $('#space-name').textContent = space.name
  if (!dragging) $('#apps').innerHTML = space.apps
    .map((a) => {
      const tab = space.tabs.find((t) => t.appId === a.id)
      const isActive = tab && tab.id === space.activeTabId
      const badge = tab ? (tab.badge > 0 ? badgeHtml(tab.badge) : tab.badge === -1 ? '<span class="open-dot" style="background:var(--badge)"></span>' : '<span class="open-dot"></span>') : ''
      return `
        <li draggable="true" class="app ${isActive ? 'active' : ''}" data-id="${a.id}" title="${esc(a.name)}${a.subtitle ? ' · ' + esc(a.subtitle) : ''}
${esc(a.url)}">
          <img src="${esc(tab && tab.favicon ? tab.favicon : a.icon || iconFor(a.url))}" alt="" />
          <span class="name"><span>${esc(a.name)}</span>${a.subtitle ? `<small>${esc(a.subtitle)}</small>` : ''}</span>
          ${badge}
          <button class="remove" data-edit="${a.id}" title="Edit app">✎</button>
        </li>`
    })
    .join('')

  // Tabs: only websites you opened yourself. Apps live in the apps panel, not in the tab strip.
  if (!dragging) $('#tabs').innerHTML = space.tabs
    .filter((t) => !t.appId)
    .map(
      (t) => `
      <div draggable="true" class="tab ${t.id === space.activeTabId && !t.popout ? 'active' : ''} ${t.popout ? 'popped' : ''} ${t.appId ? 'app-tab' : ''}" data-id="${t.id}" title="${esc(t.title)}">
        ${t.loading ? '<span class="spinner"></span>' : t.favicon ? `<img src="${esc(t.favicon)}" alt="" />` : '<span class="ph"></span>'}
        <span class="title">${t.popout ? '⧉ ' : ''}${esc(t.title || t.url)}</span>
        ${t.badge > 0 ? badgeHtml(t.badge) : ''}
        <button class="close" data-close="${t.id}" title="Close tab">×</button>
      </div>`
    )
    .join('')

  // Toolbar
  const tab = activeTab()
  $('#back').disabled = !tab || !tab.canGoBack
  $('#forward').disabled = !tab || !tab.canGoForward
  $('#reload').textContent = tab && tab.loading ? '✕' : '⟳'
  $('#reload').title = tab && tab.loading ? 'Stop' : 'Reload'
  if (!addressFocused) $('#address').value = tab && tab.url !== 'about:blank' ? tab.url : ''
  const z = $('#zoom-chip')
  const zv = tab && tab.zoom ? tab.zoom : 100
  z.textContent = zv + '%'
  z.classList.toggle('off', zv !== 100)
  z.title = zv === 100 ? 'Page zoom: 100% (normal)' : `Page zoom: ${zv}%. Click to reset to 100%`
  $('#empty').style.display = tab ? 'none' : 'grid'

  renderActionList(space, tab)
  document.title = tab ? `${tab.title} · ${space.name}` : space.name
}

// Extension toolbar icons for the active space and tab.
function renderActionList(space, tab) {
  const slot = $('#actions-slot')
  let list = slot.querySelector('browser-action-list')
  // The element only observes one partition, so recreate it when switching spaces.
  if (!list || actionListPartition !== space.partition) {
    slot.innerHTML = ''
    list = document.createElement('browser-action-list')
    list.setAttribute('partition', space.partition)
    list.setAttribute('alignment', 'bottom left')
    actionListPartition = space.partition
    if (tab) list.setAttribute('tab', String(tab.webContentsId))
    slot.appendChild(list)
  } else if (tab && list.getAttribute('tab') !== String(tab.webContentsId)) {
    list.setAttribute('tab', String(tab.webContentsId))
  }
}

// Keep the page view positioned exactly over #content.
function reportBounds() {
  const r = $('#content').getBoundingClientRect()
  api.setContentBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
}
new ResizeObserver(reportBounds).observe($('#content'))
window.addEventListener('resize', reportBounds)

// ------------------------------------------------------------------ resize + drag and drop

let resizing = false
let dragging = null // { list: '#apps' | '#spaces', id }
// Narrower than ~140px snaps to icons-only mode (64px), like a compact dock.
const COMPACT_W = 64
const clampW = (w) => (w < 140 ? COMPACT_W : Math.min(480, Math.max(170, Math.round(w))))
function setPanelWidth(w) {
  document.documentElement.style.setProperty('--panel-w', w + 'px')
  document.body.classList.toggle('apps-compact', w <= COMPACT_W)
}

$('#panel-resizer').addEventListener('mousedown', (e) => {
  e.preventDefault()
  resizing = true
  api.setOverlay(true) // hide the page so it doesn't swallow mouse moves
  document.body.classList.add('resizing')
  const startX = e.clientX
  const startW = $('#apps-panel').getBoundingClientRect().width
  let w = startW
  const move = (ev) => {
    w = clampW(startW + ev.clientX - startX)
    setPanelWidth(w)
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    resizing = false
    document.body.classList.remove('resizing')
    api.setOverlay(false)
    api.setSettings({ panelWidth: w })
    reportBounds()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})
$('#panel-resizer').addEventListener('dblclick', () => api.setSettings({ panelWidth: 230 }))

function enableReorder(listSel, itemSel, onDone) {
  const list = $(listSel)
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSel)
    if (!item) return
    dragging = { list: listSel, id: item.dataset.id }
    item.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.dataset.id)
  })
  list.addEventListener('dragover', (e) => {
    if (!dragging || dragging.list !== listSel) return
    e.preventDefault()
    const src = list.querySelector(`${itemSel}[data-id="${dragging.id}"]`)
    const over = e.target.closest(itemSel)
    if (!src || !over || over === src) return
    const r = over.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    list.insertBefore(src, after ? over.nextSibling : over)
  })
  const finish = () => {
    if (!dragging || dragging.list !== listSel) return
    const ids = [...list.querySelectorAll(itemSel)].map((el) => el.dataset.id)
    list.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'))
    dragging = null
    onDone(ids)
  }
  list.addEventListener('drop', (e) => (e.preventDefault(), finish()))
  list.addEventListener('dragend', finish)
}
enableReorder('#apps', '.app', (ids) => api.reorderApps(activeSpace().id, ids))

// Drag a tab from the top strip onto the apps panel to save it as an app (at the spot you drop it).
let tabDrag = null
$('#tabs').addEventListener('dragstart', (e) => {
  const t = e.target.closest('.tab')
  if (!t) return
  tabDrag = Number(t.dataset.id)
  dragging = { list: '#tabs', id: t.dataset.id }
  t.classList.add('dragging')
  document.body.classList.add('tab-dragging')
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData('text/plain', String(tabDrag))
})
$('#tabs').addEventListener('dragend', (e) => {
  // Dropped outside the window (nothing accepted it): give the tab its own window.
  if (tabDrag != null && e.dataTransfer.dropEffect === 'none' && (e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight)) {
    api.popoutTab(activeSpace().id, tabDrag, { x: e.screenX, y: e.screenY })
  }
  tabDrag = null
  if (dragging && dragging.list === '#tabs') dragging = null
  document.body.classList.remove('tab-dragging')
  $('#apps-panel').classList.remove('drop-target')
  document.querySelectorAll('.drop-line').forEach((el) => el.remove())
  render()
})
function tabDropIndex(e) {
  const items = [...$('#apps').querySelectorAll('.app')]
  const i = items.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
  return i === -1 ? items.length : i
}
$('#apps-panel').addEventListener('dragover', (e) => {
  if (tabDrag == null) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  $('#apps-panel').classList.add('drop-target')
  const items = [...$('#apps').querySelectorAll('.app')]
  const i = tabDropIndex(e)
  let line = document.querySelector('.drop-line')
  if (!line) { line = document.createElement('li'); line.className = 'drop-line' }
  $('#apps').insertBefore(line, items[i] || null)
})
$('#apps-panel').addEventListener('dragleave', (e) => {
  if (tabDrag == null || $('#apps-panel').contains(e.relatedTarget)) return
  $('#apps-panel').classList.remove('drop-target')
  document.querySelectorAll('.drop-line').forEach((el) => el.remove())
})
$('#apps-panel').addEventListener('drop', (e) => {
  if (tabDrag == null) return
  e.preventDefault()
  const space = activeSpace()
  const t = space.tabs.find((x) => x.id === tabDrag)
  const index = tabDropIndex(e)
  tabDrag = null
  if (!t || !t.url || t.url === 'about:blank') return
  let name = (t.title || '').trim()
  if (!name || /^https?:/.test(name)) { try { name = new URL(t.url).hostname.replace(/^www\./, '') } catch { name = t.url } }
  if (name.length > 40) name = name.slice(0, 38).trim() + '…'
  api.addApp(space.id, { name, url: t.url, fromTabId: t.id, index })
})
enableReorder('#spaces', '.space', (ids) => api.reorderSpaces(ids))

// ------------------------------------------------------------------ events

$('#spaces').addEventListener('click', (e) => {
  const b = e.target.closest('.space')
  if (b) api.activateSpace(b.dataset.id)
})
$('#spaces').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.space')
  if (b) {
    e.preventDefault()
    spaceModal(state.spaces.find((s) => s.id === b.dataset.id))
  }
})
$('#spaces').addEventListener('dblclick', (e) => {
  const b = e.target.closest('.space')
  if (b) spaceModal(state.spaces.find((s) => s.id === b.dataset.id))
})
$('#add-space').addEventListener('click', () => spaceModal(null))
$('#edit-space').addEventListener('click', () => spaceModal(activeSpace()))
$('#space-name').addEventListener('dblclick', () => spaceModal(activeSpace()))

$('#apps').addEventListener('click', (e) => {
  const space = activeSpace()
  const ed = e.target.closest('[data-edit]')
  if (ed) {
    e.stopPropagation()
    return appModal(space.apps.find((x) => x.id === ed.dataset.edit))
  }
  const li = e.target.closest('.app')
  if (li) api.openApp(space.id, li.dataset.id)
})
$('#apps').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.app')
  if (li) {
    e.preventDefault()
    api.appMenu(activeSpace().id, li.dataset.id)
  }
})
api.onEditApp((appId) => appModal(activeSpace().apps.find((x) => x.id === appId)))
$('#add-app').addEventListener('click', () => addAppModal())
$('#pin-page').addEventListener('click', () => appModal(null, true))

$('#tabs').addEventListener('click', (e) => {
  const space = activeSpace()
  const c = e.target.closest('[data-close]')
  if (c) return api.closeTab(space.id, Number(c.dataset.close))
  const t = e.target.closest('.tab')
  if (t) api.selectTab(space.id, Number(t.dataset.id))
})
$('#tabs').addEventListener('auxclick', (e) => {
  const t = e.target.closest('.tab')
  if (t && e.button === 1) api.closeTab(activeSpace().id, Number(t.dataset.id))
})
$('#new-tab').addEventListener('click', () => newTab())

$('#back').addEventListener('click', () => api.back())
$('#forward').addEventListener('click', () => api.forward())
$('#reload').addEventListener('click', () => (activeTab() && activeTab().loading ? api.stop() : api.reload()))
$('#toggle-apps').addEventListener('click', toggleApps)
$('#open-extensions').addEventListener('click', () => extensionsModal())
$('#open-passwords').addEventListener('click', () => passwordsModal())

$('#tabs').addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.tab')
  if (!t) return
  e.preventDefault()
  api.tabMenu(activeSpace().id, Number(t.dataset.id))
})
$('#zoom-chip').addEventListener('click', () => api.zoomReset())
const address = $('#address')
address.addEventListener('focus', () => {
  addressFocused = true
  setTimeout(() => address.select(), 0)
})
address.addEventListener('blur', () => {
  addressFocused = false
  render()
})
$('#address-form').addEventListener('submit', (e) => {
  e.preventDefault()
  api.go(address.value)
  address.blur()
})
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') address.blur()
})

function newTab() {
  api.newTab('https://www.google.com/')
  setTimeout(() => address.focus(), 50)
}
function toggleCompact() {
  const w = state.settings.panelWidth || 230
  if (w <= COMPACT_W) api.setSettings({ panelWidth: state.settings.lastFullWidth || 230 })
  else api.setSettings({ panelWidth: COMPACT_W, lastFullWidth: w })
}
function toggleApps() {
  api.setSettings({ appsPanelOpen: !state.settings.appsPanelOpen })
}

api.onCommand((cmd) => {
  if (cmd === 'ui:new-tab') newTab()
  if (cmd === 'ui:new-space') spaceModal(null)
  if (cmd === 'ui:focus-address') address.focus()
  if (cmd === 'ui:toggle-apps') toggleApps()
  if (cmd === 'ui:toggle-compact') toggleCompact()
  if (cmd === 'ui:extensions') extensionsModal()
  if (cmd === 'ui:passwords') passwordsModal()
})

// ------------------------------------------------------------------ modals

function openModal(html, onMount) {
  closeModal()
  api.setOverlay(true) // hide the web page so the modal is visible
  const root = $('#modal-root')
  root.innerHTML = `<div class="backdrop"><div class="modal" role="dialog">${html}</div></div>`
  const backdrop = root.firstElementChild
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeModal()
  })
  const modal = backdrop.firstElementChild
  onMount && onMount(modal)
  const first = modal.querySelector('input[type=text]')
  if (first) first.focus()
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
})
function closeModal() {
  if (!$('#modal-root').innerHTML) return
  $('#modal-root').innerHTML = ''
  api.setOverlay(false)
}

function confirmModal(title, detail, okLabel, onOk) {
  openModal(
    `<h3>${esc(title)}</h3><p class="hint">${esc(detail)}</p>
     <div class="row"><button class="btn" data-x>Cancel</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div>`,
    (m) => {
      m.querySelector('[data-x]').onclick = closeModal
      m.querySelector('[data-ok]').onclick = () => (closeModal(), onOk())
    }
  )
}

// "JobTread, https://app.jobtread.com" or "JobTread https://..." or just "https://..."
function parseAppLine(line) {
  const m = /(\S+\.\S+)\s*$/.exec(line.trim())
  if (!m) return null
  const url = /^[a-z]+:\/\//i.test(m[1]) ? m[1] : 'https://' + m[1]
  const name = line.trim().slice(0, m.index).replace(/[,:\-\s]+$/, '').trim() || hostOf(url).replace(/^www\./, '')
  return { name, url }
}

const STARTER = ['Unread', 'Tasks', 'Gmail', 'Google Drive', 'JobTread', 'Schedulus', 'Quo', 'Heritage Pool Plus', 'ConstructCC', 'Proline', 'Horner Xpress', 'Pool360', 'Google Calendar', 'WhatsApp']

function spaceModal(space) {
  const editing = !!space
  let color = editing ? space.color : state.colors[state.spaces.length % state.colors.length]
  const starters = [...state.catalog].sort((a, b) => (STARTER.indexOf(a.name) + 1 || 99) - (STARTER.indexOf(b.name) + 1 || 99))
  const idx = editing ? state.spaces.findIndex((s) => s.id === space.id) : -1
  openModal(
    `<h3>${editing ? 'Space settings' : 'New space'}</h3>
     <p class="hint">${editing ? '' : 'Each space is a separate account with its own logins and cookies. Use one per Google account, client, or business.'}</p>
     <form>
       <label>Name</label>
       <input type="text" name="name" value="${esc(editing ? space.name : '')}" placeholder="e.g. Work, info@mycompany.com" />
       <label>Color</label>
       <div class="swatches">${state.colors.map((c) => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
       ${
         editing
           ? ''
           : `<label>Start with these apps</label>
              <div class="catalog">${starters
                .map((c, i) => `<label class="check"><input type="checkbox" name="app" value="${i}" ${i < 12 ? 'checked' : ''}/> <img src="${esc(c.icon || iconFor(c.url))}" alt="">${esc(c.name)}</label>`)
                .join('')}</div>
              <label>Add any other apps (one per line: name, then the link)</label>
              <textarea name="custom" rows="3" placeholder="JobTread, https://app.jobtread.com/jobs&#10;Schedulus, https://your-schedulus-link&#10;https://any-other-site.com"></textarea>
              <p class="hint">You can always add more later with "+ Add app", or the ☆ next to the address bar.</p>`
       }
       <div class="row">
         ${
           editing
             ? `<button type="button" class="btn danger left" data-del>Delete space</button>
                <button type="button" class="btn" data-up ${idx <= 0 ? 'disabled' : ''}>Move up</button>
                <button type="button" class="btn" data-down ${idx >= state.spaces.length - 1 ? 'disabled' : ''}>Move down</button>`
             : ''
         }
         <button type="button" class="btn" data-x>Cancel</button>
         <button type="submit" class="btn primary">${editing ? 'Save' : 'Create space'}</button>
       </div>
     </form>`,
    (m) => {
      m.querySelectorAll('.swatch').forEach((b) =>
        b.addEventListener('click', () => {
          color = b.dataset.color
          m.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x === b))
        })
      )
      m.querySelector('[data-x]').onclick = closeModal
      if (editing) {
        m.querySelector('[data-del]').onclick = () => (closeModal(), api.removeSpace(space.id))
        m.querySelector('[data-up]').onclick = () => (api.moveSpace(space.id, -1), closeModal())
        m.querySelector('[data-down]').onclick = () => (api.moveSpace(space.id, 1), closeModal())
      }
      m.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault()
        const fd = new FormData(e.target)
        const name = (fd.get('name') || '').trim() || (editing ? space.name : 'New space')
        closeModal()
        if (editing) api.updateSpace(space.id, { name, color })
        else {
          const custom = String(fd.get('custom') || '')
            .split('\n')
            .map(parseAppLine)
            .filter(Boolean)
          await api.addSpace({ name, color, apps: [...fd.getAll('app').map((i) => starters[Number(i)]), ...custom] })
        }
      })
    }
  )
}

function addAppModal() {
  const space = activeSpace()
  openModal(
    `<h3>Add an app to ${esc(space.name)}</h3>
     <div class="catalog">${state.catalog
       .map((c, i) => `<button type="button" data-i="${i}"><img src="${esc(c.icon || iconFor(c.url))}" alt="">${esc(c.name)}</button>`)
       .join('')}</div>
     <div class="row">
       <button type="button" class="btn" data-x>Cancel</button>
       <button type="button" class="btn primary" data-custom>Add any website or page…</button>
     </div>`,
    (m) => {
      m.querySelector('[data-x]').onclick = closeModal
      m.querySelector('[data-custom]').onclick = () => appModal(null)
      m.querySelectorAll('[data-i]').forEach((b) =>
        b.addEventListener('click', () => {
          const c = state.catalog[Number(b.dataset.i)]
          if (c.url.startsWith('internal:')) return api.addApp(space.id, c), closeModal()
          appModal({ ...c, isNew: true })
        })
      )
    }
  )
}

// Add or edit an app. `existing` = app to edit; null = new custom app; {isNew:true,...} = new from catalog.
// fromCurrent = prefill with the page currently open in this space.
function appModal(existing, fromCurrent = false) {
  const space = activeSpace()
  const editing = existing && !existing.isNew
  const cur = activeTab()
  const curUsable = cur && /^https?:/.test(cur.url)
  const start = editing || (existing && existing.isNew)
    ? existing
    : fromCurrent && curUsable
      ? { name: cleanTitle(cur.title) || hostOf(cur.url).replace(/^www\./, ''), url: cur.url }
      : { name: '', url: '' }
  const idx = editing ? space.apps.findIndex((a) => a.id === existing.id) : -1
  openModal(
    `<h3>${editing ? 'Edit app' : 'Add app to ' + esc(space.name)}</h3>
     <form>
       <label>Name</label>
       <input type="text" name="name" value="${esc(start.name)}" placeholder="e.g. JobTread" />
       <label>Label (optional, shown under the name, e.g. which account)</label>
       <input type="text" name="subtitle" value="${esc(start.subtitle || '')}" placeholder="e.g. Nilson Master Touch E-Mail" />
       <label>Page it opens (paste the exact link, e.g. your JobTread jobs page or a specific Gmail inbox)</label>
       <input type="text" name="url" value="${esc(start.url)}" placeholder="https://app.example.com/your/page" />
       ${curUsable ? `<p class="hint">Or <a href="#" data-current>use the page open right now</a>: ${esc(cur.url.length > 70 ? cur.url.slice(0, 70) + '…' : cur.url)}</p>` : ''}
       <div class="row">
         ${editing
           ? `<button type="button" class="btn danger left" data-del>Remove</button>
              <button type="button" class="btn" data-up ${idx <= 0 ? 'disabled' : ''}>Move up</button>
              <button type="button" class="btn" data-down ${idx >= space.apps.length - 1 ? 'disabled' : ''}>Move down</button>`
           : ''}
         <button type="button" class="btn" data-x>Cancel</button>
         <button type="submit" class="btn primary">${editing ? 'Save' : 'Add app'}</button>
       </div>
     </form>`,
    (m) => {
      const f = m.querySelector('form')
      let usedCurrent = fromCurrent && curUsable && !editing
      m.querySelector('[data-x]').onclick = closeModal
      const useCur = m.querySelector('[data-current]')
      if (useCur)
        useCur.onclick = (e) => {
          e.preventDefault()
          f.url.value = cur.url
          if (!f.name.value) f.name.value = cleanTitle(cur.title)
          usedCurrent = true
        }
      if (editing) {
        m.querySelector('[data-del]').onclick = () =>
          confirmModal(`Remove ${existing.name}?`, 'You stay signed in; this only removes the shortcut.', 'Remove', () =>
            api.removeApp(space.id, existing.id)
          )
        m.querySelector('[data-up]').onclick = () => (api.moveApp(space.id, existing.id, -1), closeModal())
        m.querySelector('[data-down]').onclick = () => (api.moveApp(space.id, existing.id, 1), closeModal())
      }
      f.addEventListener('submit', (e) => {
        e.preventDefault()
        const url = f.url.value.trim()
        if (!url) return f.url.focus()
        const name = f.name.value.trim() || hostOf(/^https?:/.test(url) ? url : 'https://' + url).replace(/^www\./, '')
        const subtitle = f.subtitle.value.trim()
        if (editing) api.updateApp(space.id, existing.id, { name, url, subtitle })
        else api.addApp(space.id, { name, url, subtitle, icon: existing && existing.isNew ? existing.icon : undefined, fromCurrentTab: usedCurrent && cur && url === cur.url })
        closeModal()
      })
    }
  )
}

// "Inbox (37) - me@x.com - Gmail" -> "Gmail"-ish short name
function cleanTitle(t) {
  const parts = String(t || '').replace(/\(\d+\+?\)/g, '').split(/\s[-|–·]\s/).map((x) => x.trim()).filter(Boolean)
  return (parts[parts.length - 1] || '').slice(0, 40)
}

async function passwordsModal(filter = '') {
  const res = await api.listPasswords()
  if (!res.ok) {
    return openModal(`<h3>Passwords</h3><p class="hint">${esc(res.error)}</p><div class="row"><button class="btn" data-x>Close</button></div>`, (m) => (m.querySelector('[data-x]').onclick = closeModal))
  }
  const items = res.items
  openModal(
    `<h3>Passwords <span class="hint">(${items.length})</span></h3>
     <p class="hint">Saved logins fill in automatically on their sites, in every space. They're encrypted with your Mac's Keychain and never leave this computer.
       To bring in your old passwords, export them from Chrome or Shift (Settings → Passwords → Export) and click <b>Import</b>.</p>
     <input type="text" name="q" placeholder="Search sites or usernames" value="${esc(filter)}" />
     <ul class="ext-list pw-list">${
       items.length
         ? items
             .map(
               (x) => `<li data-q="${esc((x.host + ' ' + x.username + ' ' + x.name).toLowerCase())}">
                 <img src="${esc(iconFor(x.url))}" alt="" width="18" height="18"/>
                 <div class="meta"><div><b>${esc(x.host)}</b></div><div>${esc(x.username || '(no username)')}</div></div>
                 <button class="btn" data-rm="${esc(x.id)}">Delete</button></li>`
             )
             .join('')
         : '<li class="hint">No saved passwords yet.</li>'
     }</ul>
     <details><summary class="hint" style="cursor:pointer;margin-top:12px">Add a login manually</summary>
       <form data-add>
         <label>Website</label><input type="text" name="url" placeholder="https://app.jobtread.com" />
         <label>Username or email</label><input type="text" name="username" />
         <label>Password</label><input type="password" name="password" class="pw-input" />
         <div class="row"><button class="btn" type="submit">Save login</button></div>
       </form></details>
     <div class="row">
       <button class="btn primary left" data-import>Import from Chrome / Shift (CSV)…</button>
       <button class="btn" data-x>Close</button>
     </div>`,
    (m) => {
      m.querySelector('[data-x]').onclick = closeModal
      const q = m.querySelector('input[name=q]')
      const apply = () => {
        const v = q.value.trim().toLowerCase()
        m.querySelectorAll('.pw-list li[data-q]').forEach((li) => (li.style.display = !v || li.dataset.q.includes(v) ? '' : 'none'))
      }
      q.addEventListener('input', apply)
      apply()
      m.querySelector('[data-import]').onclick = async () => {
        await api.importPasswords()
        passwordsModal()
      }
      m.querySelectorAll('[data-rm]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api.removePassword(b.dataset.rm)
          passwordsModal(q.value)
        })
      )
      m.querySelector('[data-add]').addEventListener('submit', async (e) => {
        e.preventDefault()
        const f = e.target
        let url = f.url.value.trim()
        if (!url || !f.password.value) return
        if (!/^https?:\/\//.test(url)) url = 'https://' + url
        await api.addPassword({ url, username: f.username.value.trim(), password: f.password.value })
        passwordsModal()
      })
    }
  )
}

async function extensionsModal() {
  const list = await api.listExtensions()
  openModal(
    `<h3>Chrome extensions</h3>
     <p class="hint">Install from the Chrome Web Store with "Add to Chrome", or load an unpacked extension folder.
       Extensions are shared by all spaces, while each space keeps its own extension data and logins.</p>
     <ul class="ext-list">${
       list.length
         ? list
             .map(
               (x) => `<li><div class="meta"><div><b>${esc(x.name)}</b> <span class="hint">${esc(x.version)}</span></div><div>${esc(x.description)}</div></div>
                 <button class="btn" data-rm="${esc(x.id)}">Remove</button></li>`
             )
             .join('')
         : '<li class="hint">No extensions installed yet.</li>'
     }</ul>
     <div class="row">
       <button class="btn left" data-update>Check for updates</button>
       <button class="btn" data-unpacked>Load unpacked…</button>
       <button class="btn primary" data-store>Open Chrome Web Store</button>
       <button class="btn" data-x>Close</button>
     </div>`,
    (m) => {
      m.querySelector('[data-x]').onclick = closeModal
      m.querySelector('[data-store]').onclick = () => {
        closeModal()
        api.newTab('https://chromewebstore.google.com/')
      }
      m.querySelector('[data-unpacked]').onclick = async () => {
        await api.loadUnpacked()
        extensionsModal()
      }
      m.querySelector('[data-update]').onclick = async (e) => {
        e.target.textContent = 'Checking…'
        await api.updateExtensions()
        e.target.textContent = 'Up to date'
      }
      m.querySelectorAll('[data-rm]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api.removeExtension(b.dataset.rm)
          extensionsModal()
        })
      )
    }
  )
}

// Broken favicon -> neutral placeholder.
const FALLBACK_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#c9ced6"/><circle cx="8" cy="8" r="3.5" fill="none" stroke="#fff" stroke-width="1.4"/></svg>')
document.addEventListener(
  'error',
  (e) => {
    const img = e.target
    if (img.tagName === 'IMG' && img.src !== FALLBACK_ICON) img.src = FALLBACK_ICON
  },
  true
)

// ------------------------------------------------------------------ boot

api.onState((s) => {
  state = s
  render()
})
api.getState().then((s) => {
  state = s
  render()
  reportBounds()
})
