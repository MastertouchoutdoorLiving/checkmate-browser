// Built-in iMessage page.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let chats = []
let current = null // chat object, or { compose: true }
let lastSig = ''
let filter = 'all'
let curMsgs = []
let prefs = { favorites: [], readUpTo: {}, manualUnread: {}, hidden: {}, team: [] }
let showDetails = (() => {
  try {
    const v = localStorage.getItem('imsg-details')
    return v === null ? innerWidth > 1150 : v === '1'
  } catch {
    return innerWidth > 1150
  }
})()

const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  unread: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 12h9M4 18h11"/><circle cx="19" cy="7" r="3" style="fill:#f26b3a;stroke:none"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>',
  addPerson: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="4"/><path d="M3 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5M19 8v6M16 11h6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12M9 7V4h6v3"/></svg>',
  team: '<svg viewBox="0 0 24 24"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 10h6M9 13h4"/></svg>',
  bubble: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
}

// ---- read / unread / favorites (kept by the browser; the Messages database itself is read-only)
const isFav = (c) => prefs.favorites.includes(c.guid)
function isUnread(c) {
  if (prefs.manualUnread[c.guid]) return true
  if (!c.unread || c.lastFromMe) return false
  return !(prefs.readUpTo[c.guid] >= c.date)
}
const savePrefs = () => window.imsg.setPrefs(prefs)
// Deleted conversations are hidden here until someone sends a new message in them.
const isHidden = (c) => prefs.hidden[c.guid] >= c.date
function hideChat(c) {
  prefs.hidden[c.guid] = c.date
  delete prefs.manualUnread[c.guid]
  prefs.favorites = prefs.favorites.filter((g) => g !== c.guid)
  savePrefs()
  if (current && current.id === c.id) {
    current = null
    lastSig = ''
    $('#messages').innerHTML = '<div class="empty"><div class="empty-ico">💬</div>Pick a conversation</div>'
    $('#chat-title').textContent = 'Messages'
    $('#chat-sub').textContent = ''
  }
  renderChats()
  toast('Conversation deleted', 'Undo', () => {
    delete prefs.hidden[c.guid]
    savePrefs()
    renderChats()
  })
}
function markRead(c) {
  delete prefs.manualUnread[c.guid]
  prefs.readUpTo[c.guid] = c.date
  savePrefs()
}
function markUnread(c) {
  prefs.manualUnread[c.guid] = true
  savePrefs()
}
function toggleFav(c) {
  prefs.favorites = isFav(c) ? prefs.favorites.filter((g) => g !== c.guid) : [...prefs.favorites, c.guid]
  savePrefs()
}

// ---- avatars: initials on a warm color picked from the name
const PALETTE = ['#e9825b', '#d9a441', '#7fa36b', '#5f9ea0', '#6f8fd8', '#9a7bd1', '#cf7aa8', '#c96f5b', '#8d9a5b', '#4f9a87', '#b8875a', '#7d86a8']
function colorFor(key) {
  let h = 0
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}
const isNumberish = (t) => /^[+\d(][\d\s()+\-.]*$/.test(t || '') || /@/.test(t || '')
function initials(t) {
  if (isNumberish(t)) return '#'
  const w = String(t || '').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean)
  return (w.length ? w.slice(0, 2).map((x) => [...x][0].toUpperCase()).join('') : '?')
}
function avatar(name, cls = '', key = name) {
  return `<div class="avatar ${cls}" style="background:${colorFor(key)}">${esc(initials(name))}</div>`
}
const chatAvatar = (c, cls) => (c.group ? `<div class="avatar ${cls}" style="background:${colorFor(c.guid)}">${esc(groupInitials(c))}</div>` : avatar(nameOf(c), cls, c.handle || c.guid))
function groupInitials(c) {
  const names = (c.members || []).map((m) => m.maybe || m.name).filter((n) => !isNumberish(n))
  return names.length >= 2 ? [...names[0]][0].toUpperCase() + [...names[1]][0].toUpperCase() : initials(c.title)
}
const nameOf = (c) => c.maybe || c.title
const maybeTag = (m) => (m ? '<span class="maybe" title="Name they shared with you. Not in your Contacts.">Maybe</span>' : '')
const firstName = (t) => (isNumberish(t) ? t : String(t).split(/[\s,]+/)[0])

function fmtTime(ms) {
  const d = new Date(ms), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function groupOf(ms) {
  const d = new Date(ms)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (d >= start) return 'Today'
  if (d >= start - 864e5) return 'Yesterday'
  if (d >= start - 6 * 864e5) return 'This week'
  return 'Earlier'
}
function dayLabel(ms) {
  const g = groupOf(ms)
  if (g === 'Today' || g === 'Yesterday') return g
  return new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}
function linkify(text) {
  return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/gi, (u) => `<a data-href="${u}">${u}</a>`)
}

async function boot() {
  const st = await window.imsg.status()
  if (!st.ok) {
    $('#setup').hidden = false
    if (st.reason === 'NOT_MAC') {
      $('#setup .card').innerHTML = '<h1>iMessage needs a Mac</h1><p>Messages can only be shown on a Mac that is signed in to iMessage.</p>'
    } else {
      $('#who').textContent = st.packaged ? 'CheckMate Browser' : 'Terminal'
      $('#detail').textContent = st.detail || ''
    }
    return
  }
  $('#app').hidden = false
  try {
    prefs = { favorites: [], readUpTo: {}, manualUnread: {}, hidden: {}, ...(await window.imsg.prefs()) }
    prefs.hidden = prefs.hidden || {}
    prefs.team = prefs.team || []
  } catch {}
  await refreshChats()
  setInterval(refreshChats, 5000)
  setupAlerts()
  setupQuickReplies()
  const unslide = () => {
    for (const el of [document.documentElement, document.body, $('#app')]) if (el && el.scrollLeft) el.scrollLeft = 0
  }
  document.addEventListener('scroll', unslide, true)
  window.addEventListener('resize', unslide)
  unslide()
}

// ---- beep / notification for new messages (the browser watches even when this page is closed)
function showAlerts(a) {
  $('#al-sound').checked = !!a.sound
  $('#al-banner').checked = !!a.banner
  $('#alerts-btn').classList.toggle('off', !a.sound && !a.banner)
  $('#alerts-btn').title = a.sound || a.banner ? 'Alerts for new messages: on' : 'Alerts for new messages: off'
}
async function setupAlerts() {
  try { showAlerts(await window.imsg.alerts()) } catch {}
  window.imsg.onAlertsChanged(showAlerts)
  $('#alerts-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    $('#alerts-menu').hidden = !$('#alerts-menu').hidden
  })
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.alerts-wrap')) $('#alerts-menu').hidden = true
  })
  for (const [id, key] of [['#al-sound', 'sound'], ['#al-banner', 'banner']]) {
    $(id).addEventListener('change', async (e) => showAlerts(await window.imsg.setAlerts({ [key]: e.target.checked })))
  }
  // clicking a notification opens that conversation
  window.imsg.onOpenChat(async (guid) => {
    let c = chats.find((x) => x.guid === guid)
    if (!c) { await refreshChats(); c = chats.find((x) => x.guid === guid) }
    if (c) { if (isHidden(c)) { delete prefs.hidden[c.guid]; savePrefs() } loadMessages(c, true); renderChats() }
  })
}

async function refreshChats() {
  try {
    chats = await window.imsg.chats()
  } catch (e) {
    return showError(e.message)
  }
  // a new message after you read a chat makes it unread again, unless you're looking at it
  if (current && current.id) {
    const c = chats.find((x) => x.id === current.id)
    if (c && !prefs.manualUnread[c.guid] && document.hasFocus()) prefs.readUpTo[c.guid] = c.date
  }
  renderChats()
  if (current && current.id) {
    const c = chats.find((x) => x.id === current.id)
    if (c) loadMessages(c, false)
  }
}

function renderChats() {
  const visible = chats.filter((c) => !isHidden(c))
  const unreadN = visible.filter(isUnread).length
  document.title = unreadN ? `Messages (${unreadN})` : 'Messages'
  $('#unread-count').textContent = unreadN || ''
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter))
  const q = $('#search').value.trim().toLowerCase()

  // favorites as big avatars at the top, with a peek at the newest unread message
  const favs = visible.filter(isFav)
  $('#favs').innerHTML =
    filter === 'all' && !q
      ? favs
          .map((c) => {
            const u = isUnread(c)
            return `<div class="fav ${current && current.id === c.id ? 'active' : ''}" data-id="${c.id}" title="${esc(nameOf(c))}">
              ${u ? `<div class="peek">${esc(c.last.replace(/^You: /, ''))}</div>` : ''}
              ${chatAvatar(c, '')}
              ${u ? '<span class="dot"></span>' : ''}
              <div class="fname">${esc(c.group ? c.title : firstName(nameOf(c)))}</div></div>`
          })
          .join('')
      : ''

  const list = visible.filter((c) => {
    if (q && ![c.title, c.maybe, c.last].some((x) => String(x || '').toLowerCase().includes(q))) return false
    if (filter === 'unread') return isUnread(c)
    if (filter === 'read') return !isUnread(c)
    if (filter === 'fav') return isFav(c)
    return !isFav(c) || q // favorites already shown on top in "All"
  })
  let html = ''
  let lastGroup = ''
  for (const c of list) {
    const g = groupOf(c.date)
    if (g !== lastGroup) {
      html += `<div class="group-label">${g}</div>`
      lastGroup = g
    }
    const u = isUnread(c)
    html += `<div class="swipe" data-id="${c.id}"><div class="swipe-actions"><button data-sw="read" class="sw-read">${u ? 'Read' : 'Unread'}</button><button data-sw="delete" class="sw-del">Delete</button></div>
      <div class="item ${current && current.id === c.id ? 'active' : ''} ${u ? 'is-unread' : ''}">
      ${chatAvatar(c, '')}
      <div class="ci"><div class="row1"><span class="title"><span class="tname">${isFav(c) ? '<span class="star">★</span>' : ''}${esc(nameOf(c))}</span>${maybeTag(c.maybe)}</span><span class="time">${esc(fmtTime(c.date))}</span></div>
      <div class="last">${esc(c.last)}</div></div>
      ${u ? '<span class="dot"></span>' : ''}
    </div></div>`
  }
  $('#chats').innerHTML =
    html ||
    `<div class="empty-list">${filter === 'unread' ? 'No unread messages 🎉' : filter === 'fav' ? 'No favorites yet. Right-click a conversation and pick Add to Favorites.' : 'Nothing here'}</div>`
  renderHeader()
  renderDetails()
}

const currentChat = () => current && current.id && chats.find((x) => x.id === current.id)

function subtitleFor(c) {
  if (c.group) return (c.members || []).map((m) => (m.maybe ? 'Maybe: ' + m.maybe : firstName(m.name))).join(', ')
  const h = c.handle && c.handle !== nameOf(c) ? c.handle + ' · ' : ''
  return h + (c.service === 'SMS' ? 'Text message' : 'iMessage')
}

function renderHeader() {
  const c = currentChat()
  $('#hdr-actions').hidden = !c
  $('#head-avatar').hidden = !c
  if (!c) return
  $('#head-avatar').outerHTML = chatAvatar(c, 'lg').replace('<div class="avatar', '<div id="head-avatar" class="avatar')
  $('#chat-title').innerHTML = esc(nameOf(c)) + maybeTag(c.maybe)
  $('#chat-sub').textContent = subtitleFor(c)
  const u = isUnread(c)
  $('#hdr-unread').title = u ? 'Mark as read' : 'Mark as unread'
  $('#hdr-unread').classList.toggle('on', u)
  $('#hdr-add').hidden = c.group || c.saved !== false
  $('#hdr-fav').classList.toggle('on', isFav(c))
  $('#hdr-fav').title = isFav(c) ? 'Remove from Favorites' : 'Add to Favorites'
  $('#hdr-info').classList.toggle('on', showDetails)
}

function renderDetails() {
  const c = currentChat()
  const box = $('#details')
  box.hidden = !c || !showDetails
  if (box.hidden) return
  const fav = isFav(c)
  const u = isUnread(c)
  const tag = c.group ? '<span class="tag group">Group</span>' : c.service === 'SMS' ? '<span class="tag sms">SMS</span>' : '<span class="tag">iMessage</span>'
  const members = (c.members || []).length ? c.members : [{ handle: c.handle, name: c.title, maybe: c.maybe }]
  box.innerHTML = `
    <div class="d-top">
      ${chatAvatar(c, 'xl')}
      <div class="d-title">${esc(nameOf(c))}</div>
      ${!c.group && c.handle && c.handle !== nameOf(c) ? `<div class="d-handle">${esc(c.handle)}</div>` : ''}
      ${c.maybe ? '<div class="d-note">Name they shared with you. Not in your Contacts.</div>' : ''}
      ${!c.group && c.saved === false ? `<button class="add-contact" data-a="add">${ICON.addPerson}Add to Contacts</button>` : ''}
      ${tag}
    </div>
    <div class="d-quick">
      <button data-a="fav" class="${fav ? 'on' : ''}">${ICON.star}${fav ? 'Favorited' : 'Favorite'}</button>
      <button data-a="read">${ICON.unread}${u ? 'Mark read' : 'Mark unread'}</button>
      <button data-a="open">${ICON.open}Messages</button>
    </div>
    <div class="d-section">
      <div class="d-label">${c.group ? `Members (${members.length})` : 'Contact'}</div>
      ${members
        .map(
          (m) => `<div class="member">${avatar(m.maybe || m.name, 'sm', m.handle)}<div><div class="mn">${m.maybe ? '<span class="maybe-pre">Maybe:</span> ' + esc(m.maybe) : esc(m.name)}</div>${(m.maybe || m.name) !== m.handle ? `<div class="mh">${esc(m.handle || '')}</div>` : ''}</div>${c.group && m.saved === false ? `<button class="add-link" data-add="${esc(m.rawHandle || m.handle)}" data-maybe="${esc(m.maybe || '')}" data-sender="${esc(m.name)}">Add</button>` : ''}</div>`
        )
        .join('')}
    </div>
    <div class="d-section">
      <div class="d-label">Actions</div>
      <button class="d-action" data-a="read">${ICON.unread}${u ? 'Mark as read' : 'Mark as unread'}</button>
      <button class="d-action" data-a="fav">${ICON.star}${fav ? 'Remove from Favorites' : 'Add to Favorites'}</button>
      <button class="d-action" data-a="team">${ICON.team}Send to team on WhatsApp</button>
      <button class="d-action" data-a="open">${ICON.open}Open in Messages app</button>
      <button class="d-action danger" data-a="delete">${ICON.trash}Delete conversation</button>
    </div>`
}

function chatAction(c, a) {
  if (!c) return
  if (a === 'read') isUnread(c) ? markRead(c) : markUnread(c)
  if (a === 'fav') toggleFav(c)
  if (a === 'open') window.imsg.openInMessages(c.group ? '' : c.rawHandle || c.handle)
  if (a === 'add') return openContactForm(c.rawHandle || c.handle, c.maybe)
  if (a === 'delete') return hideChat(c)
  if (a === 'team') {
    const last = c.id === currentChat()?.id ? [...curMsgs].reverse().find((m) => !m.fromMe && m.text) : null
    return openWaForm(c, last || { text: c.last.replace(/^You: /, '') })
  }
  renderChats()
}

function showContextMenu(c, x, y) {
  const m = $('#ctx')
  m.innerHTML = `<button data-a="read">${isUnread(c) ? 'Mark as read' : 'Mark as unread'}</button>
    <button data-a="fav">${isFav(c) ? 'Remove from Favorites' : 'Add to Favorites'}</button>
    ${!c.group && c.saved === false ? '<button data-a="add">Add to Contacts…</button>' : ''}
    <button data-a="team">Send to team on WhatsApp…</button>
    <button data-a="open">Open in Messages app</button>
    <button data-a="delete" class="danger">Delete conversation</button>`
  m.style.left = Math.min(x, innerWidth - 200) + 'px'
  m.style.top = Math.min(y, innerHeight - 120) + 'px'
  m.hidden = false
  m.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a
    m.hidden = true
    chatAction(c, a)
  }
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx')) $('#ctx').hidden = true
})

async function loadMessages(chat, scroll = true) {
  if (scroll) markRead(chat) // opening a conversation reads it
  if (scroll) window.imsg.viewing(chat.guid)
  if (scroll && current && current.id !== chat.id) clearTray()
  current = chat
  $('#to').hidden = true
  $('#to-list').hidden = true
  $('#text').placeholder = `Message ${chat.group ? chat.title : firstName(nameOf(chat))}…`
  let msgs
  try {
    msgs = await window.imsg.messages(chat.id)
  } catch (e) {
    return showError(e.message)
  }
  if (current !== chat && current?.id !== chat.id) return
  curMsgs = msgs
  const sig = chat.id + ':' + msgs.length + ':' + (msgs.length ? msgs[msgs.length - 1].id : 0)
  if (!scroll && sig === lastSig) return
  lastSig = sig
  const box = $('#messages')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  let html = ''
  let lastDay = ''
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const prev = msgs[i - 1]
    const next = msgs[i + 1]
    const who = (x) => (x ? (x.fromMe ? '\u0000me' : x.sender) : null)
    const day = new Date(m.date).toDateString()
    if (day !== lastDay) {
      html += `<div class="day">${esc(dayLabel(m.date))}</div>`
      lastDay = day
    }
    const first = !prev || who(prev) !== who(m) || new Date(prev.date).toDateString() !== day || m.date - prev.date > 15 * 60e3
    const last = !next || who(next) !== who(m) || new Date(next.date).toDateString() !== day || next.date - m.date > 15 * 60e3
    const atts = m.attachments || []
    const media = atts.map(attachmentHtml).join('')
    const body = m.text ? linkify(m.text) : atts.length ? '' : '<span class="att">📎 Attachment (open in Messages to view)</span>'
    const time = new Date(m.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    html += `<div data-mid="${m.id}" class="row ${m.fromMe ? 'me' : 'them'} ${m.service === 'SMS' ? 'sms' : ''} ${first ? 'first' : ''} ${last ? 'last' : ''}">
      ${m.fromMe ? '' : avatar(m.senderMaybe || m.sender, 'sm', m.sender)}
      <div class="bubble-wrap">
        ${chat.group && !m.fromMe && first ? `<div class="sender" style="color:${colorFor(m.sender)}">${m.senderMaybe ? '<span class="maybe-pre">Maybe:</span> ' + esc(m.senderMaybe) : esc(m.sender)}</div>` : ''}
        ${media ? `<div class="media">${media}</div>` : ''}
        ${body ? `<div class="bubble" title="${esc(new Date(m.date).toLocaleString())}">${body}</div>` : ''}
        ${last ? `<div class="meta">${esc(time)}${m.fromMe && m.service === 'SMS' ? ' · SMS' : ''}</div>` : ''}
      </div></div>`
  }
  box.innerHTML = html || '<div class="empty">No messages yet</div>'
  if (scroll || atBottom) box.scrollTop = box.scrollHeight
  renderChats()
}

// photos and videos show inline; other files show as a chip you can open in Finder
function attachmentHtml(a) {
  const src = `imsg-att://file/${Number(a.id)}`
  if (/^image\//.test(a.mime)) return `<img class="att-img" src="${src}" data-att="${Number(a.id)}" alt="${esc(a.name)}" loading="lazy" />`
  if (/^video\//.test(a.mime)) return `<video class="att-video" src="${src}" controls preload="metadata"></video>`
  if (/^audio\//.test(a.mime)) return `<audio class="att-audio" src="${src}" controls preload="none"></audio>`
  const kb = a.size ? (a.size > 1e6 ? (a.size / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size / 1e3)) + ' KB') : ''
  return `<button class="att-file" data-reveal="${Number(a.id)}">📎 <span>${esc(a.name || 'File')}</span>${kb ? ` <small>${kb}</small>` : ''}</button>`
}
$('#messages').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-att]')
  if (img) {
    $('#lightbox img').src = img.src
    $('#lightbox').dataset.att = img.dataset.att
    $('#lightbox').hidden = false
    return
  }
  const f = e.target.closest('[data-reveal]')
  if (f) window.imsg.revealAttachment(Number(f.dataset.reveal))
})
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox-reveal') return window.imsg.revealAttachment(Number($('#lightbox').dataset.att))
  $('#lightbox').hidden = true
})
document.addEventListener('keydown', (e) => e.key === 'Escape' && ($('#lightbox').hidden = true))
// a broken image (file not downloaded from iCloud yet, etc.) becomes a small note
document.addEventListener(
  'error',
  (e) => {
    if (e.target.matches?.('img.att-img')) e.target.outerHTML = '<div class="bubble"><span class="att">📷 Photo not on this Mac yet (open in Messages)</span></div>'
  },
  true
)

function showError(msg) {
  $('#error').textContent = msg
  $('#error').hidden = false
  setTimeout(() => ($('#error').hidden = true), 8000)
}

// ---- events
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  filter = b.dataset.f
  renderChats()
})
const chatFromEvent = (e) => {
  const el = e.target.closest('[data-id]')
  return el && chats.find((x) => x.id === Number(el.dataset.id))
}
for (const sel of ['#chats', '#favs']) {
  $(sel).addEventListener('contextmenu', (e) => {
    const c = chatFromEvent(e)
    if (!c) return
    e.preventDefault()
    showContextMenu(c, e.clientX, e.clientY)
  })
  $(sel).addEventListener('click', (e) => {
    const c = chatFromEvent(e)
    if (c) loadMessages(c)
  })
}
$('#hdr-unread').addEventListener('click', () => chatAction(currentChat(), 'read'))
$('#hdr-add').addEventListener('click', () => chatAction(currentChat(), 'add'))
$('#hdr-fav').addEventListener('click', () => chatAction(currentChat(), 'fav'))
$('#hdr-info').addEventListener('click', () => {
  showDetails = !showDetails
  try {
    localStorage.setItem('imsg-details', showDetails ? '1' : '0')
  } catch {}
  renderHeader()
  renderDetails()
})
$('#details').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]')
  if (add) return openContactForm(add.dataset.add, add.dataset.maybe, add.dataset.sender)
  const a = e.target.closest('button[data-a]')?.dataset.a
  if (a) chatAction(currentChat(), a)
})
$('#messages').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]')
  if (a) {
    e.preventDefault()
    window.imsg.openUrl(a.dataset.href)
  }
})
$('#search').addEventListener('input', renderChats)
$('#compose').addEventListener('click', () => {
  current = { compose: true }
  lastSig = ''
  $('#chat-title').textContent = 'New message'
  $('#chat-sub').textContent = ''
  $('#messages').innerHTML = '<div class="empty"><div class="empty-ico">✍️</div>Type a phone number or email above, then your message.</div>'
  $('#text').placeholder = 'Write a message…'
  $('#to').hidden = false
  $('#to').value = ''
  toValue = ''
  $('#to').focus()
  showToList()
  renderChats()
})
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#send-form').requestSubmit()
  }
})
$('#text').addEventListener('input', (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = e.target.scrollHeight + 'px'
})
// ---- pictures and files to send (paste, drag and drop, or the paperclip)
let pending = [] // [{ file, url }]
function addFiles(files) {
  for (const f of files) {
    if (!f || !f.size) continue
    if (f.size > 100 * 1024 * 1024) {
      showError(`${f.name} is larger than 100 MB.`)
      continue
    }
    pending.push({ file: f, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : '' })
  }
  renderTray()
  $('#text').focus()
}
function renderTray() {
  $('#tray').innerHTML = pending
    .map((p, i) => `<div class="tray-item">${p.url ? `<img src="${p.url}" alt="" />` : `📎<br>${esc(p.file.name)}`}<button type="button" data-rm="${i}" title="Remove">×</button></div>`)
    .join('')
  $('#tray').hidden = !pending.length
}
function clearTray() {
  pending.forEach((p) => p.url && URL.revokeObjectURL(p.url))
  pending = []
  renderTray()
}
$('#tray').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]')
  if (!b) return
  const [p] = pending.splice(Number(b.dataset.rm), 1)
  if (p && p.url) URL.revokeObjectURL(p.url)
  renderTray()
})
$('#attach').addEventListener('click', () => $('#file-pick').click())
$('#file-pick').addEventListener('change', (e) => {
  addFiles([...e.target.files])
  e.target.value = ''
})
const namedFile = (f, i) =>
  f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })
// Ask the browser for pictures/files on the clipboard (Finder copies, screenshots, Photos).
async function pasteFromBrowser() {
  try {
    const got = (await window.imsg.clipboardFiles()) || []
    if (got.length) {
      addFiles(got.map((g) => new File([g.bytes], g.name, { type: g.type })))
      return true
    }
  } catch {}
  return false
}
let lastPasteAt = 0
document.addEventListener('paste', async (e) => {
  lastPasteAt = Date.now()
  if (!current || !e.clipboardData) return
  if (e.target.closest && e.target.closest('.sheet')) return // forms paste normally
  const dt = e.clipboardData
  let files = [...dt.files]
  if (!files.length) files = [...dt.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
  if (files.length) {
    e.preventDefault()
    return addFiles(files.map(namedFile))
  }
  if (e.target.id === 'to') return // the To field takes text as usual
  const text = dt.getData('text/plain')
  e.preventDefault()
  // Finder copies arrive as just the file name, so check for real files first, then paste the text.
  if (await pasteFromBrowser()) return
  if (text) {
    const box = $('#text')
    if (document.activeElement !== box) box.focus()
    document.execCommand('insertText', false, text) || (box.value += text)
    box.dispatchEvent(new Event('input'))
  }
})
// Safety net: if Cmd+V didn't produce a paste event (nothing focused), still pick up pictures.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'v' || e.shiftKey || e.altKey || !current) return
  if (e.target.closest && e.target.closest('.sheet')) return
  const at = Date.now()
  setTimeout(() => lastPasteAt < at && pasteFromBrowser(), 250)
})
let dragDepth = 0
$('#convo').addEventListener('dragenter', (e) => {
  if (!current || ![...(e.dataTransfer?.types || [])].includes('Files')) return
  dragDepth++
  $('#convo').classList.add('dragging')
})
$('#convo').addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    $('#convo').classList.remove('dragging')
  }
})
$('#convo').addEventListener('dragover', (e) => current && e.preventDefault())
$('#convo').addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('#convo').classList.remove('dragging')
  if (current) addFiles([...e.dataTransfer.files])
})

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('#text').value.trim()
  if ((!text && !pending.length) || !current) return
  let target
  if (current.compose) {
    const to = toValue || $('#to').value.trim()
    if (!to) return $('#to').focus()
    target = { handle: to }
  } else target = { guid: current.guid }
  $('#send').disabled = true
  try {
    // pictures first, then the text (like on the iPhone)
    while (pending.length) {
      const p = pending[0]
      await window.imsg.sendFile(target, p.file.name, new Uint8Array(await p.file.arrayBuffer()))
      if (p.url) URL.revokeObjectURL(p.url)
      pending.shift()
      renderTray()
    }
    if (text) {
      if (target.handle) await window.imsg.sendToHandle(target.handle, text)
      else await window.imsg.sendToChat(target.guid, text)
    }
    $('#text').value = ''
    $('#text').style.height = 'auto'
    setTimeout(refreshChats, 800)
    setTimeout(refreshChats, 3000)
  } catch (err) {
    showError('Could not send: ' + String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') + ' (Allow the browser to control Messages in System Settings → Privacy & Security → Automation.)')
  } finally {
    $('#send').disabled = false
  }
})
// ---- add a contact (saved through the Contacts app, so it syncs to iCloud and your iPhone)
function openContactForm(handle, maybe, sender) {
  const f = $('#contact-form')
  f.reset()
  f.querySelectorAll('.found').forEach((i) => i.classList.remove('found'))
  $('#contact-err').hidden = true
  const isEmail = /@/.test(handle || '')
  // Read what they texted you (newest first). If you highlighted text in the chat, that wins.
  const selected = String(window.getSelection() || '').trim()
  const theirs = curMsgs.filter((m) => !m.fromMe && m.text && (!sender || m.sender === sender)).map((m) => m.text).reverse()
  const found = window.contactParse.fromMessages(selected ? [selected, ...theirs] : theirs)
  const parts = String(maybe || '').trim().split(/\s+/).filter(Boolean)
  const set = (k, v, fromText) => {
    if (!v) return
    f[k].value = v
    if (fromText) f[k].classList.add('found')
  }
  // The whole name goes in one field (saved as the first name), so it's easy to find later.
  if (found.first) set('first', [found.first, found.last].filter(Boolean).join(' '), true)
  else set('first', parts.join(' '))
  set('phone', isEmail ? '' : handle)
  set('email', isEmail ? handle : found.email, !isEmail)
  for (const k of ['street', 'city', 'state', 'zip']) set(k, found[k], true)
  const got = ['name', 'email', 'street'].filter((k) => (k === 'name' ? found.first : found[k])).map((k) => (k === 'street' ? 'address' : k))
  $('#contact-found').textContent = got.length ? `Filled in ${got.join(', ').replace(/, ([^,]*)$/, ' and $1')} from their messages. Check before saving.` : ''
  $('#contact-found').hidden = !got.length
  $('#contact-modal').hidden = false
  ;(f.first.value ? f.company : f.first).focus()
}
const closeContactForm = () => ($('#contact-modal').hidden = true)
$('#contact-cancel').addEventListener('click', closeContactForm)
$('#contact-modal').addEventListener('mousedown', (e) => e.target.id === 'contact-modal' && closeContactForm())
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#contact-modal').hidden && closeContactForm())
$('#contact-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target
  const data = Object.fromEntries(['first', 'company', 'phone', 'email', 'street', 'city', 'state', 'zip', 'note'].map((k) => [k, f[k].value.trim()]))
  data.last = ''
  if (!data.first && !data.company) {
    $('#contact-err').textContent = 'Enter a name or a company.'
    $('#contact-err').hidden = false
    return f.first.focus()
  }
  $('#contact-save').disabled = true
  try {
    await window.imsg.addContact(data)
    closeContactForm()
    toast('Saved to Contacts')
    setTimeout(refreshChats, 1500)
    setTimeout(refreshChats, 5000)
  } catch (err) {
    $('#contact-err').textContent = 'Could not save: ' + String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') + ' (If macOS asked, allow the browser to control Contacts in System Settings → Privacy & Security → Automation.)'
    $('#contact-err').hidden = false
  } finally {
    $('#contact-save').disabled = false
  }
})
function toast(msg, actionLabel, action) {
  let t = $('#toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'toast'
    document.body.appendChild(t)
  }
  t.innerHTML = esc(msg) + (actionLabel ? ` <button>${esc(actionLabel)}</button>` : '')
  if (action) t.querySelector('button').onclick = () => {
    t.hidden = true
    action()
  }
  t.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (t.hidden = true), actionLabel ? 6000 : 2500)
}

// ---- swipe a conversation to the left (trackpad or mouse drag) to show Unread / Delete
const SW_OPEN = 150 // width of the two buttons
let swOpen = null // the row that is currently slid open
function slide(row, x, animate) {
  const item = row.querySelector('.item')
  item.style.transition = animate ? 'transform .18s ease' : 'none'
  item.style.transform = x ? `translateX(${-x}px)` : ''
  row.classList.toggle('sliding', x > 0)
  row._x = x
}
function closeSwipe(except) {
  if (swOpen && swOpen !== except && swOpen.isConnected) slide(swOpen, 0, true)
  if (swOpen !== except) swOpen = null
}
function settle(row) {
  const x = row._x || 0
  const c = chats.find((k) => k.id === Number(row.dataset.id))
  if (x > row.offsetWidth * 0.6 && c) {
    // a long swipe deletes right away, like on the iPhone
    slide(row, row.offsetWidth, true)
    setTimeout(() => hideChat(c), 180)
    swOpen = null
  } else if (x > 50) {
    slide(row, SW_OPEN, true)
    swOpen = row
  } else {
    slide(row, 0, true)
    if (swOpen === row) swOpen = null
  }
}
let wheelRow = null
let wheelTimer = null
$('#chats').addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const row = e.target.closest('.swipe')
    if (!row) return
    e.preventDefault()
    if (wheelRow !== row) {
      closeSwipe(row)
      wheelRow = row
    }
    slide(row, Math.max(0, Math.min(row.offsetWidth, (row._x || 0) + e.deltaX)), false)
    clearTimeout(wheelTimer)
    wheelTimer = setTimeout(() => {
      settle(row)
      wheelRow = null
    }, 140)
  },
  { passive: false }
)
let drag = null
$('#chats').addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.swipe')
  if (!row || e.button !== 0 || e.target.closest('.swipe-actions')) return
  drag = { row, x0: e.clientX, y0: e.clientY, start: row._x || 0, moved: false }
})
document.addEventListener('pointermove', (e) => {
  if (!drag) return
  const dx = drag.x0 - e.clientX
  if (!drag.moved) {
    if (Math.abs(dx) < 8 || Math.abs(e.clientY - drag.y0) > Math.abs(dx)) return
    drag.moved = true
    closeSwipe(drag.row)
  }
  slide(drag.row, Math.max(0, Math.min(drag.row.offsetWidth, drag.start + dx)), false)
})
document.addEventListener('pointerup', () => {
  if (!drag) return
  const d = drag
  drag = null
  if (d.moved) {
    settle(d.row)
    // swallow the click that follows a drag
    d.row.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true })
  }
})
$('#chats').addEventListener(
  'click',
  (e) => {
    const b = e.target.closest('[data-sw]')
    if (b) {
      e.stopPropagation()
      const row = b.closest('.swipe')
      const c = chats.find((k) => k.id === Number(row.dataset.id))
      swOpen = null
      if (!c) return
      if (b.dataset.sw === 'delete') {
        slide(row, row.offsetWidth, true)
        setTimeout(() => hideChat(c), 180)
      } else chatAction(c, 'read')
      return
    }
    const row = e.target.closest('.swipe')
    if (row && row._x > 0) {
      // tapping a slid-open row just closes it
      e.stopPropagation()
      slide(row, 0, true)
      swOpen = null
    }
  },
  true
)
document.addEventListener('mousedown', (e) => {
  if (swOpen && !e.target.closest('.swipe')) closeSwipe(null)
})

// ---- send a text to a teammate on WhatsApp
function teamOptions(selected) {
  return (
    prefs.team.map((t, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(t.name)}${t.phone ? ' · ' + esc(t.phone) : ''}</option>`).join('') +
    '<option value="new">+ Add a teammate…</option><option value="paste">A group or someone else (copy and paste)</option>'
  )
}
function openWaForm(chat, msg) {
  const f = $('#wa-form')
  f.reset()
  $('#wa-err').hidden = true
  const who = nameOf(chat) + (chat.handle && chat.handle !== nameOf(chat) ? ` (${chat.handle})` : '')
  const body = msg && msg.text ? msg.text : ''
  f.text.value = `Message from ${who}:\n"${body}"\n\n`
  let last = -1
  try {
    last = Number(localStorage.getItem('wa-last') ?? -1)
  } catch {}
  const sel = prefs.team[last] ? last : prefs.team.length ? 0 : -1
  $('#wa-to').innerHTML = teamOptions(sel)
  if (sel < 0) $('#wa-to').value = 'new'
  syncWaTo()
  $('#wa-modal').hidden = false
  ;($('#wa-to').value === 'new' ? f.name : f.text).focus()
  f.text.setSelectionRange(f.text.value.length, f.text.value.length)
}
function syncWaTo() {
  const v = $('#wa-to').value
  $('#wa-new').hidden = v !== 'new'
  $('#wa-remove').hidden = !/^\d+$/.test(v)
}
const closeWa = () => ($('#wa-modal').hidden = true)
$('#wa-to').addEventListener('change', () => {
  syncWaTo()
  if ($('#wa-to').value === 'new') $('#wa-form').name.focus()
})
$('#wa-cancel').addEventListener('click', closeWa)
$('#wa-modal').addEventListener('mousedown', (e) => e.target.id === 'wa-modal' && closeWa())
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#wa-modal').hidden && closeWa())
$('#wa-remove').addEventListener('click', () => {
  prefs.team.splice(Number($('#wa-to').value), 1)
  savePrefs()
  $('#wa-to').innerHTML = teamOptions(prefs.team.length ? 0 : -1)
  if (!prefs.team.length) $('#wa-to').value = 'new'
  syncWaTo()
})
const withCountry = (p) => {
  const d = String(p || '').replace(/\D/g, '')
  return d.length === 10 ? '+1' + d : p // US number without country code
}
$('#wa-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target
  const err = (m) => {
    $('#wa-err').textContent = m
    $('#wa-err').hidden = false
  }
  let v = $('#wa-to').value
  let phone = ''
  if (v === 'new') {
    const name = f.name.value.trim()
    phone = withCountry(f.phone.value.trim())
    if (!name) return err('Enter the teammate’s name.')
    if (phone.replace(/\D/g, '').length < 10) return err('Enter their WhatsApp number with area code.')
    prefs.team.push({ name, phone })
    savePrefs()
    v = String(prefs.team.length - 1)
  }
  if (/^\d+$/.test(v)) {
    phone = withCountry(prefs.team[Number(v)].phone)
    try {
      localStorage.setItem('wa-last', v)
    } catch {}
  }
  await window.imsg.whatsapp(phone, f.text.value.trim())
  closeWa()
  if (!phone) toast('Message copied. Pick the chat in WhatsApp and paste (Cmd+V).')
})
// right-click a message bubble
$('#messages').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row[data-mid]')
  const c = currentChat()
  if (!row || !c || String(window.getSelection() || '').trim()) return // keep the normal copy menu when text is selected
  const m = curMsgs.find((x) => String(x.id) === row.dataset.mid)
  if (!m) return
  e.preventDefault()
  const menu = $('#ctx')
  menu.innerHTML = `<button data-a="wa">Send to team on WhatsApp…</button><button data-a="copy">Copy message</button>${!m.fromMe && c.saved === false && !c.group ? '<button data-a="add">Add to Contacts…</button>' : ''}`
  menu.style.left = Math.min(e.clientX, innerWidth - 220) + 'px'
  menu.style.top = Math.min(e.clientY, innerHeight - 110) + 'px'
  menu.hidden = false
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a
    menu.hidden = true
    if (a === 'wa') openWaForm(c, m)
    if (a === 'copy') navigator.clipboard.writeText(m.text || '').then(() => toast('Copied'), () => {})
    if (a === 'add') chatAction(c, 'add')
  }
})

// ---- "To:" search across your Contacts
let contactsCache = null
let toValue = '' // the phone/email picked from the list
let toSel = 0
const digitsOf = (v) => String(v || '').replace(/\D/g, '').slice(-10)
async function showToList() {
  if (!contactsCache) {
    try {
      contactsCache = await window.imsg.contacts()
    } catch {
      contactsCache = []
    }
  }
  const q = $('#to').value.trim().toLowerCase()
  const qd = q.replace(/\D/g, '')
  const hits = contactsCache
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q) || (qd.length >= 3 && digitsOf(c.value).includes(qd)))
    .slice(0, 80)
  toSel = Math.min(toSel, Math.max(0, hits.length - 1))
  const list = $('#to-list')
  list.innerHTML = hits.length
    ? hits
        .map(
          (c, i) => `<div class="to-item ${i === toSel ? 'sel' : ''}" data-i="${i}">${avatar(c.name, 'sm', c.value)}<div><div class="tn">${esc(c.name)}</div><div class="tv">${esc(c.value)}</div></div><span class="tk">${c.kind === 'email' ? 'email' : 'phone'}</span></div>`
        )
        .join('')
    : `<div class="to-empty">${contactsCache.length ? 'No matching contacts. You can still type a number or email.' : 'No contacts found on this Mac.'}</div>`
  list._hits = hits
  list.hidden = false
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
}
function pickTo(c) {
  $('#to-list').hidden = true
  // already have a conversation with them? open it instead of starting a new one
  const d = digitsOf(c.value)
  const existing = chats.find((x) => !x.group && (c.kind === 'email' ? String(x.rawHandle || '').toLowerCase() === c.value.toLowerCase() : d.length >= 7 && digitsOf(x.rawHandle) === d))
  if (existing) return loadMessages(existing)
  toValue = c.value
  $('#to').value = `${c.name} (${c.value})`
  $('#chat-title').textContent = c.name
  $('#chat-sub').textContent = c.value
  $('#text').placeholder = `Message ${firstName(c.name)}…`
  $('#text').focus()
}
$('#to').addEventListener('input', () => {
  toValue = ''
  toSel = 0
  showToList()
})
$('#to').addEventListener('focus', () => !toValue && showToList())
$('#to').addEventListener('blur', () => setTimeout(() => ($('#to-list').hidden = true), 150))
$('#to').addEventListener('keydown', (e) => {
  const hits = $('#to-list')._hits || []
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    toSel = Math.max(0, Math.min(hits.length - 1, toSel + (e.key === 'ArrowDown' ? 1 : -1)))
    showToList()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (!$('#to-list').hidden && hits[toSel]) pickTo(hits[toSel])
    else $('#text').focus()
  } else if (e.key === 'Escape') $('#to-list').hidden = true
})
$('#to-list').addEventListener('mousedown', (e) => {
  const it = e.target.closest('.to-item')
  if (!it) return
  e.preventDefault()
  pickTo($('#to-list')._hits[Number(it.dataset.i)])
})

$('#open-privacy').addEventListener('click', () => window.imsg.openPrivacySettings())

boot()


// ---- quick replies: ⚡ button or "/" at the start of the message box. {name} becomes the person's first name.
let qrList = []
let qrSel = 0
function qrFill(text) {
  const c = current && !current.compose ? current : null
  let first = c && !c.group ? firstName(nameOf(c)) : ''
  if (isNumberish(first)) first = ''
  return String(text).replace(/\s*\{name\}/g, first ? ' ' + first : '').replace(/^\s+/, '').replace(/\s+([,!.?])/g, '$1')
}
function qrMatches() {
  const q = $('#qr-search').value.trim().toLowerCase()
  return qrList.filter((r) => !q || (r.title + ' ' + r.text).toLowerCase().includes(q))
}
function qrRender() {
  const items = qrMatches()
  if (qrSel >= items.length) qrSel = Math.max(0, items.length - 1)
  $('#qr-list').innerHTML = items.length
    ? items.map((r, i) => `<button type="button" class="qr-item ${i === qrSel ? 'sel' : ''}" data-i="${qrList.indexOf(r)}"><b>${esc(r.title || r.text.slice(0, 30))}</b><span>${esc(qrFill(r.text))}</span></button>`).join('')
    : '<div class="qr-empty">No quick replies yet. Click Edit to add one.</div>'
}
function qrOpen(fromSlash) {
  $('#qr-pop').hidden = false
  $('#qr-btn').classList.add('on')
  $('#qr-editor').hidden = true
  $('#qr-list').hidden = false
  $('#qr-search').hidden = false
  $('#qr-edit').textContent = 'Edit'
  $('#qr-search').value = ''
  qrSel = 0
  qrRender()
  if (!fromSlash) $('#qr-search').focus()
}
function qrClose() {
  $('#qr-pop').hidden = true
  $('#qr-btn').classList.remove('on')
}
function qrUse(r) {
  const box = $('#text')
  if (/^\/\S*$/.test(box.value)) box.value = ''
  box.focus()
  const text = qrFill(r.text)
  if (!document.execCommand('insertText', false, text)) box.value += text
  box.dispatchEvent(new Event('input', { bubbles: true }))
  qrClose()
}
function qrEditor() {
  const ed = $('#qr-editor')
  ed.innerHTML = `<div class="qr-tip">Write {name} where the person's first name should go.</div>` +
    qrList.map((r, i) => `<div class="qr-ed" data-i="${i}"><input class="t" placeholder="Short name, e.g. On my way" value="${esc(r.title)}"/><textarea class="x" rows="2" placeholder="Message">${esc(r.text)}</textarea><button type="button" class="del">Delete</button></div>`).join('') +
    `<div class="qr-ed-actions"><button type="button" id="qr-add">+ Add quick reply</button><button type="button" id="qr-save" class="primary">Save</button></div>`
  ed.hidden = false
  $('#qr-list').hidden = true
  $('#qr-search').hidden = true
  $('#qr-edit').textContent = 'Done'
}
function qrCollect() {
  return [...document.querySelectorAll('#qr-editor .qr-ed')].map((d) => ({ title: d.querySelector('.t').value.trim(), text: d.querySelector('.x').value }))
}
async function setupQuickReplies() {
  try { qrList = await window.imsg.quickReplies() } catch {}
  window.imsg.onQuickReplies((l) => { qrList = l; if (!$('#qr-pop').hidden && $('#qr-editor').hidden) qrRender() })
  $('#qr-btn').addEventListener('click', () => ($('#qr-pop').hidden ? qrOpen() : qrClose()))
  $('#qr-search').addEventListener('input', () => { qrSel = 0; qrRender() })
  $('#qr-list').addEventListener('click', (e) => {
    const b = e.target.closest('.qr-item')
    if (b) qrUse(qrList[+b.dataset.i])
  })
  const keys = (e) => {
    if ($('#qr-pop').hidden || !$('#qr-editor').hidden) return
    const items = qrMatches()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      qrSel = (qrSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length)
      qrRender()
    } else if (e.key === 'Enter' && items[qrSel]) {
      e.preventDefault()
      e.stopImmediatePropagation()
      qrUse(items[qrSel])
    } else if (e.key === 'Escape') {
      qrClose()
    }
  }
  $('#qr-search').addEventListener('keydown', keys)
  $('#text').addEventListener('keydown', keys, true)
  // "/" at the start of the message box opens the list and filters as you type
  $('#text').addEventListener('input', () => {
    const v = $('#text').value
    const m = /^\/(\S*)$/.exec(v)
    if (m) {
      if ($('#qr-pop').hidden) qrOpen(true)
      $('#qr-search').value = m[1]
      qrSel = 0
      qrRender()
    } else if (!$('#qr-pop').hidden && $('#qr-editor').hidden && document.activeElement === $('#text')) qrClose()
  })
  const qrSave = async () => {
    try { qrList = await window.imsg.setQuickReplies(qrCollect()) } catch {}
    toast('Quick replies saved')
    qrOpen()
  }
  $('#qr-edit').addEventListener('click', () => ($('#qr-editor').hidden ? qrEditor() : qrSave()))
  $('#qr-editor').addEventListener('click', async (e) => {
    if (e.target.classList.contains('del')) {
      e.target.closest('.qr-ed').remove()
    } else if (e.target.id === 'qr-add') {
      qrList = qrCollect().concat([{ title: '', text: '' }])
      qrEditor()
      const all = document.querySelectorAll('#qr-editor .qr-ed .t')
      all[all.length - 1]?.focus()
    } else if (e.target.id === 'qr-save') qrSave()
  })
  document.addEventListener('mousedown', (e) => {
    if (!$('#qr-pop').hidden && !e.target.closest('#qr-pop') && !e.target.closest('#qr-btn') && $('#qr-editor').hidden) qrClose()
  })
}
