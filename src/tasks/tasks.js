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

function openSettings(open = true) { $('#settings-panel').hidden = $('#settings-bg').hidden = !open; if (open) $('#settings-panel').scrollTop = 0 }
$('#open-settings').addEventListener('click', () => { openSettings(); renderConn() })
$('#close-settings').addEventListener('click', () => openSettings(false))
$('#settings-bg').addEventListener('click', () => openSettings(false))
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings-panel').hidden) openSettings(false) })
window.imsg.onShowConnections(() => {
  openSettings()
  renderConn().then(() => { const k = !$('#jt-row').hidden ? $('#jt-key') : !$('#ai-row').hidden ? $('#ai-key') : null; if (k) k.focus() })
})
window.imsg.onTodos((t) => { todos = t; render() })
window.imsg.onTimers((t) => { timers = t; render() })
window.addEventListener('focus', () => { refresh(); renderConn() })
refresh()
renderConn()
setInterval(render, 60 * 1000) // keep "overdue" and times fresh


// ---- JobTread tasks assigned to you
let jtTasks = { connected: false, tasks: [] }
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const dayLabel = (iso) => {
  if (!iso) return ''
  const t = todayStr()
  if (iso === t) return 'Today'
  const d = new Date(iso + 'T12:00')
  const diff = Math.round((d - new Date(t + 'T12:00')) / 864e5)
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(Math.abs(diff) > 300 ? { year: 'numeric' } : {}) })
}
function renderJt() {
  const box = $('#jt-tasks')
  if (!jtTasks.connected) { box.innerHTML = '<div class="empty">Connect JobTread below (⚙ Settings) to see the tasks assigned to you.</div>'; return }
  if (jtTasks.error) { box.innerHTML = `<div class="empty">${esc(jtTasks.error)}</div>`; return }
  if (!jtTasks.tasks.length) { box.innerHTML = '<div class="empty">Nothing assigned to you in JobTread. 🎉</div>'; return }
  const t = todayStr()
  box.innerHTML = jtTasks.tasks.slice(0, 40).map((k) => {
    const late = k.due && k.due < t
    return `<div class="card todo jtt" data-jt="${esc(k.id)}">
      <button class="chk" data-act="jt-done" title="Mark as done in JobTread"></button>
      <div class="body"><div class="text"><span class="src">JobTread</span>${esc(k.name)}</div>
      <div class="due ${late ? 'late' : ''}">${k.due ? (late ? 'Overdue · ' : '') + esc(dayLabel(k.due)) : 'No date'}${k.job ? ' · ' + (k.job.number ? '#' + esc(k.job.number) + ' ' : '') + esc(k.job.name) : ''}</div></div>
      <button class="btn small" data-act="jt-open">Open</button></div>`
  }).join('') + (jtTasks.tasks.length > 40 ? `<div class="empty">+${jtTasks.tasks.length - 40} more in JobTread</div>` : '')
}
async function loadJt(fresh) {
  try { jtTasks = await window.imsg.jtMyTasks(fresh) } catch (err) { jtTasks = { connected: true, tasks: [], error: errText(err) } }
  renderJt()
  renderSummary()
}
$('#jt-refresh').addEventListener('click', () => loadJt(true))
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act^="jt-"]')
  const card = b && b.closest('[data-jt]')
  if (!card) return
  const k = jtTasks.tasks.find((x) => x.id === card.dataset.jt)
  if (!k) return
  if (b.dataset.act === 'jt-open') return window.imsg.jtOpen(k.url)
  b.textContent = '✓'
  card.classList.add('done')
  try {
    await window.imsg.jtTaskDone(k.id)
    jtTasks.tasks = jtTasks.tasks.filter((x) => x.id !== k.id)
    setTimeout(() => { renderJt(); renderSummary() }, 600)
  } catch (err) {
    card.classList.remove('done'); b.textContent = ''
    alert(errText(err))
  }
})

// ---- Morning summary (the "Today" box)
let unanswered = []
function renderSummary() {
  $('#sum-date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  const h = new Date().getHours()
  $('#sum-title').textContent = h < 12 ? 'Good morning ☀️ Here is your day' : h < 18 ? 'Today' : 'Today (evening)'
  const t = todayStr(), now = Date.now(), end = startOfDay(now) + DAY
  const jtDue = (jtTasks.tasks || []).filter((k) => k.due && k.due <= t)
  const myDue = todos.filter((x) => !x.done && x.due && x.due < end)
  const remToday = timers.reminders.filter((r) => r.at < end)
  const col = (title, n, lines, red) => `<div class="sum-col"><h3>${title} <span class="n ${red && n ? 'red' : ''}">${n}</span></h3>${lines.slice(0, 5).join('') || '<div class="sum-line"><span class="m">Nothing</span></div>'}${lines.length > 5 ? `<div class="sum-line"><span class="m">+${lines.length - 5} more</span></div>` : ''}</div>`
  $('#sum-body').innerHTML = `<div class="sum-grid">
    ${col('JobTread tasks due', jtDue.length, jtDue.map((k) => `<button class="sum-line ${k.due < t ? 'late' : ''}" data-sum-jt="${esc(k.id)}">${esc(k.name)} <span class="m">· ${esc(dayLabel(k.due))}${k.job ? ' · ' + esc(k.job.name) : ''}</span></button>`), true)}
    ${col('My to-dos due', myDue.length, myDue.map((x) => `<div class="sum-line ${x.due < now ? 'late' : ''}">${esc(x.text)} <span class="m">· ${esc(fmt(x.due))}</span></div>`), true)}
    ${col('Reminders today', remToday.length, remToday.map((r) => `<button class="sum-line" data-sum-rem="${esc(r.id)}">${esc(r.title || r.name || 'Conversation')} <span class="m">· ${esc(fmt(r.at))}</span></button>`))}
    ${col('Not answered for 24h+', unanswered.length, unanswered.map((u) => `<button class="sum-line late" data-sum-im="${esc(u.guid)}">${esc(u.title)} <span class="m">· ${esc(fmt(u.date))}${u.job ? ' · 🔨 ' + esc(u.job) : ''}</span></button>`), true)}
  </div>`
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-sum-jt], [data-sum-rem], [data-sum-im]')
  if (!a) return
  if (a.dataset.sumJt) { const k = jtTasks.tasks.find((x) => x.id === a.dataset.sumJt); if (k) window.imsg.jtOpen(k.url) }
  if (a.dataset.sumRem) window.imsg.openReminder(a.dataset.sumRem)
  if (a.dataset.sumIm) window.imsg.unifiedOpen({ kind: 'imsg', guid: a.dataset.sumIm })
})
async function loadUnanswered() {
  try { unanswered = await window.imsg.unanswered() } catch { unanswered = [] }
  renderSummary()
}
window.imsg.onSummary(() => {
  loadJt(true); loadUnanswered()
  window.scrollTo({ top: 0, behavior: 'smooth' })
  $('#summary').classList.add('flash')
  setTimeout(() => $('#summary').classList.remove('flash'), 1800)
})

// ---- Search JobTread (⌘K)
let sTimer = null, sRes = [], sSel = 0
function drawResults(r) {
  const box = $('#results')
  sRes = [...(r.customers || []).map((c) => ({ kind: 'Customer', title: c.name, sub: [c.phone, c.email, c.address].filter(Boolean).join(' · '), url: c.url, jobs: c.jobs })),
    ...(r.jobs || []).map((j) => ({ kind: j.closed ? 'Job · closed' : 'Job', title: `${j.number ? '#' + j.number + ' ' : ''}${j.name}`, sub: [j.customer, j.address].filter(Boolean).join(' · '), url: j.url }))]
  sSel = 0
  if (!sRes.length) { box.innerHTML = '<div class="empty">No match in JobTread.</div>'; box.hidden = false; return }
  let html = ''
  let last = ''
  sRes.forEach((x, i) => {
    const sec = x.kind.startsWith('Job') ? 'Jobs' : 'Customers'
    if (sec !== last) { html += `<div class="r-sec">${sec}</div>`; last = sec }
    html += `<button class="r-item ${i === sSel ? 'sel' : ''}" data-i="${i}"><span class="t">${esc(x.title)}</span><span class="s">${esc(x.sub)}</span><span class="k">${esc(x.kind)}</span></button>`
  })
  box.innerHTML = html
  box.hidden = false
}
$('#search').addEventListener('input', () => {
  clearTimeout(sTimer)
  const q = $('#search').value.trim()
  if (q.length < 2) { $('#results').hidden = true; return }
  sTimer = setTimeout(async () => {
    $('#results').innerHTML = '<div class="empty">Searching…</div>'
    $('#results').hidden = false
    try { drawResults(await window.imsg.jtSearch(q)) } catch (err) { $('#results').innerHTML = `<div class="empty">${esc(errText(err))}</div>` }
  }, 300)
})
$('#search').addEventListener('keydown', (e) => {
  const items = [...document.querySelectorAll('#results .r-item')]
  if (e.key === 'Escape') { $('#results').hidden = true; return }
  if (!items.length) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    sSel = (sSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items.forEach((b, i) => b.classList.toggle('sel', i === sSel))
  }
  if (e.key === 'Enter') { e.preventDefault(); items[sSel] && items[sSel].click() }
})
$('#results').addEventListener('click', (e) => {
  const b = e.target.closest('.r-item')
  if (!b) return
  window.imsg.jtOpen(sRes[Number(b.dataset.i)].url)
  $('#results').hidden = true
})
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#search-wrap')) $('#results').hidden = true })
window.imsg.onSearch(() => { window.scrollTo({ top: 0 }); $('#search').focus(); $('#search').select() })

const _render = render
render = function () { _render(); renderSummary() }
loadJt()
loadUnanswered()
setInterval(() => loadJt(), 5 * 60e3)
setInterval(loadUnanswered, 10 * 60e3)


// ---- Follow-ups: estimates not approved yet and overdue invoices, texted by iMessage or Quo
let money = { connected: false, estimates: [], invoices: [] }
let sendCfg = { via: 'imessage', templates: {}, followed: {} }
let fuTab = 'estimate'
const money$ = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const recentlyDone = (id) => sendCfg.followed && sendCfg.followed[id] && Date.now() - sendCfg.followed[id] < 7 * 864e5
const openFollowUps = (kind) => (kind === 'estimate' ? money.estimates : money.invoices).filter((x) => !recentlyDone(x.id))
function renderFollowUps() {
  const box = $('#followups')
  document.querySelectorAll('.fu-tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.fu === fuTab)
    const n = money.connected ? openFollowUps(b.dataset.fu).length : 0
    b.textContent = (b.dataset.fu === 'estimate' ? 'Estimates' : 'Overdue invoices') + (n ? ` (${n})` : '')
  })
  if (!money.connected) { box.innerHTML = '<div class="empty">Connect JobTread below to see estimates to follow up and overdue invoices.</div>'; return }
  if (money.error) { box.innerHTML = `<div class="empty">${esc(money.error)}</div>`; return }
  const list = openFollowUps(fuTab)
  if (!list.length) { box.innerHTML = `<div class="empty">${fuTab === 'estimate' ? 'No estimates waiting (sent 3 to 30 days ago).' : 'No overdue invoices.'} 🎉</div>`; return }
  box.innerHTML = list.slice(0, 30).map((x) => `<div class="card fu" data-fu-id="${esc(x.id)}">
    <div class="body"><div class="t">${esc(x.customer || 'Customer')}${x.job ? ' · ' + esc(x.job.name) : ''}</div>
    <div class="s ${x.kind === 'invoice' ? 'late' : ''}">${esc(x.name)}${x.number ? ' #' + esc(x.number) : ''} · ${x.kind === 'invoice' ? `${x.days} days overdue` : `sent ${x.days} days ago`}${x.phone ? '' : ' · no phone'}</div></div>
    <span class="amt">${money$(x.amount)}</span>
    <button class="btn small primary" data-fu-act="text" ${x.phone ? '' : 'disabled'}>💬 Text</button>
    <button class="btn small" data-fu-act="open" title="Open in JobTread">↗</button>
    <button class="x" data-fu-act="skip" title="Hide for a week">×</button></div>`).join('') + (list.length > 30 ? `<div class="empty">+${list.length - 30} more</div>` : '') +
    (fuTab === 'invoice' && money.invoiceCount ? `<div class="empty">${money.invoiceCount} overdue invoices · ${money$(money.invoiceTotal)} in total</div>` : '')
}
async function loadMoney(fresh) {
  try { money = (await window.imsg.jtMoney(fresh)) || money } catch (err) { money = { connected: true, estimates: [], invoices: [], error: errText(err) } }
  renderFollowUps()
  renderSummary()
}
async function loadSend() {
  try { sendCfg = (await window.imsg.sendSettings()) || sendCfg } catch {}
  renderSendConn()
  renderFollowUps()
}
document.querySelectorAll('.fu-tab').forEach((b) => b.addEventListener('click', () => { fuTab = b.dataset.fu; renderFollowUps() }))
$('#fu-refresh').addEventListener('click', () => loadMoney(true))
const allMoney = () => [...money.estimates, ...money.invoices]
function fillTemplate(x) {
  const t = (sendCfg.templates || {})[x.kind] || ''
  const first = String(x.customer || '').trim().split(/\s+/)[0] || 'there'
  return t.replace(/\{first\}/g, first).replace(/\{name\}/g, x.customer || '').replace(/\{job\}/g, (x.job && x.job.name) || 'your project')
    .replace(/\{amount\}/g, money$(x.amount)).replace(/\{number\}/g, x.number || '').replace(/\{days\}/g, x.days).replace(/\{eta\}/g, x.eta || 15)
}
let sending = null
function openSend(x) {
  sending = x
  $('#sm-title').textContent = x.kind === 'invoice' ? 'Payment reminder' : x.kind === 'onmyway' ? '🚗 On my way' : 'Estimate follow-up'
  $('#sm-sub').textContent = x.kind === 'onmyway' ? `${x.customer || 'Customer'}${x.job ? ' · ' + x.job.name : ''} · ${x.when}` : `${x.customer} · ${x.job ? x.job.name + ' · ' : ''}${money$(x.amount)}`
  $('#sm-eta').hidden = x.kind !== 'onmyway'
  document.querySelectorAll('#sm-eta .chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.eta) === Number(x.eta || 15)))
  $('#sm-to').value = x.phone || ''
  $('#sm-via').value = sendCfg.via
  $('#sm-via').options[1].textContent = sendCfg.quoConnected ? `Quo · ${sendCfg.quoFromLabel || 'pick a number in Settings'}` : 'Quo (not connected yet)'
  $('#sm-text').value = fillTemplate(x)
  $('#sm-msg').textContent = ''
  $('#sm-msg').className = 'msg'
  $('#sm-send').disabled = false
  $('#send-modal').hidden = false
  $('#sm-text').focus()
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fu-act]')
  const sumB = e.target.closest('[data-sum-fu]')
  if (sumB) { const x = allMoney().find((y) => y.id === sumB.dataset.sumFu); if (x) openSend(x); return }
  if (!b) return
  const x = allMoney().find((y) => y.id === b.closest('[data-fu-id]').dataset.fuId)
  if (!x) return
  if (b.dataset.fuAct === 'text') openSend(x)
  if (b.dataset.fuAct === 'open') window.imsg.jtOpen(x.url)
  if (b.dataset.fuAct === 'skip') { await window.imsg.skipFollowUp(x.id); await loadSend(); renderSummary() }
})
$('#sm-cancel').addEventListener('click', () => ($('#send-modal').hidden = true))
$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const x = sending
  if (!x) return
  $('#sm-send').disabled = true
  $('#sm-msg').className = 'msg'
  $('#sm-msg').textContent = 'Sending…'
  try {
    await window.imsg.sendText({ to: $('#sm-to').value, via: $('#sm-via').value, text: $('#sm-text').value, docId: x.kind === 'onmyway' ? '' : x.id, jobId: x.job && x.job.id })
    if (x.kind === 'onmyway') { sentOmw[x.id] = Date.now(); renderAppts() }
    $('#send-modal').hidden = true
    await loadSend()
    renderSummary()
  } catch (err) {
    $('#sm-msg').className = 'msg err'
    $('#sm-msg').textContent = errText(err)
    $('#sm-send').disabled = false
  }
})

// ---- Connections: iMessage or Quo, Quo key and number, templates
function renderSendConn() {
  document.querySelectorAll('input[name="via"]').forEach((r) => (r.checked = r.value === sendCfg.via))
  $('#via-state').textContent = sendCfg.via === 'quo' ? 'Quo' : 'iMessage'
  $('#via-state').classList.add('on')
  $('#quo-state').textContent = sendCfg.quoConnected ? 'Connected' : 'Not connected'
  $('#quo-state').classList.toggle('on', !!sendCfg.quoConnected)
  $('#quo-row').hidden = $('#quo-tip').hidden = !!sendCfg.quoConnected
  $('#quo-off').hidden = $('#quo-from-l').hidden = !sendCfg.quoConnected
  $('#quo-from').innerHTML = (sendCfg.quoNumbers || []).map((n) => `<option value="${esc(n.id)}" ${n.id === sendCfg.quoFrom ? 'selected' : ''}>${esc(n.label)}</option>`).join('')
  if (document.activeElement !== $('#tpl-estimate')) $('#tpl-estimate').value = sendCfg.templates.estimate || ''
  if (document.activeElement !== $('#tpl-invoice')) $('#tpl-invoice').value = sendCfg.templates.invoice || ''
  if (document.activeElement !== $('#tpl-onmyway')) $('#tpl-onmyway').value = sendCfg.templates.onmyway || ''
}
document.querySelectorAll('input[name="via"]').forEach((r) => r.addEventListener('change', async () => { sendCfg = await window.imsg.setSend({ via: r.value }); renderSendConn() }))
$('#quo-from').addEventListener('change', async () => { sendCfg = await window.imsg.setSend({ quoFrom: $('#quo-from').value }); renderSendConn() })
$('#quo-save').addEventListener('click', async () => {
  const k = $('#quo-key').value.trim()
  if (!k) return $('#quo-key').focus()
  $('#quo-msg').className = 'msg'
  $('#quo-msg').textContent = 'Checking…'
  try { sendCfg = await window.imsg.quoSetKey(k); $('#quo-key').value = ''; $('#quo-msg').textContent = 'Connected ✓' } catch (err) { $('#quo-msg').className = 'msg err'; $('#quo-msg').textContent = errText(err) }
  renderSendConn()
})
$('#quo-off').addEventListener('click', async () => { if (!confirm('Disconnect Quo?')) return; sendCfg = await window.imsg.quoSetKey(''); renderSendConn() })
$('#tpl-save').addEventListener('click', async () => {
  sendCfg = await window.imsg.setSend({ templates: { estimate: $('#tpl-estimate').value, invoice: $('#tpl-invoice').value, onmyway: $('#tpl-onmyway').value } })
  $('#tpl-msg').textContent = 'Saved ✓'
  setTimeout(() => ($('#tpl-msg').textContent = ''), 2000)
})

// add follow-ups to the "Today" box
const _renderSummary = renderSummary
renderSummary = function () {
  _renderSummary()
  if (!money.connected) return
  const est = openFollowUps('estimate'), inv = openFollowUps('invoice')
  const line = (x) => `<button class="sum-line ${x.kind === 'invoice' ? 'late' : ''}" data-sum-fu="${esc(x.id)}">${esc(x.customer || 'Customer')} <span class="m">· ${money$(x.amount)} · ${x.kind === 'invoice' ? x.days + 'd overdue' : x.days + 'd ago'}</span></button>`
  const col = (title, list, red) => `<div class="sum-col"><h3>${title} <span class="n ${red && list.length ? 'red' : ''}">${list.length}</span></h3>${list.slice(0, 5).map(line).join('') || '<div class="sum-line"><span class="m">Nothing</span></div>'}${list.length > 5 ? `<div class="sum-line"><span class="m">+${list.length - 5} more below</span></div>` : ''}</div>`
  const grid = document.querySelector('#sum-body .sum-grid')
  if (grid) grid.insertAdjacentHTML('beforeend', col('Estimates to follow up', est) + col('Overdue invoices', inv, true))
}
window.imsg.onSummary(() => loadMoney(true))
loadSend()
loadMoney()
setInterval(() => loadMoney(), 10 * 60e3)


// ---- Today's appointments (Google Calendar) with "On my way"
let cal = { connected: false, events: [] }
const sentOmw = {}
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const apptWhen = (ev) => (ev.allDay ? 'All day' : hm(ev.start))
function renderAppts() {
  const box = $('#appts')
  if (!cal.connected) { box.innerHTML = '<div class="empty">Connect Google Calendar in ⚙ Settings to see today\'s appointments here.</div>'; return }
  if (cal.error) { box.innerHTML = `<div class="empty">${esc(cal.error)}</div>`; return }
  if (!cal.events.length) { box.innerHTML = '<div class="empty">No appointments today.</div>'; return }
  const warn = cal.publicOnly ? '<div class="card cal-warn">⚠️ Google only sends "Busy" because the calendar is connected with its <b>public</b> address. Click <b>Disconnect calendar</b> in ⚙ Settings and paste the <b>Secret address in iCal format</b> instead (Google Calendar → Settings → your calendar → Integrate calendar). Then names, addresses and JobTread links show here.</div>' : ''
  const now = Date.now()
  box.innerHTML = warn + cal.events.map((ev) => `<div class="card fu appt ${!ev.allDay && ev.end < now ? 'past' : ''}" data-appt="${esc(ev.id)}">
    <span class="when">${esc(apptWhen(ev))}</span>
    <div class="body"><div class="t">${esc(ev.title)}</div>
    <div class="s">${[ev.customer ? `<a data-appt-act="cust">👤 ${esc(ev.customer.name)}</a>` : '', ev.job ? `<a data-appt-act="job">🔨 ${esc(ev.job.name)}</a>` : '', esc(ev.location || (ev.customer || ev.job || cal.publicOnly ? '' : 'Not found in JobTread')), sentOmw[ev.id] ? '✓ on-my-way sent' : ''].filter(Boolean).join(' · ')}</div></div>
    ${ev.location ? '<button class="btn small" data-appt-act="map" title="Directions in Google Maps">🗺️</button>' : ''}
    ${ev.allDay ? '' : `<button class="btn small ${ev.phone ? 'primary' : ''}" data-appt-act="omw" title="${ev.phone ? 'Text the customer that you are on the way' : 'No phone found in the appointment or JobTread. You can type it.'}">🚗 On my way</button>`}</div>`).join('')
}
async function loadCal(fresh) {
  try { cal = (await window.imsg.calToday(fresh)) || cal } catch (err) { cal = { connected: true, events: [], error: errText(err) } }
  renderAppts()
  renderCalConn()
  renderSummary()
}
function renderCalConn() {
  $('#cal-state').textContent = cal.connected ? 'Connected' : 'Not connected'
  $('#cal-state').classList.toggle('on', !!cal.connected)
  $('#cal-row').hidden = $('#cal-tip').hidden = !!cal.connected
  $('#cal-off').hidden = !cal.connected
}
function openOmw(ev) {
  openSend({ kind: 'onmyway', id: ev.id, customer: ev.customer ? ev.customer.name : ev.title, job: ev.job, phone: ev.phone, when: apptWhen(ev), eta: 15 })
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('#sm-eta .chip')
  if (chip && sending && sending.kind === 'onmyway') { sending.eta = Number(chip.dataset.eta); $('#sm-text').value = fillTemplate(sending); document.querySelectorAll('#sm-eta .chip').forEach((c) => c.classList.toggle('on', c === chip)); return }
  const sumA = e.target.closest('[data-sum-appt]')
  if (sumA) { const ev = cal.events.find((x) => x.id === sumA.dataset.sumAppt); if (ev) ev.allDay ? document.querySelector('#appts').scrollIntoView({ behavior: 'smooth' }) : openOmw(ev); return }
  const b = e.target.closest('[data-appt-act]')
  if (!b) return
  const ev = cal.events.find((x) => x.id === b.closest('[data-appt]').dataset.appt)
  if (!ev) return
  const act = b.dataset.apptAct
  if (act === 'omw') openOmw(ev)
  if (act === 'cust' && ev.customer) window.imsg.jtOpen(ev.customer.url)
  if (act === 'job' && ev.job) window.imsg.jtOpen(ev.job.url)
  if (act === 'map') window.imsg.openUrl ? window.imsg.openUrl('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(ev.location)) : window.open('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(ev.location))
})
$('#cal-refresh').addEventListener('click', () => loadCal(true))
$('#cal-save').addEventListener('click', async () => {
  const u = $('#cal-url').value.trim()
  if (!u) return $('#cal-url').focus()
  $('#cal-msg').className = 'msg'
  $('#cal-msg').textContent = 'Checking…'
  try { await window.imsg.calSetUrl(u); $('#cal-url').value = ''; $('#cal-msg').textContent = 'Connected ✓'; await loadCal(true) } catch (err) { $('#cal-msg').className = 'msg err'; $('#cal-msg').textContent = errText(err) }
})
$('#cal-off').addEventListener('click', async () => { if (!confirm('Disconnect Google Calendar?')) return; cal = await window.imsg.calSetUrl(''); $('#cal-msg').textContent = ''; renderAppts(); renderCalConn(); renderSummary() })

// appointments first in the "Today" box
const _renderSummary2 = renderSummary
renderSummary = function () {
  _renderSummary2()
  if (!cal.connected || !cal.events) return
  const now = Date.now()
  const list = cal.events.filter((ev) => ev.allDay || ev.end >= now)
  const lines = list.slice(0, 5).map((ev) => `<button class="sum-line" data-sum-appt="${esc(ev.id)}">${esc(apptWhen(ev))} · ${esc(ev.title)} <span class="m">${ev.job ? '· 🔨 ' + esc(ev.job.name) : ev.customer ? '· ' + esc(ev.customer.name) : ''}${ev.phone ? ' · 🚗' : ''}</span></button>`)
  const col = `<div class="sum-col"><h3>Appointments today <span class="n">${list.length}</span></h3>${lines.join('') || '<div class="sum-line"><span class="m">Nothing left today</span></div>'}${list.length > 5 ? `<div class="sum-line"><span class="m">+${list.length - 5} more below</span></div>` : ''}</div>`
  const grid = document.querySelector('#sum-body .sum-grid')
  if (grid) grid.insertAdjacentHTML('afterbegin', col)
}
window.imsg.onSummary(() => loadCal(true))
loadCal()
setInterval(() => loadCal(), 10 * 60e3)

// ---- Team setup
$('#team-export').addEventListener('click', async () => {
  $('#team-msg').className = 'msg'
  try { const r = await window.imsg.teamExport(); if (r) $('#team-msg').textContent = `Saved ✓ ${r.apps} apps, ${r.quickReplies} quick replies → ${r.file}` } catch (err) { $('#team-msg').className = 'msg err'; $('#team-msg').textContent = errText(err) }
})
$('#team-import').addEventListener('click', async () => {
  $('#team-msg').className = 'msg'
  try { const r = await window.imsg.teamImport(); if (r) { $('#team-msg').textContent = `Imported ✓ ${r.added} apps added, ${r.quickReplies} quick replies`; loadSend() } } catch (err) { $('#team-msg').className = 'msg err'; $('#team-msg').textContent = errText(err) }
})

// ---- Opened from "Today": show the Text box for a follow-up, or "On my way" for a visit
window.imsg.onOpenItem(async (what, id) => {
  if (what === 'followup') {
    let x = allMoney().find((y) => y.id === id)
    if (!x) { await loadMoney(); x = allMoney().find((y) => y.id === id) }
    if (x) openSend(x)
  }
  if (what === 'omw') {
    let ev = (cal.events || []).find((y) => y.id === id)
    if (!ev) { await loadCal(); ev = (cal.events || []).find((y) => y.id === id) }
    if (ev) openOmw(ev)
  }
})


// ---- Morning summary settings
async function loadMorning() {
  try {
    const c = await window.imsg.morningGet()
    if (!c) return
    $('#mo-time').value = c.time || '07:30'
    if (document.activeElement !== $('#mo-phone')) $('#mo-phone').value = c.phone || ''
    $('#mo-notify').checked = c.notify !== false
    $('#mo-text').checked = c.text !== false
    $('#mo-state').textContent = c.phone && c.text ? 'Notification + text' : c.notify ? 'Notification' : 'Off'
  } catch {}
}
$('#mo-save').addEventListener('click', async () => {
  const msg = $('#mo-msg')
  try {
    await window.imsg.morningSet({ time: $('#mo-time').value, phone: $('#mo-phone').value, notify: $('#mo-notify').checked, text: $('#mo-text').checked })
    msg.className = 'msg'; msg.textContent = 'Saved ✓'
    loadMorning()
  } catch (err) { msg.className = 'msg err'; msg.textContent = errText(err) }
})
$('#mo-test').addEventListener('click', async () => {
  const msg = $('#mo-msg')
  msg.className = 'msg'; msg.textContent = 'Sending…'
  try {
    await window.imsg.morningSet({ time: $('#mo-time').value, phone: $('#mo-phone').value, notify: $('#mo-notify').checked, text: $('#mo-text').checked })
    const r = await window.imsg.morningTest()
    msg.className = 'msg'
    msg.textContent = r.text ? 'Sent to your phone ✓' : r.notify ? 'Notification shown. Add your phone number to get the text too.' : 'Nothing was sent.'
  } catch (err) { msg.className = 'msg err'; msg.textContent = errText(err) }
})
loadMorning()
