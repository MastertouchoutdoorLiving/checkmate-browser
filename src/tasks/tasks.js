// "Tasks": your to-dos, reply reminders and scheduled messages in one place, plus the JobTread and AI keys.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let todos = []
let timers = { reminders: [], scheduled: [] }
let showDone = false

const DAY = 864e5
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }
function fmt(ts) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = startOfDay(ts), today = startOfDay(Date.now())
  if (day === today) return `Today ${time}`
  if (day === today + DAY) return `Tomorrow ${time}`
  if (day === today - DAY) return `Yesterday ${time}`
  if (Math.abs(day - today) < 6 * DAY) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
function whenFromChoice(v) {
  const d = new Date()
  if (v === '1h') return Date.now() + 3600e3
  if (v === 'tonight') { d.setHours(18, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.getTime() }
  if (v === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() }
  if (v === 'monday') { d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); d.setHours(9, 0, 0, 0); return d.getTime() }
  if (v === 'pick') { const t = new Date($('#add-at').value).getTime(); return t > 0 ? t : null }
  return null
}

function todoCard(t) {
  const late = !t.done && t.due && t.due < Date.now()
  return `<div class="card todo ${t.done ? 'done' : ''}" data-id="${esc(t.id)}">
    <button class="chk" data-act="toggle" title="${t.done ? 'Mark as not done' : 'Mark as done'}">${t.done ? '✓' : ''}</button>
    <div class="body"><div class="text">${esc(t.text)}</div>${t.due ? `<div class="due ${late ? 'late' : ''}">${late ? 'Overdue · ' : ''}${esc(fmt(t.due))}</div>` : ''}</div>
    <button class="x" data-act="del" title="Delete">×</button></div>`
}

function renderTodos() {
  const open = todos.filter((t) => !t.done)
  const now = Date.now(), endToday = startOfDay(now) + DAY
  const groups = [
    ['Overdue', open.filter((t) => t.due && t.due < now), 'red'],
    ['Today', open.filter((t) => t.due && t.due >= now && t.due < endToday), ''],
    ['Upcoming', open.filter((t) => t.due && t.due >= endToday).sort((a, b) => a.due - b.due), ''],
    ['Anytime', open.filter((t) => !t.due).sort((a, b) => b.created - a.created), ''],
  ]
  groups[0][1].sort((a, b) => a.due - b.due)
  groups[1][1].sort((a, b) => a.due - b.due)
  const html = groups.filter((g) => g[1].length).map(([name, list, cls]) => `<div class="group ${cls}">${name}</div>${list.map(todoCard).join('')}`).join('')
  $('#todos').innerHTML = html || '<div class="empty">No to-dos. Add one above. 🎉</div>'
  const done = todos.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
  $('#show-done').hidden = !done.length
  $('#show-done').textContent = showDone ? `Hide done (${done.length})` : `Show done (${done.length})`
  $('#done').hidden = !showDone || !done.length
  $('#done').innerHTML = done.slice(0, 50).map(todoCard).join('') + (done.length ? '<button class="link" id="clear-done">Clear all done</button>' : '')
}

function renderTimers() {
  const now = Date.now()
  const rem = [...timers.reminders].sort((a, b) => a.at - b.at)
  $('#reminders').innerHTML = rem.length
    ? rem.map((r) => `<div class="card item" data-rid="${esc(r.id)}">
        <div class="body"><div class="t"><span class="tag ${r.kind === 'wa' ? 'wa' : ''}">${r.kind === 'wa' ? 'WhatsApp' : 'iMessage'}</span>${esc(r.title || r.name || 'Conversation')}</div>
        <div class="s">${esc(fmt(r.at))}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
        <button class="btn small" data-act="open">Open</button><button class="x" data-act="cancel" title="Remove">×</button></div>`).join('')
    : '<div class="empty">No reminders. Use ⏰ Remind me in iMessage or WhatsApp.</div>'
  const sch = [...timers.scheduled].sort((a, b) => a.at - b.at)
  $('#scheduled').innerHTML = sch.length
    ? sch.map((m) => `<div class="card item" data-rid="${esc(m.id)}">
        <div class="body"><div class="t">${esc(m.title || m.handle || 'Message')}</div>
        <div class="s ${m.failed ? 'late' : ''}">${m.failed ? 'Not sent: ' + esc(m.failed) : esc(fmt(m.at)) + ' · ' + esc(m.text)}</div></div>
        <button class="x" data-act="cancel" title="Cancel">×</button></div>`).join('')
    : '<div class="empty">Nothing scheduled. Use Send later in iMessage.</div>'
  const open = todos.filter((t) => !t.done)
  const overdue = open.filter((t) => t.due && t.due < now).length
  const today = open.filter((t) => t.due && t.due >= now && t.due < startOfDay(now) + DAY).length
  $('#stats').innerHTML = [
    overdue ? `<span class="stat red"><b>${overdue}</b> overdue</span>` : '',
    `<span class="stat"><b>${today}</b> due today</span>`,
    `<span class="stat"><b>${open.length}</b> open</span>`,
    `<span class="stat"><b>${rem.length}</b> reminders</span>`,
    `<span class="stat"><b>${sch.length}</b> scheduled</span>`,
  ].join('')
  document.title = overdue ? `(${overdue}) Tasks` : 'Tasks'
}

function render() { renderTodos(); renderTimers() }

async function refresh() {
  try { [todos, timers] = await Promise.all([window.imsg.todos(), window.imsg.timers()]) } catch { return }
  render()
}

$('#add-when').addEventListener('change', () => {
  const pick = $('#add-when').value === 'pick'
  $('#add-at').hidden = !pick
  if (pick) $('#add-at').focus()
})
$('#add').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('#add-text').value.trim()
  if (!text) return $('#add-text').focus()
  try {
    todos = await window.imsg.addTodo({ text, due: whenFromChoice($('#add-when').value) })
    $('#add-text').value = ''
    $('#add-when').value = ''
    $('#add-at').hidden = true
    render()
  } catch (err) { alert(String(err.message || err).replace(/^.*Error: /, '')) }
  $('#add-text').focus()
})
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]')
  if (b) {
    const todo = b.closest('[data-id]')
    const timer = b.closest('[data-rid]')
    const act = b.dataset.act
    if (todo && act === 'toggle') {
      const t = todos.find((x) => x.id === todo.dataset.id)
      todos = await window.imsg.updateTodo(todo.dataset.id, { done: !(t && t.done) })
    } else if (todo && act === 'del') todos = await window.imsg.deleteTodo(todo.dataset.id)
    else if (timer && act === 'open') window.imsg.openReminder(timer.dataset.rid)
    else if (timer && act === 'cancel') timers = await window.imsg.cancelTimer(timer.dataset.rid)
    return render()
  }
  if (e.target.id === 'show-done') { showDone = !showDone; return renderTodos() }
  if (e.target.id === 'clear-done') { todos = await window.imsg.deleteTodo('*done'); return renderTodos() }
  const p = e.target.closest('[data-paste]')
  if (p) {
    const el = $(p.dataset.paste)
    const text = String((await window.imsg.clipText()) || '').trim()
    if (text) el.value = text
    el.focus()
  }
})

// ---- Connections
const errText = (err) => String((err && err.message) || err).replace(/^.*Error: /, '')
async function renderConn() {
  try {
    const jt = await window.imsg.jtStatus()
    $('#jt-state').textContent = jt.connected ? `Connected${jt.org ? ' · ' + jt.org : ''}` : 'Not connected'
    $('#jt-state').classList.toggle('on', !!jt.connected)
    $('#jt-row').hidden = $('#jt-tip').hidden = !!jt.connected
    $('#jt-off').hidden = !jt.connected
  } catch {}
  try {
    const ai = await window.imsg.aiStatus()
    $('#ai-state').textContent = ai.connected ? 'Key saved' : 'No key'
    $('#ai-state').classList.toggle('on', !!ai.connected)
    $('#ai-row').hidden = $('#ai-tip').hidden = !!ai.connected
    $('#ai-off').hidden = !ai.connected
  } catch {}
}
async function save(kind, key) {
  const msg = $(`#${kind}-msg`)
  msg.className = 'msg'
  msg.textContent = key ? 'Checking…' : ''
  try {
    if (kind === 'jt') await window.imsg.jtSetKey(key)
    else await window.imsg.aiSetKey(key)
    $(`#${kind}-key`).value = ''
    msg.textContent = key ? 'Connected ✓' : ''
  } catch (err) {
    msg.className = 'msg err'
    msg.textContent = errText(err)
  }
  renderConn()
}
$('#jt-save').addEventListener('click', () => { const k = $('#jt-key').value.trim(); k ? save('jt', k) : $('#jt-key').focus() })
$('#ai-save').addEventListener('click', () => { const k = $('#ai-key').value.trim(); k ? save('ai', k) : $('#ai-key').focus() })
$('#jt-key').addEventListener('keydown', (e) => e.key === 'Enter' && $('#jt-save').click())
$('#ai-key').addEventListener('keydown', (e) => e.key === 'Enter' && $('#ai-save').click())
$('#jt-off').addEventListener('click', () => confirm('Disconnect JobTread?') && save('jt', ''))
$('#ai-off').addEventListener('click', () => confirm('Remove the AI key?') && save('ai', ''))

window.imsg.onShowConnections(() => {
  const c = document.querySelector('#conn')
  c.scrollIntoView({ behavior: 'smooth', block: 'center' })
  c.classList.add('flash')
  setTimeout(() => c.classList.remove('flash'), 1600)
  renderConn().then(() => { const k = !$('#jt-row').hidden ? $('#jt-key') : !$('#ai-row').hidden ? $('#ai-key') : null; if (k) k.focus() })
})
window.imsg.onTodos((t) => { todos = t; render() })
window.imsg.onTimers((t) => { timers = t; render() })
window.addEventListener('focus', () => { refresh(); renderConn() })
refresh()
renderConn()
setInterval(render, 60 * 1000) // keep "overdue" and times fresh
