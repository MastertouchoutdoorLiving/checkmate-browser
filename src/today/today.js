// "Today": the summary of your day, shown when CheckMate starts.
// Unread messages (iMessage, WhatsApp, Gmail, other apps), today's visits, what's due and money to follow up.
// Everything here is read from the same places as Unread and Tasks; clicking a line opens it there.
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const api = window.imsg
const DAY = 864e5
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const money$ = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const errText = (err) => String((err && err.message) || err).replace(/^.*Error: /, '')
function ago(ts) {
  if (!ts) return ''
  const m = Math.round((Date.now() - ts) / 60e3)
  if (m < 1) return 'now'
  if (m < 60) return m + ' min'
  const h = Math.round(m / 60)
  if (h < 24) return h + ' h'
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : d + ' days'
}
function dayLabel(iso) {
  const diff = Math.round((new Date(iso + 'T12:00') - new Date(todayStr() + 'T12:00')) / DAY)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff < 0) return `${-diff} days late`
  return new Date(iso + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const S = {
  unified: null, gmail: null, todos: null, timers: { reminders: [], scheduled: [] }, jt: null, money: null,
  send: { followed: {} }, cal: null, waiting: [],
}
let uFilter = 'all'
const expanded = {}

// ---------------------------------------------------------------- header + stats
function renderHead() {
  const h = new Date().getHours()
  $('#hello').textContent = h < 12 ? 'Good morning ☀️' : h < 18 ? 'Good afternoon 👋' : 'Good evening 🌙'
  $('#date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' · here is your day'
  const stat = (n, label, target, red) => `<button class="stat ${red && n ? 'red' : ''}" data-go="${target}"><b>${n}</b>${label}</button>`
  $('#stats').innerHTML = [
    stat(visitsLeft().length, visitsLeft().length === 1 ? 'visit' : 'visits', 'box-visits'),
    stat(unreadTotal(), 'unread', 'box-unread', true),
    stat(dueItems().length, 'due today', 'box-due', dueItems().some((x) => x.late)),
    stat(followUps().length, 'follow-ups', 'box-fu'),
  ].join('')
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]')
  if (!b) return
  const box = document.getElementById(b.dataset.go)
  box.scrollIntoView({ behavior: 'smooth', block: 'start' })
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash')
})

// ---------------------------------------------------------------- visits (Google Calendar)
const visitsLeft = () => (S.cal && S.cal.events ? S.cal.events.filter((ev) => ev.allDay || ev.end >= Date.now()) : [])
function renderVisits() {
  const box = $('#visits')
  const c = S.cal
  $('#n-visits').textContent = c && c.events ? String(c.events.length) : ''
  if (!c) return
  if (!c.connected) { box.innerHTML = '<div class="empty">Connect Google Calendar to see your visits here. <button class="link" data-tasks="conn">Open Settings · Connections</button></div>'; return }
  if (c.error) { box.innerHTML = `<div class="empty">${esc(c.error)}</div>`; return }
  if (!c.events.length) { box.innerHTML = '<div class="empty">No visits on the calendar today.</div>'; return }
  const now = Date.now()
  box.innerHTML = (c.publicOnly ? '<div class="note">⚠️ The calendar only shows "Busy". Connect the <b>secret</b> iCal address in Tasks → Settings · Connections.</div>' : '') +
    c.events.map((ev) => {
      const who = ev.customer ? ev.customer.name : ''
      const sub = [ev.job ? '🔨 ' + ev.job.name : who ? '👤 ' + who : '', ev.location].filter(Boolean).join(' · ') || 'Not found in JobTread'
      return `<div class="row click ${!ev.allDay && ev.end < now ? 'past' : ''}" data-visit="${esc(ev.id)}" title="${ev.job || ev.customer ? 'Open in JobTread' : ''}">
        <span class="when">${ev.allDay ? 'All day' : esc(hm(ev.start))}</span>
        <div class="body"><div class="t">${esc(ev.title)}</div><div class="s">${esc(sub)}</div></div>
        <div class="acts">
          ${ev.location ? '<button class="btn small" data-visit-act="map" title="Directions">🗺️</button>' : ''}
          ${ev.allDay ? '' : `<button class="btn small ${ev.phone ? 'primary' : ''}" data-visit-act="omw" title="Text the customer you are on the way">🚗 On my way</button>`}
        </div></div>`
    }).join('')
}
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-visit]')
  if (!row) return
  const ev = (S.cal.events || []).find((x) => x.id === row.dataset.visit)
  if (!ev) return
  const act = (e.target.closest('[data-visit-act]') || {}).dataset?.visitAct
  if (act === 'map') return api.openUrl('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(ev.location))
  if (act === 'omw') return api.openTasks('omw', ev.id)
  if (ev.job) return api.jtOpen(ev.job.url)
  if (ev.customer) return api.jtOpen(ev.customer.url)
})

// ---------------------------------------------------------------- unread messages
function unreadRows() {
  const rows = []
  const u = S.unified || { items: [] }
  const gmailOk = new Set((S.gmail || []).filter((g) => g.state === 'ok').map((g) => g.spaceId))
  for (const it of u.items) {
    if (it.kind === 'imsg') rows.push({ src: 'imsg', tag: 'iMessage', name: it.name, preview: it.preview, count: it.count, date: it.date, job: it.job, open: { kind: 'imsg', guid: it.guid } })
    else if (it.kind === 'wa') rows.push({ src: 'wa', tag: 'WhatsApp', name: it.name, preview: it.preview, count: it.count, time: it.time, job: it.job, open: { kind: 'wa', spaceId: it.spaceId, tabId: it.tabId, name: it.name } })
    else if (it.kind === 'app') {
      // Gmail's real emails are listed below, so skip its plain counter
      if (gmailOk.has(it.spaceId) && /gmail|inbox|mail/i.test(it.name)) continue
      rows.push({ src: 'app', tag: it.name.slice(0, 12), name: it.name + (u.multiSpace && it.space ? ' · ' + it.space : ''), preview: `${it.count} unread`, count: it.count, open: { kind: 'app', spaceId: it.spaceId, tabId: it.tabId } })
    }
  }
  const multi = (S.gmail || []).filter((g) => g.state === 'ok').length > 1
  for (const g of S.gmail || []) {
    if (g.state !== 'ok') continue
    for (const m of g.emails) rows.push({ src: 'gmail', tag: 'Gmail', name: m.from || m.email, preview: m.subject + (m.preview ? ' — ' + m.preview : ''), date: m.date, sub: multi ? g.account || g.space : '', gmail: { spaceId: g.spaceId, id: m.messageId } })
    if (g.count > g.emails.length) rows.push({ src: 'gmail', tag: 'Gmail', name: `+${g.count - g.emails.length} more unread emails`, preview: g.account || g.space, gmail: { spaceId: g.spaceId, id: '' }, date: 0 })
  }
  rows.sort((a, b) => (b.date || 0) - (a.date || 0))
  return rows
}
function unreadTotal() {
  const u = S.unified || { items: [] }
  let n = 0
  for (const r of unreadRows()) n += r.src === 'gmail' ? 0 : r.count || 1
  for (const g of S.gmail || []) if (g.state === 'ok') n += g.count
  return n
}
const SRC = [['all', 'All'], ['imsg', 'iMessage'], ['wa', 'WhatsApp'], ['gmail', 'Gmail'], ['app', 'Other apps']]
function renderUnread() {
  if (!S.unified && !S.gmail) return
  const rows = unreadRows()
  const n = unreadTotal()
  $('#n-unread').textContent = n ? String(n) : '0'
  $('#n-unread').classList.toggle('red', n > 0)
  const counts = {}
  for (const r of rows) counts[r.src] = (counts[r.src] || 0) + 1
  $('#u-filters').innerHTML = SRC.filter(([k]) => k === 'all' || counts[k]).map(([k, l]) => `<button data-uf="${k}" class="${uFilter === k ? 'on' : ''}">${l}${k !== 'all' ? ' ' + counts[k] : ''}</button>`).join('')
  const list = rows.filter((r) => uFilter === 'all' || r.src === uFilter)
  const notes = []
  const u = S.unified || {}
  if (u.imsgState === 'no-access') notes.push('iMessage needs Full Disk Access (System Settings → Privacy & Security). Open the iMessage app for help.')
  if (u.imsgState !== undefined && !u.waOpen && !(S.gmail || []).length) notes.push('Open WhatsApp and Gmail in CheckMate to see their unread messages here too.')
  else if (u.imsgState !== undefined && !u.waOpen) notes.push('WhatsApp is not open, so its unread chats are not counted.')
  for (const g of S.gmail || []) if (g.state === 'signed-out') notes.push(`Gmail${g.space ? ' (' + esc(g.space) + ')' : ''}: sign in to Gmail in CheckMate to list unread emails.`)
  const max = expanded.unread ? 200 : 8
  $('#unread').innerHTML = (list.length
    ? list.slice(0, max).map((r, i) => `<button class="row" data-u="${rows.indexOf(r)}">
        <span class="tag ${r.src}">${esc(r.tag)}</span>
        <div class="body"><div class="t">${esc(r.name)}${r.job ? ' <span class="s">· 🔨 ' + esc(r.job) + '</span>' : ''}</div><div class="s">${esc(r.preview || '')}${r.sub ? ' · ' + esc(r.sub) : ''}</div></div>
        <span class="time">${esc(r.date ? ago(r.date) : r.time || '')}</span>
        ${r.count > 1 ? `<span class="cnt">${r.count}</span>` : ''}
      </button>`).join('') + (list.length > max ? `<button class="more" data-more="unread">Show ${list.length - max} more</button>` : '')
    : '<div class="empty">No unread messages. 🎉</div>') + notes.map((x) => `<div class="note">${x}</div>`).join('')
  $('#unread')._rows = rows
  const w = S.waiting || []
  $('#waiting-wrap').hidden = !w.length
  $('#waiting').innerHTML = w.slice(0, 6).map((x) => `<button class="row" data-wait="${esc(x.guid)}"><span class="tag imsg">iMessage</span><div class="body"><div class="t late">${esc(x.title)}${x.job ? ' <span class="s">· 🔨 ' + esc(x.job) + '</span>' : ''}</div><div class="s">${esc(x.last || '')}</div></div><span class="time">${esc(ago(x.date))}</span></button>`).join('')
}
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-uf]')
  if (f) { uFilter = f.dataset.uf; return renderUnread() }
  const m = e.target.closest('[data-more]')
  if (m) { expanded[m.dataset.more] = true; return renderAll() }
  const w = e.target.closest('[data-wait]')
  if (w) return api.unifiedOpen({ kind: 'imsg', guid: w.dataset.wait })
  const b = e.target.closest('[data-u]')
  if (!b) return
  const r = ($('#unread')._rows || [])[Number(b.dataset.u)]
  if (!r) return
  if (r.gmail) return api.openGmail(r.gmail.spaceId, r.gmail.id)
  api.unifiedOpen(r.open)
})

// ---------------------------------------------------------------- due today
function dueItems() {
  const now = Date.now(), end = startOfDay(now) + DAY, t = todayStr()
  const out = []
  for (const x of S.todos || []) if (!x.done && x.due && x.due < end) out.push({ kind: 'todo', id: x.id, title: x.text, sub: (x.due < now ? 'Overdue · ' : '') + (startOfDay(x.due) === startOfDay(now) ? hm(x.due) : new Date(x.due).toLocaleDateString([], { month: 'short', day: 'numeric' })), late: x.due < now, sort: x.due })
  for (const k of (S.jt && S.jt.tasks) || []) if (k.due && k.due <= t) out.push({ kind: 'jt', id: k.id, title: k.name, sub: dayLabel(k.due) + (k.job ? ' · ' + (k.job.number ? '#' + k.job.number + ' ' : '') + k.job.name : ''), late: k.due < t, url: k.url, sort: new Date(k.due + 'T09:00').getTime() })
  for (const r of S.timers.reminders || []) if (r.at < end) out.push({ kind: 'rem', id: r.id, title: 'Reply to ' + (r.title || r.name || 'conversation'), sub: (r.at < now ? 'Overdue · ' : '') + hm(r.at), late: r.at < now, sort: r.at })
  return out.sort((a, b) => (b.late - a.late) || a.sort - b.sort)
}
function renderDue() {
  if (!S.todos) return
  const list = dueItems()
  $('#n-due').textContent = String(list.length)
  $('#n-due').classList.toggle('red', list.some((x) => x.late))
  const tag = { todo: ['me', 'To-do'], jt: ['jt', 'JobTread'], rem: ['rem', 'Reminder'] }
  const max = expanded.due ? 200 : 10
  let html = list.slice(0, max).map((x) => `<div class="row click" data-due="${x.kind}:${esc(x.id)}">
      ${x.kind === 'rem' ? '' : `<button class="chk" data-due-act="done" title="Mark as done"></button>`}
      <span class="tag ${tag[x.kind][0]}">${tag[x.kind][1]}</span>
      <div class="body"><div class="t">${esc(x.title)}</div><div class="s ${x.late ? 'late' : ''}">${esc(x.sub)}</div></div>
    </div>`).join('')
  if (list.length > max) html += `<button class="more" data-more="due">Show ${list.length - max} more</button>`
  if (!list.length) html = '<div class="empty">Nothing due today. 🎉</div>'
  if (S.jt && !S.jt.connected) html += '<div class="note">Connect JobTread to see the tasks assigned to you. <button class="link" data-tasks="conn">Settings · Connections</button></div>'
  $('#due').innerHTML = html
}
document.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-due]')
  if (!row) return
  const [kind, ...rest] = row.dataset.due.split(':')
  const id = rest.join(':')
  const done = e.target.closest('[data-due-act="done"]')
  if (done) {
    row.classList.add('done'); done.textContent = '✓'
    try {
      if (kind === 'todo') await api.updateTodo(id, { done: true })
      if (kind === 'jt') { await api.jtTaskDone(id); S.jt.tasks = S.jt.tasks.filter((k) => k.id !== id) }
      setTimeout(renderAll, 500)
    } catch (err) { row.classList.remove('done'); done.textContent = ''; alert(errText(err)) }
    return
  }
  if (kind === 'jt') { const k = S.jt.tasks.find((x) => x.id === id); if (k) api.jtOpen(k.url) }
  if (kind === 'rem') api.openReminder(id)
  if (kind === 'todo') api.openTasks()
})

// ---------------------------------------------------------------- follow-ups (estimates, overdue invoices)
const recentlyDone = (id) => S.send.followed && S.send.followed[id] && Date.now() - S.send.followed[id] < 7 * DAY
function followUps() {
  if (!S.money || !S.money.connected) return []
  return [...(S.money.invoices || []), ...(S.money.estimates || [])].filter((x) => !recentlyDone(x.id))
}
function renderFu() {
  if (!S.money) return
  const box = $('#fu')
  if (!S.money.connected) { $('#n-fu').textContent = ''; box.innerHTML = '<div class="empty">Connect JobTread to see estimates to follow up and overdue invoices. <button class="link" data-tasks="conn">Settings · Connections</button></div>'; return }
  if (S.money.error) { box.innerHTML = `<div class="empty">${esc(S.money.error)}</div>`; return }
  const list = followUps()
  $('#n-fu').textContent = String(list.length)
  if (!list.length) { box.innerHTML = '<div class="empty">No estimates waiting and no overdue invoices. 🎉</div>'; return }
  const max = expanded.fu ? 200 : 8
  box.innerHTML = list.slice(0, max).map((x) => `<div class="row click" data-fu="${esc(x.id)}" title="Open in JobTread">
      <span class="tag ${x.kind === 'invoice' ? 'gmail' : 'jt'}">${x.kind === 'invoice' ? 'Invoice' : 'Estimate'}</span>
      <div class="body"><div class="t">${esc(x.customer || 'Customer')}${x.job ? ' · ' + esc(x.job.name) : ''}</div>
      <div class="s ${x.kind === 'invoice' ? 'late' : ''}">${x.kind === 'invoice' ? `${x.days} days overdue` : `sent ${x.days} days ago`}${x.number ? ' · #' + esc(x.number) : ''}</div></div>
      <span class="amt">${money$(x.amount)}</span>
      <button class="btn small primary" data-fu-act="text" ${x.phone ? '' : 'disabled title="No phone in JobTread"'}>💬 Text</button>
    </div>`).join('') + (list.length > max ? `<button class="more" data-more="fu">Show ${list.length - max} more</button>` : '')
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tasks]')
  if (t) return t.dataset.tasks === 'conn' ? api.openSettings() : api.openTasks()
  const row = e.target.closest('[data-fu]')
  if (!row) return
  const x = followUps().find((y) => y.id === row.dataset.fu)
  if (!x) return
  if (e.target.closest('[data-fu-act="text"]')) return api.openTasks('followup', x.id)
  api.jtOpen(x.url)
})

// ---------------------------------------------------------------- loading
function renderAll() { renderHead(); renderVisits(); renderUnread(); renderDue(); renderFu() }
const safe = (p, fallback) => Promise.resolve().then(p).catch((err) => (typeof fallback === 'function' ? fallback(err) : fallback))
async function loadMessages(fresh) {
  const [u, g, w] = await Promise.all([safe(() => api.unifiedList(), { items: [] }), safe(() => api.todayGmail(fresh), []), safe(() => api.unanswered(), [])])
  S.unified = u || { items: [] }; S.gmail = g || []; S.waiting = w || []
  renderHead(); renderUnread()
}
async function loadWork(fresh) {
  const [todos, timers, jt, money, send, cal] = await Promise.all([
    safe(() => api.todos(), []),
    safe(() => api.timers(), { reminders: [], scheduled: [] }),
    safe(() => api.jtMyTasks(fresh), (err) => ({ connected: true, tasks: [], error: errText(err) })),
    safe(() => api.jtMoney(fresh), (err) => ({ connected: true, estimates: [], invoices: [], error: errText(err) })),
    safe(() => api.sendSettings(), null),
    safe(() => api.calToday(fresh), (err) => ({ connected: true, events: [], error: errText(err) })),
  ])
  S.todos = todos || []; S.timers = timers || { reminders: [], scheduled: [] }; S.jt = jt || { connected: false, tasks: [] }
  S.money = money || { connected: false }; if (send) S.send = send; S.cal = cal || { connected: false, events: [] }
  renderAll()
}
function loadAll(fresh) { loadMessages(fresh); loadWork(fresh) }

$('#refresh').addEventListener('click', () => loadAll(true))
$('#open-tasks').addEventListener('click', () => api.openTasks())
api.onTodos((t) => { S.todos = t; renderHead(); renderDue() })
api.onTimers((t) => { S.timers = t; renderHead(); renderDue() })
api.onTodayRefresh(() => loadAll(false))
// Keep it fresh while it's on screen: messages every 30 s, the rest every 5 min.
setInterval(() => { if (!document.hidden) loadMessages(false) }, 30e3)
setInterval(() => { if (!document.hidden) loadWork(false) }, 5 * 60e3)
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMessages(false) })
renderHead()
loadAll(false)
