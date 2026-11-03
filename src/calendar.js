// Today's appointments from a Google Calendar "secret address in iCal format" (no Google sign-in needed).
// Google Calendar → Settings → your calendar → Integrate calendar → Secret address in iCal format.
const { net } = require('electron')

function unfold(text) { return String(text).replace(/\r?\n[ \t]/g, '') }
function unescape(v) { return String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1') }
// "20261103T140000Z" | "20261103T090000" (local) | "20261103" (all day)
function parseDate(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (!h) return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true }
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), allDay: false }
  // TZID times: treated as this computer's local time (fine when the calendar and the Mac share a time zone)
  return { t: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false, tz: params && params.TZID }
}
function parse(text) {
  const events = []
  let cur = null
  for (const raw of unfold(text).split(/\r?\n/)) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue }
    if (raw === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue }
    if (!cur) continue
    const i = raw.indexOf(':')
    if (i < 0) continue
    const [name, ...ps] = raw.slice(0, i).split(';')
    const params = Object.fromEntries(ps.map((p) => p.split('=')))
    const val = raw.slice(i + 1)
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = val; break
      case 'SUMMARY': cur.title = unescape(val); break
      case 'LOCATION': cur.location = unescape(val); break
      case 'DESCRIPTION': cur.description = unescape(val).replace(/<[^>]+>/g, ' '); break
      case 'DTSTART': cur.start = parseDate(val, params); break
      case 'DTEND': cur.end = parseDate(val, params); break
      case 'RRULE': cur.rrule = Object.fromEntries(val.split(';').map((p) => p.split('='))); break
      case 'EXDATE': for (const v of val.split(',')) { const d = parseDate(v, params); if (d) cur.exdates.push(d.t) } break
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(val, params); break
      case 'STATUS': cur.status = val; break
    }
  }
  return events
}
const DAY = 864e5
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
// Does a recurring event happen on the day that starts at dayStart? Returns that occurrence's start time or null.
function occursOn(ev, dayStart) {
  const s = new Date(ev.start.t)
  const occ = new Date(dayStart); occ.setHours(s.getHours(), s.getMinutes(), s.getSeconds(), 0)
  const t = occ.getTime()
  if (t < ev.start.t - (ev.start.allDay ? 0 : 1000) && new Date(t).toDateString() !== s.toDateString()) return null
  const r = ev.rrule
  if (!r) return new Date(ev.start.t).toDateString() === new Date(dayStart).toDateString() ? ev.start.t : null
  if (r.UNTIL) { const u = parseDate(r.UNTIL); if (u && t > u.t + DAY) return null }
  const interval = Number(r.INTERVAL || 1)
  const days = Math.round((startOfDay(t) - startOfDay(ev.start.t)) / DAY)
  if (days < 0) return null
  const freq = r.FREQ
  let ok = false, n = 0
  if (freq === 'DAILY') { ok = days % interval === 0; n = days / interval }
  else if (freq === 'WEEKLY') {
    const want = r.BYDAY ? r.BYDAY.split(',').map((x) => BYDAY[x.slice(-2)]) : [s.getDay()]
    const weeks = Math.floor((startOfWeek(t) - startOfWeek(ev.start.t)) / (7 * DAY))
    ok = want.includes(occ.getDay()) && weeks % interval === 0
    n = weeks * want.length
  } else if (freq === 'MONTHLY') {
    const months = (occ.getFullYear() - s.getFullYear()) * 12 + occ.getMonth() - s.getMonth()
    if (r.BYDAY && /^[+-]?\d/.test(r.BYDAY)) {
      const nth = parseInt(r.BYDAY, 10), wd = BYDAY[r.BYDAY.slice(-2)]
      const idx = Math.ceil(occ.getDate() / 7)
      const last = occ.getDate() + 7 > new Date(occ.getFullYear(), occ.getMonth() + 1, 0).getDate()
      ok = months % interval === 0 && occ.getDay() === wd && (nth === idx || (nth === -1 && last))
    } else ok = months % interval === 0 && occ.getDate() === (r.BYMONTHDAY ? Number(r.BYMONTHDAY) : s.getDate())
    n = months / interval
  } else if (freq === 'YEARLY') {
    ok = (occ.getFullYear() - s.getFullYear()) % interval === 0 && occ.getMonth() === s.getMonth() && occ.getDate() === s.getDate()
    n = (occ.getFullYear() - s.getFullYear()) / interval
  }
  if (!ok) return null
  if (r.COUNT && n >= Number(r.COUNT)) return null
  if (ev.exdates.some((x) => Math.abs(x - t) < 60000 || (ev.start.allDay && new Date(x).toDateString() === occ.toDateString()))) return null
  return t
}
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
function startOfWeek(t) { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - d.getDay()); return d.getTime() }

async function today(url, when = Date.now()) {
  if (!/^https:\/\//i.test(url) && !process.env.MULTISPACE_TEST_CAL) throw new Error('Paste the calendar\'s secret iCal address (it starts with https://).')
  const res = await net.fetch(String(url).replace(/^webcal:/i, 'https:'))
  if (!res.ok) throw new Error(`Could not read the calendar (${res.status}). Check the secret iCal address.`)
  const text = await res.text()
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That address is not an iCal calendar.')
  const events = parse(text)
  const day = startOfDay(when)
  // moved/changed single occurrences of recurring events replace the original occurrence
  const overrides = events.filter((e) => e.recurrenceId)
  const out = []
  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue
    let t = null
    if (ev.recurrenceId) t = startOfDay(ev.start.t) === day ? ev.start.t : null
    else if (ev.rrule) {
      t = occursOn(ev, day)
      if (t != null && overrides.some((o) => o.uid === ev.uid && Math.abs(o.recurrenceId.t - t) < 60000)) t = null
    } else if (ev.start.allDay) {
      const end = ev.end ? ev.end.t : ev.start.t + DAY
      t = ev.start.t <= day && end > day ? day : null
    } else t = startOfDay(ev.start.t) === day ? ev.start.t : null
    if (t == null) continue
    const dur = ev.end && ev.start ? ev.end.t - ev.start.t : 3600e3
    out.push({ id: `${ev.uid || ev.title}|${t}`, title: ev.title || '(no title)', location: ev.location || '', description: (ev.description || '').slice(0, 2000), start: t, end: t + dur, allDay: !!ev.start.allDay })
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1))
}

module.exports = { today, parse }
