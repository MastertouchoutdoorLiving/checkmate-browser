// Built-in iMessage page.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let chats = []
let current = null // chat object, or { compose: true }
let lastSig = ''
let filter = 'all'
let prefs = { favorites: [], readUpTo: {}, manualUnread: {} }
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
      $('#who').textContent = st.packaged ? 'MultiSpace Browser' : 'Terminal'
      $('#detail').textContent = st.detail || ''
    }
    return
  }
  $('#app').hidden = false
  try {
    prefs = { favorites: [], readUpTo: {}, manualUnread: {}, ...(await window.imsg.prefs()) }
  } catch {}
  await refreshChats()
  setInterval(refreshChats, 5000)
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
  const unreadN = chats.filter(isUnread).length
  document.title = unreadN ? `Messages (${unreadN})` : 'Messages'
  $('#unread-count').textContent = unreadN || ''
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter))
  const q = $('#search').value.trim().toLowerCase()

  // favorites as big avatars at the top, with a peek at the newest unread message
  const favs = chats.filter(isFav)
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

  const list = chats.filter((c) => {
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
    html += `<div data-id="${c.id}" class="item ${current && current.id === c.id ? 'active' : ''} ${u ? 'is-unread' : ''}">
      ${chatAvatar(c, '')}
      <div class="ci"><div class="row1"><span class="title"><span class="tname">${isFav(c) ? '<span class="star">★</span>' : ''}${esc(nameOf(c))}</span>${maybeTag(c.maybe)}</span><span class="time">${esc(fmtTime(c.date))}</span></div>
      <div class="last">${esc(c.last)}</div></div>
      ${u ? '<span class="dot"></span>' : ''}
    </div>`
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
          (m) => `<div class="member">${avatar(m.maybe || m.name, 'sm', m.handle)}<div><div class="mn">${m.maybe ? '<span class="maybe-pre">Maybe:</span> ' + esc(m.maybe) : esc(m.name)}</div>${(m.maybe || m.name) !== m.handle ? `<div class="mh">${esc(m.handle || '')}</div>` : ''}</div></div>`
        )
        .join('')}
    </div>
    <div class="d-section">
      <div class="d-label">Actions</div>
      <button class="d-action" data-a="read">${ICON.unread}${u ? 'Mark as read' : 'Mark as unread'}</button>
      <button class="d-action" data-a="fav">${ICON.star}${fav ? 'Remove from Favorites' : 'Add to Favorites'}</button>
      <button class="d-action" data-a="open">${ICON.open}Open in Messages app</button>
    </div>`
}

function chatAction(c, a) {
  if (!c) return
  if (a === 'read') isUnread(c) ? markRead(c) : markUnread(c)
  if (a === 'fav') toggleFav(c)
  if (a === 'open') window.imsg.openInMessages(c.group ? '' : c.rawHandle || c.handle)
  renderChats()
}

function showContextMenu(c, x, y) {
  const m = $('#ctx')
  m.innerHTML = `<button data-a="read">${isUnread(c) ? 'Mark as read' : 'Mark as unread'}</button>
    <button data-a="fav">${isFav(c) ? 'Remove from Favorites' : 'Add to Favorites'}</button>
    <button data-a="open">Open in Messages app</button>`
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
  current = chat
  $('#to').hidden = true
  $('#text').placeholder = `Message ${chat.group ? chat.title : firstName(nameOf(chat))}…`
  let msgs
  try {
    msgs = await window.imsg.messages(chat.id)
  } catch (e) {
    return showError(e.message)
  }
  if (current !== chat && current?.id !== chat.id) return
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
    const body = m.text ? linkify(m.text) : '<span class="att">📎 Photo or attachment (open in Messages to view)</span>'
    const time = new Date(m.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    html += `<div class="row ${m.fromMe ? 'me' : 'them'} ${m.service === 'SMS' ? 'sms' : ''} ${first ? 'first' : ''} ${last ? 'last' : ''}">
      ${m.fromMe ? '' : avatar(m.senderMaybe || m.sender, 'sm', m.sender)}
      <div class="bubble-wrap">
        ${chat.group && !m.fromMe && first ? `<div class="sender" style="color:${colorFor(m.sender)}">${m.senderMaybe ? '<span class="maybe-pre">Maybe:</span> ' + esc(m.senderMaybe) : esc(m.sender)}</div>` : ''}
        <div class="bubble" title="${esc(new Date(m.date).toLocaleString())}">${body}</div>
        ${last ? `<div class="meta">${esc(time)}${m.fromMe && m.service === 'SMS' ? ' · SMS' : ''}</div>` : ''}
      </div></div>`
  }
  box.innerHTML = html || '<div class="empty">No messages yet</div>'
  if (scroll || atBottom) box.scrollTop = box.scrollHeight
  renderChats()
}

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
  $('#to').focus()
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
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('#text').value.trim()
  if (!text || !current) return
  $('#send').disabled = true
  try {
    if (current.compose) {
      const to = $('#to').value.trim()
      if (!to) return $('#to').focus()
      await window.imsg.sendToHandle(to, text)
    } else await window.imsg.sendToChat(current.guid, text)
    $('#text').value = ''
    $('#text').style.height = 'auto'
    setTimeout(refreshChats, 800)
  } catch (err) {
    showError('Could not send: ' + err.message + ' (Allow the browser to control Messages in System Settings → Privacy & Security → Automation.)')
  } finally {
    $('#send').disabled = false
  }
})
$('#open-privacy').addEventListener('click', () => window.imsg.openPrivacySettings())

boot()
