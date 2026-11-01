// Built-in iMessage page.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let chats = []
let current = null // chat object, or { compose: true }
let lastSig = ''
let filter = 'all'
let prefs = { favorites: [], readUpTo: {}, manualUnread: {} }

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

const initials = (t) => (t || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '#'
function fmtTime(ms) {
  const d = new Date(ms), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })
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
  // a new message after you read a chat makes it unread again
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

function avatarFor(c) {
  return esc(c.group ? '👥' : /^[+\d(]/.test(c.title) ? '👤' : initials(c.title))
}

function renderChats() {
  const unreadN = chats.filter(isUnread).length
  document.title = unreadN ? `Messages (${unreadN})` : 'Messages'
  $('#unread-count').textContent = unreadN ? `(${unreadN})` : ''
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter))

  // favorites row at the top (like pinned conversations)
  const favs = chats.filter(isFav)
  $('#favs').innerHTML = filter === 'all'
    ? favs
        .map(
          (c) => `<div class="fav ${current && current.id === c.id ? 'active' : ''}" data-id="${c.id}" title="${esc(c.title)}">
            <div class="avatar">${avatarFor(c)}</div><div class="fname">${esc(c.title)}</div>
            ${isUnread(c) ? '<span class="unread-dot"></span>' : ''}</div>`
        )
        .join('')
    : ''

  const q = $('#search').value.trim().toLowerCase()
  const list = chats.filter((c) => {
    if (q && !c.title.toLowerCase().includes(q) && !c.last.toLowerCase().includes(q)) return false
    if (filter === 'unread') return isUnread(c)
    if (filter === 'read') return !isUnread(c)
    if (filter === 'fav') return isFav(c)
    return !isFav(c) || q // favorites already shown on top in "All"
  })
  $('#chats').innerHTML =
    list
      .map(
        (c) => `<li data-id="${c.id}" class="${current && current.id === c.id ? 'active' : ''} ${isUnread(c) ? 'is-unread' : ''}">
        <div class="avatar">${avatarFor(c)}</div>
        <div class="ci"><div class="row1"><span class="title">${isFav(c) ? '<span class="star">★</span>' : ''}${esc(c.title)}</span><span class="time">${esc(fmtTime(c.date))}</span></div>
        <div class="last">${esc(c.last)}</div></div>
        ${isUnread(c) ? '<span class="unread-dot"></span>' : ''}
      </li>`
      )
      .join('') ||
    `<div class="empty-list">${filter === 'unread' ? 'No unread messages 🎉' : filter === 'fav' ? 'No favorites yet. Right-click a conversation → Add to Favorites.' : 'Nothing here'}</div>`
  renderHeader()
}

function renderHeader() {
  const c = current && current.id && chats.find((x) => x.id === current.id)
  $('#hdr-actions').hidden = !c
  if (!c) return
  $('#hdr-unread').textContent = isUnread(c) ? 'Mark read' : 'Mark unread'
  $('#hdr-fav').textContent = isFav(c) ? '★' : '☆'
  $('#hdr-fav').classList.toggle('on', isFav(c))
  $('#hdr-fav').title = isFav(c) ? 'Remove from Favorites' : 'Add to Favorites'
}

function showContextMenu(c, x, y) {
  const m = $('#ctx')
  m.innerHTML = `<button data-a="read">${isUnread(c) ? 'Mark as read' : 'Mark as unread'}</button>
    <button data-a="fav">${isFav(c) ? 'Remove from Favorites' : 'Add to Favorites'}</button>`
  m.style.left = Math.min(x, innerWidth - 200) + 'px'
  m.style.top = Math.min(y, innerHeight - 90) + 'px'
  m.hidden = false
  m.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a
    if (a === 'read') isUnread(c) ? markRead(c) : markUnread(c)
    if (a === 'fav') toggleFav(c)
    m.hidden = true
    renderChats()
  }
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx')) $('#ctx').hidden = true
})

async function loadMessages(chat, scroll = true) {
  if (scroll) markRead(chat) // opening a conversation reads it
  current = chat
  $('#to').hidden = true
  $('#chat-title').textContent = chat.title
  $('#text').placeholder = chat.service === 'SMS' ? 'Text Message' : 'iMessage'
  let msgs
  try {
    msgs = await window.imsg.messages(chat.id)
  } catch (e) {
    return showError(e.message)
  }
  const sig = chat.id + ':' + msgs.length + ':' + (msgs.length ? msgs[msgs.length - 1].id : 0)
  if (!scroll && sig === lastSig) return
  lastSig = sig
  const box = $('#messages')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  let html = ''
  let lastDay = ''
  let lastSender = ''
  for (const m of msgs) {
    const day = new Date(m.date).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
    if (day !== lastDay) {
      html += `<div class="day">${esc(day)}</div>`
      lastDay = day
      lastSender = ''
    }
    if (chat.group && !m.fromMe && m.sender !== lastSender) html += `<div class="sender">${esc(m.sender)}</div>`
    lastSender = m.fromMe ? 'me' : m.sender
    const body = m.text ? esc(m.text) : '<span class="att">📎 Photo or attachment (open in Messages to view)</span>'
    if (body) html += `<div class="msg ${m.fromMe ? 'me' : 'them'} ${m.service === 'SMS' ? 'sms' : ''}" title="${esc(new Date(m.date).toLocaleString())}">${body}</div>`
  }
  box.innerHTML = html || '<div class="empty">No messages</div>'
  if (scroll || atBottom) box.scrollTop = box.scrollHeight
  renderChats()
}

function showError(msg) {
  $('#error').textContent = msg
  $('#error').hidden = false
  setTimeout(() => ($('#error').hidden = true), 8000)
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  filter = b.dataset.f
  renderChats()
})
const chatFromEvent = (e) => {
  const el = e.target.closest('li[data-id], .fav[data-id]')
  return el && chats.find((x) => x.id === Number(el.dataset.id))
}
for (const sel of ['#chats', '#favs']) {
  $(sel).addEventListener('contextmenu', (e) => {
    const c = chatFromEvent(e)
    if (!c) return
    e.preventDefault()
    showContextMenu(c, e.clientX, e.clientY)
  })
}
$('#favs').addEventListener('click', (e) => {
  const c = chatFromEvent(e)
  if (c) loadMessages(c)
})
$('#hdr-unread').addEventListener('click', () => {
  const c = chats.find((x) => x.id === current?.id)
  if (!c) return
  isUnread(c) ? markRead(c) : markUnread(c)
  renderChats()
})
$('#hdr-fav').addEventListener('click', () => {
  const c = chats.find((x) => x.id === current?.id)
  if (!c) return
  toggleFav(c)
  renderChats()
})
$('#chats').addEventListener('click', (e) => {
  const li = e.target.closest('li')
  if (!li) return
  const c = chats.find((x) => x.id === Number(li.dataset.id))
  if (c) loadMessages(c)
})
$('#search').addEventListener('input', renderChats)
$('#compose').addEventListener('click', () => {
  current = { compose: true }
  lastSig = ''
  $('#chat-title').textContent = 'New message'
  $('#messages').innerHTML = '<div class="empty">Type a phone number or email above, then your message.</div>'
  $('#to').hidden = false
  $('#to').focus()
  renderChats()
})
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
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
