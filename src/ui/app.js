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

  // Spaces rail
  $('#spaces').innerHTML = state.spaces
    .map(
      (s, i) => `
      <button class="space ${s.id === space.id ? 'active' : ''}" data-id="${s.id}"
        style="background:${esc(s.color)}" title="${esc(s.name)} (Ctrl/Cmd+${i + 1})">
        ${esc(initials(s.name))}
        ${s.unread ? badgeHtml(s.unread) : s.hasDot ? '<span class="dot"></span>' : ''}
      </button>`
    )
    .join('')

  // Apps panel
  $('#space-name').textContent = space.name
  $('#apps').innerHTML = space.apps
    .map((a) => {
      const tab = space.tabs.find((t) => t.appId === a.id)
      const isActive = tab && tab.id === space.activeTabId
      const badge = tab ? (tab.badge > 0 ? badgeHtml(tab.badge) : tab.badge === -1 ? '<span class="open-dot" style="background:var(--badge)"></span>' : '<span class="open-dot"></span>') : ''
      return `
        <li class="app ${isActive ? 'active' : ''}" data-id="${a.id}" title="${esc(a.url)}">
          <img src="${esc(tab && tab.favicon ? tab.favicon : iconFor(a.url))}" alt="" />
          <span class="name">${esc(a.name)}</span>
          ${badge}
          <button class="remove" data-remove="${a.id}" title="Remove app">×</button>
        </li>`
    })
    .join('')

  // Tabs
  $('#tabs').innerHTML = space.tabs
    .map(
      (t) => `
      <div class="tab ${t.id === space.activeTabId ? 'active' : ''} ${t.appId ? 'app-tab' : ''}" data-id="${t.id}" title="${esc(t.title)}">
        ${t.loading ? '<span class="spinner"></span>' : t.favicon ? `<img src="${esc(t.favicon)}" alt="" />` : '<span class="ph"></span>'}
        <span class="title">${esc(t.title || t.url)}</span>
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
  const rm = e.target.closest('[data-remove]')
  if (rm) {
    e.stopPropagation()
    const a = space.apps.find((x) => x.id === rm.dataset.remove)
    confirmModal(`Remove ${a.name} from ${space.name}?`, 'You stay signed in; this only removes the shortcut.', 'Remove', () =>
      api.removeApp(space.id, a.id)
    )
    return
  }
  const li = e.target.closest('.app')
  if (li) api.openApp(space.id, li.dataset.id)
})
$('#add-app').addEventListener('click', () => addAppModal())

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
function toggleApps() {
  api.setSettings({ appsPanelOpen: !state.settings.appsPanelOpen })
}

api.onCommand((cmd) => {
  if (cmd === 'ui:new-tab') newTab()
  if (cmd === 'ui:new-space') spaceModal(null)
  if (cmd === 'ui:focus-address') address.focus()
  if (cmd === 'ui:toggle-apps') toggleApps()
  if (cmd === 'ui:extensions') extensionsModal()
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

const STARTER = ['Gmail', 'Google Calendar', 'Google Drive', 'Slack', 'WhatsApp', 'Outlook']

function spaceModal(space) {
  const editing = !!space
  let color = editing ? space.color : state.colors[state.spaces.length % state.colors.length]
  const starters = state.catalog.filter((c) => STARTER.includes(c.name))
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
                .map((c, i) => `<label class="check"><input type="checkbox" name="app" value="${i}" ${i < 3 ? 'checked' : ''}/> <img src="${iconFor(c.url)}" alt="">${esc(c.name)}</label>`)
                .join('')}</div>`
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
        else await api.addSpace({ name, color, apps: fd.getAll('app').map((i) => starters[Number(i)]) })
      })
    }
  )
}

function addAppModal() {
  const space = activeSpace()
  openModal(
    `<h3>Add an app to ${esc(space.name)}</h3>
     <div class="catalog">${state.catalog
       .map((c, i) => `<button type="button" data-i="${i}"><img src="${iconFor(c.url)}" alt="">${esc(c.name)}</button>`)
       .join('')}</div>
     <form>
       <label>Or add any website</label>
       <input type="text" name="url" placeholder="https://app.example.com" />
       <label>Name</label>
       <input type="text" name="name" placeholder="Optional" />
       <div class="row"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary" type="submit">Add</button></div>
     </form>`,
    (m) => {
      m.querySelector('[data-x]').onclick = closeModal
      m.querySelectorAll('[data-i]').forEach((b) =>
        b.addEventListener('click', () => {
          api.addApp(space.id, state.catalog[Number(b.dataset.i)])
          closeModal()
        })
      )
      m.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault()
        const fd = new FormData(e.target)
        const url = (fd.get('url') || '').trim()
        if (!url) return
        const name = (fd.get('name') || '').trim() || hostOf(/^https?:/.test(url) ? url : 'https://' + url).replace(/^www\./, '')
        api.addApp(space.id, { name, url })
        closeModal()
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
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#5c5f66"/><circle cx="8" cy="8" r="3.5" fill="none" stroke="#ddd" stroke-width="1.4"/></svg>')
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
