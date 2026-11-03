// "Unread": new iMessage, WhatsApp and other-app messages in one list. Click one to open it.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let filter = 'all'
let data = { items: [] }
let byKey = new Map()

const SRC = {
  imsg: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M12 4C6.9 4 3 7.3 3 11.3c0 2.3 1.3 4.4 3.4 5.7-.2 1.3-.8 2.4-1.8 3.2 1.8.1 3.5-.5 4.8-1.6.8.2 1.7.3 2.6.3 5.1 0 9-3.3 9-7.6S17.1 4 12 4z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zm4.6 12.4c-.2.6-1.1 1.1-1.6 1.2-.4.1-1 .1-1.6-.1-.4-.1-.8-.3-1.4-.5-2.5-1.1-4.1-3.6-4.2-3.8-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.3 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.7 1.2 1.5 1.9 1 .9 1.9 1.2 2.1 1.3.3.1.4.1.6-.1l.8-1c.2-.3.4-.2.6-.1l1.8.9c.3.1.4.2.5.3.1.2.1.6-.1 1.2z"/></svg>',
}
const LABEL = { imsg: 'iMessage', wa: 'WhatsApp', app: 'Other apps' }

function when(it) {
  if (it.time) return it.time
  if (!it.date) return ''
  const d = new Date(it.date)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const y = new Date(today - 864e5)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function row(it) {
  const icon = it.kind === 'app'
    ? (it.favicon ? `<img src="${esc(it.favicon)}" alt="">` : esc((it.name || '?')[0].toUpperCase()))
    : SRC[it.kind]
  const where = it.kind === 'imsg' ? 'iMessage' : it.kind === 'wa' ? 'WhatsApp' : ''
  const space = data.multiSpace && it.space ? ` · ${esc(it.space)}` : ''
  const preview = it.kind === 'app'
    ? (it.count > 0 ? `${it.count} unread` : 'New activity')
    : esc(it.preview || '')
  const count = it.count > 0 ? `<span class="count">${it.count > 99 ? '99+' : it.count}</span>` : ''
  const canReply = it.kind === 'imsg' || it.kind === 'wa'
  return `<div class="item ${it.key === openKey ? 'open' : ''}" role="button" tabindex="0" data-k="${esc(it.key)}">
    <span class="src ${it.kind}">${icon}</span>
    <span class="body">
      <span class="top"><span class="name">${esc(it.name)}</span><span class="where">${where}${space}</span>${it.job ? `<span class="job" title="JobTread job">🔨 ${esc(it.job)}</span>` : ''}<span class="time">${esc(when(it))}</span></span>
      <span class="preview">${preview}</span>
    </span>${count}${canReply ? `<span class="acts"><span class="act reply" title="Reply here">↩︎ Reply</span><span class="act go" title="Open the chat">↗</span></span>` : ''}</div>`
}

let lastSig = ''
function render(force) {
  const sig = filter + JSON.stringify(data)
  if (!force && sig === lastSig) return
  lastSig = sig
  const items = data.items || []
  byKey = new Map(items.map((i) => [i.key, i]))
  const n = (k) => items.filter((i) => k === 'all' || i.kind === k).length
  document.querySelectorAll('#filters button').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === filter)
    const c = n(b.dataset.f)
    b.innerHTML = `${b.dataset.f === 'all' ? 'All' : LABEL[b.dataset.f]}${c ? `<span class="n">${c}</span>` : ''}`
  })
  const total = items.length
  $('#total').textContent = total || ''
  document.title = total ? `Unread (${total})` : 'Unread'

  const notes = []
  if (data.imsgState === 'no-access') notes.push('iMessage is not connected yet. Open the iMessage app once to set it up.')
  if (!data.waOpen && (filter === 'all' || filter === 'wa')) notes.push('WhatsApp shows up here while it is open in the browser. Open WhatsApp once and leave it signed in.')
  $('#notes').innerHTML = notes.map((t) => `<div class="note">${esc(t)}</div>`).join('')

  const shown = items.filter((i) => filter === 'all' || i.kind === filter)
  if (!shown.length) {
    document.body.appendChild($('#reply'))
    $('#list').innerHTML = '<div class="empty"><b>🎉</b>Nothing unread. You\'re all caught up.</div>'
    placePanel()
    return
  }
  let html = ''
  for (const k of ['imsg', 'wa', 'app']) {
    const group = shown.filter((i) => i.kind === k)
    if (!group.length) continue
    if (filter === 'all') html += `<div class="sec">${LABEL[k]}</div>`
    html += group.map(row).join('')
  }
  const panel = $('#reply')
  const hadFocus = panel.contains(document.activeElement)
  const selA = $('#r-text').selectionStart, selB = $('#r-text').selectionEnd
  document.body.appendChild(panel)
  $('#list').innerHTML = html
  placePanel()
  if (hadFocus) { $('#r-text').focus(); $('#r-text').setSelectionRange(selA, selB) }
}

async function refresh() {
  try {
    data = await window.imsg.unifiedList()
  } catch {
    return
  }
  render()
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  filter = b.dataset.f
  render()
})
function openIt(it) {
  window.imsg.unifiedOpen({ kind: it.kind, guid: it.guid, spaceId: it.spaceId, tabId: it.tabId, name: it.name })
  setTimeout(refresh, 2500)
}
$('#list').addEventListener('click', (e) => {
  if (e.target.closest('#reply')) return
  const b = e.target.closest('.item')
  const it = b && byKey.get(b.dataset.k)
  if (!it) return
  if (it.kind === 'app' || e.target.closest('.act.go')) return openIt(it)
  if (openKey === it.key) closeReply()
  else openReply(it)
})
$('#list').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('item')) return
  e.target.click()
})
window.addEventListener('focus', refresh)
refresh()
setInterval(refresh, 4000)
// an app icon that can't load falls back to its first letter
$('#list').addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG') return
  const it = byKey.get(e.target.closest('.item')?.dataset.k)
  e.target.replaceWith(document.createTextNode(((it && it.name) || '?')[0].toUpperCase()))
}, true)


// ---- Reply right here (iMessage and WhatsApp)
let openKey = null, openItem = null, quick = [], aiOn = false
const drafts = {}
function placePanel() {
  const panel = $('#reply')
  const row = openKey && [...document.querySelectorAll('#list .item')].find((r) => r.dataset.k === openKey)
  if (!openKey) { panel.hidden = true; return }
  if (row) { row.classList.add('open'); row.after(panel) }
  else if (panel.dataset.sent) { panel.hidden = true; return }
  else $('#list').prepend(panel) // the chat left the list (read somewhere else): keep the box at the top
  panel.hidden = false
}
const firstName = (n) => { const t = String(n || '').trim(); return !t || /^[+\d(][\d\s()+\-.]*$/.test(t) ? '' : t.split(/[\s,]+/)[0] }
function fillQuick(text) {
  const f = firstName(openItem && openItem.name)
  return String(text).replace(/\s*\{name\}/g, f ? ' ' + f : '').replace(/^\s+/, '').replace(/\s+([,!.?])/g, '$1')
}
async function openReply(it) {
  if (openKey) drafts[openKey] = $('#r-text').value
  openKey = it.key
  openItem = it
  delete $('#reply').dataset.sent
  document.querySelectorAll('#list .item.open').forEach((r) => r.classList.remove('open'))
  $('#r-text').value = drafts[it.key] || ''
  $('#r-msg').textContent = ''
  $('#r-msg').className = 'msg'
  $('#r-send').disabled = false
  $('#r-read').hidden = it.kind !== 'imsg'
  $('#r-via').textContent = it.kind === 'imsg' ? 'iMessage' : 'WhatsApp'
  $('#r-ai').hidden = !aiOn
  $('#r-hist').innerHTML = it.kind === 'imsg' ? '<div class="h-empty">Loading…</div>' : `<div class="h them"><span>${esc(it.preview || '')}</span></div><div class="h-note">Only the last message is shown for WhatsApp. ↗ opens the whole chat.</div>`
  placePanel()
  $('#r-text').focus()
  if (it.kind === 'imsg') loadHistory(it)
}
let hist = []
async function loadHistory(it) {
  try {
    const msgs = await window.imsg.messages(it.chatId)
    if (openKey !== it.key) return
    hist = msgs.filter((m) => m.text || (m.attachments || []).length).slice(-8)
    $('#r-hist').innerHTML = hist.map((m) => `<div class="h ${m.fromMe ? 'me' : 'them'}">${!m.fromMe && m.sender && it.name && it.name.includes(',') ? `<b>${esc(m.sender)}</b>` : ''}<span>${m.text ? esc(m.text) : '📎 Attachment'}</span></div>`).join('') || '<div class="h-empty">No messages.</div>'
    $('#r-hist').scrollTop = 1e6
  } catch {
    if (openKey === it.key) $('#r-hist').innerHTML = `<div class="h them"><span>${esc(it.preview || '')}</span></div>`
  }
}
function closeReply() {
  if (openKey) drafts[openKey] = $('#r-text').value
  openKey = null
  openItem = null
  document.querySelectorAll('#list .item.open').forEach((r) => r.classList.remove('open'))
  $('#reply').hidden = true
  document.body.appendChild($('#reply'))
}
async function sendReply() {
  const it = openItem
  const text = $('#r-text').value.trim()
  if (!it || !text) return $('#r-text').focus()
  $('#r-send').disabled = true
  $('#r-msg').className = 'msg'
  $('#r-msg').textContent = 'Sending…'
  try {
    if (it.kind === 'imsg') {
      await window.imsg.sendToChat(it.guid, text)
      await window.imsg.markRead(it.guid, it.date || Date.now())
    } else await window.imsg.waSend({ spaceId: it.spaceId, tabId: it.tabId, name: it.name }, text)
    delete drafts[it.key]
    $('#r-text').value = ''
    $('#r-msg').textContent = 'Sent ✓'
    $('#reply').dataset.sent = '1'
    setTimeout(() => { if (openKey === it.key) closeReply(); refresh() }, 1200)
  } catch (err) {
    $('#r-msg').className = 'msg err'
    $('#r-msg').textContent = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    $('#r-send').disabled = false
  }
}
$('#r-send').addEventListener('click', sendReply)
$('#r-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply() }
  if (e.key === 'Escape') closeReply()
})
$('#r-text').addEventListener('input', () => { if (openKey) drafts[openKey] = $('#r-text').value })
$('#r-close').addEventListener('click', closeReply)
$('#r-open').addEventListener('click', () => { if (openItem) openIt(openItem) })
$('#r-read').addEventListener('click', async () => {
  const it = openItem
  if (!it) return
  await window.imsg.markRead(it.guid, it.date || Date.now())
  closeReply()
  refresh()
})
$('#r-quick').addEventListener('change', () => {
  const q = quick[Number($('#r-quick').value)]
  $('#r-quick').value = ''
  if (!q) return
  const box = $('#r-text')
  box.focus()
  if (!document.execCommand('insertText', false, fillQuick(q.text))) box.value += fillQuick(q.text)
})
$('#r-ai').addEventListener('click', async () => {
  const it = openItem
  if (!it) return
  const b = $('#r-ai')
  b.disabled = true
  b.textContent = '✨ Writing…'
  try {
    const messages = it.kind === 'imsg' ? hist.filter((m) => m.text).map((m) => ({ fromMe: m.fromMe, text: m.text })) : [{ fromMe: false, text: it.preview || '' }]
    const reply = await window.imsg.aiSuggest({ name: it.name, messages, draft: $('#r-text').value })
    if (openKey !== it.key) return
    const box = $('#r-text')
    box.focus()
    box.select()
    if (!document.execCommand('insertText', false, reply)) box.value = reply
  } catch (err) {
    $('#r-msg').className = 'msg err'
    $('#r-msg').textContent = /NO_KEY/.test(String(err)) ? 'Add a Claude API key in Tasks → Settings · Connections.' : 'The AI could not write a reply right now.'
  } finally {
    b.disabled = false
    b.textContent = '✨ Suggest'
  }
})
async function loadQuick() {
  try { quick = await window.imsg.quickReplies() } catch { quick = [] }
  $('#r-quick').innerHTML = '<option value="">⚡ Quick reply…</option>' + quick.map((q, i) => `<option value="${i}">${esc(q.title || q.text.slice(0, 40))}</option>`).join('')
}
loadQuick()
if (window.imsg.onQuickReplies) window.imsg.onQuickReplies(loadQuick)
window.imsg.aiStatus().then((s) => { aiOn = !!(s && s.connected) }).catch(() => {})
