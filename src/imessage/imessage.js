// Built-in iMessage page.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let chats = []
let current = null // chat object, or { compose: true }
let lastSig = ''

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
  await refreshChats()
  setInterval(refreshChats, 5000)
}

async function refreshChats() {
  try {
    chats = await window.imsg.chats()
  } catch (e) {
    return showError(e.message)
  }
  const unread = chats.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0)
  document.title = unread ? `Messages (${unread})` : 'Messages'
  renderChats()
  if (current && current.id) {
    const c = chats.find((x) => x.id === current.id)
    if (c) loadMessages(c, false)
  }
}

function renderChats() {
  const q = $('#search').value.trim().toLowerCase()
  $('#chats').innerHTML = chats
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.last.toLowerCase().includes(q))
    .map(
      (c) => `<li data-id="${c.id}" class="${current && current.id === c.id ? 'active' : ''}">
        <div class="avatar">${esc(c.group ? '👥' : /^[+\d(]/.test(c.title) ? '👤' : initials(c.title))}</div>
        <div class="ci"><div class="row1"><span class="title">${esc(c.title)}</span><span class="time">${esc(fmtTime(c.date))}</span></div>
        <div class="last">${esc(c.last)}</div></div>
        ${c.unread ? '<span class="unread-dot"></span>' : ''}
      </li>`
    )
    .join('')
}

async function loadMessages(chat, scroll = true) {
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
    const body = m.text ? esc(m.text) : m.attachment ? '<span class="att">📎 Attachment (open in Messages to view)</span>' : ''
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
