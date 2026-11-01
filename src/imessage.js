// iMessage / SMS on macOS.
// Reads your Messages history straight from the Mac's Messages database (read-only),
// and sends through the Messages app with AppleScript. Nothing is uploaded anywhere.
//
// Needs, once:
//  - Full Disk Access for the app that launches the browser (Terminal while you use `npm start`,
//    or "MultiSpace Browser" once installed as an app), so it can read ~/Library/Messages/chat.db.
//  - Permission to control "Messages" (macOS asks the first time you send).
const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadNicknames } = require('./nicknames')

const HOME = os.homedir()
const CHAT_DB = process.env.MULTISPACE_TEST_CHATDB || path.join(HOME, 'Library', 'Messages', 'chat.db')
const SQLITE = process.env.MULTISPACE_TEST_SQLITE || '/usr/bin/sqlite3'
const APPLE_EPOCH = 978307200 // 2001-01-01 in Unix seconds

function sqlite(db, sql) {
  return new Promise((resolve, reject) => {
    execFile(SQLITE, ['-readonly', '-json', db, sql], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message)
        const e = new Error(msg.trim())
        e.code = /authorization denied|unable to open|operation not permitted/i.test(msg) ? 'NO_ACCESS' : 'SQL'
        return reject(e)
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : [])
      } catch (e) {
        reject(e)
      }
    })
  })
}

const toMs = (d) => {
  if (!d) return 0
  const n = Number(d)
  const secs = n > 1e12 ? n / 1e9 : n
  return Math.round((secs + APPLE_EPOCH) * 1000)
}

// Newer macOS versions keep message text only in `attributedBody` (an archived NSAttributedString).
function decodeBody(hex) {
  if (!hex) return ''
  const b = Buffer.from(hex, 'hex')
  let i = b.indexOf('NSString')
  if (i < 0) return ''
  i += 8
  const plus = b.indexOf(0x2b, i)
  if (plus < 0 || plus - i > 8) return ''
  let p = plus + 1
  let len = b[p++]
  if (len === 0x81) {
    len = b.readUInt16LE(p)
    p += 2
  } else if (len === 0x82) {
    len = b.readUInt32LE(p)
    p += 4
  }
  return b.slice(p, p + len).toString('utf8')
}

// Strip attachment placeholders (U+FFFC), broken characters (U+FFFD) and invisible marks.
const cleanText = (t) => String(t || '').replace(/[\uFFFC\uFFFD\u200B\uFEFF]/g, '').trim()

// ---------------------------------------------------------------- contacts (names for numbers)

let contacts = null
let contactsAt = 0
const phoneKey = (v) => {
  const d = String(v || '').replace(/\D/g, '')
  return d.length >= 7 ? d.slice(-10) : ''
}

async function loadContacts() {
  if (contacts && Date.now() - contactsAt < 10 * 60 * 1000) return contacts
  const map = new Map()
  const root = path.join(HOME, 'Library', 'Application Support', 'AddressBook')
  const dbs = []
  const add = (p) => fs.existsSync(p) && dbs.push(p)
  add(path.join(root, 'AddressBook-v22.abcddb'))
  try {
    for (const s of fs.readdirSync(path.join(root, 'Sources'))) add(path.join(root, 'Sources', s, 'AddressBook-v22.abcddb'))
  } catch {}
  const sql = `
    SELECT r.ZFIRSTNAME f, r.ZLASTNAME l, r.ZORGANIZATION o, p.ZFULLNUMBER v, 'p' k FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
    UNION ALL
    SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS, 'e' FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`
  for (const db of dbs) {
    try {
      for (const r of await sqlite(db, sql)) {
        const name = [r.f, r.l].filter(Boolean).join(' ') || r.o
        if (!name || !r.v) continue
        const key = r.k === 'p' ? phoneKey(r.v) : String(r.v).toLowerCase()
        if (key && !map.has(key)) map.set(key, name)
      }
    } catch {}
  }
  contacts = map
  contactsAt = Date.now()
  return map
}

const handleKey = (h) => (String(h).includes('@') ? String(h).toLowerCase() : phoneKey(h))
let nicks = new Map()
async function loadNames() {
  const map = await loadContacts()
  try {
    nicks = await loadNicknames(sqlite, handleKey)
  } catch {}
  return map
}
// +19548045573 -> +1 (954) 804-5573
function prettyHandle(h) {
  const d = String(h || '').replace(/\D/g, '')
  if (/^\+?1?\d{10}$/.test(String(h).replace(/[\s().\-]/g, '')) && (d.length === 10 || (d.length === 11 && d[0] === '1'))) {
    const t = d.slice(-10)
    return `+1 (${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`
  }
  return String(h || '')
}
function nameFor(handle, map) {
  if (!handle) return ''
  const h = String(handle)
  return map.get(handleKey(h)) || prettyHandle(h)
}
// Contact name if saved; otherwise the name they shared with you ("Maybe: …"), flagged as maybe.
function personFor(handle, map) {
  const h = String(handle || '')
  const saved = map.get(handleKey(h))
  if (saved) return { handle: h, rawHandle: h, name: saved, maybe: '', saved: true }
  return { handle: prettyHandle(h), rawHandle: h, name: prettyHandle(h), maybe: nicks.get(handleKey(h)) || '', saved: false }
}

// ---------------------------------------------------------------- queries

async function status() {
  if (process.platform !== 'darwin' && !process.env.MULTISPACE_TEST_CHATDB) return { ok: false, reason: 'NOT_MAC' }
  try {
    await sqlite(CHAT_DB, 'SELECT 1 AS ok')
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.code === 'NO_ACCESS' ? 'NO_ACCESS' : 'ERROR', detail: e.message }
  }
}

async function listChats(limit = 150) {
  const map = await loadNames()
  const rows = await sqlite(
    CHAT_DB,
    `SELECT c.ROWID AS id, c.guid AS guid, c.chat_identifier AS ident, c.display_name AS name, c.service_name AS service,
            m.date AS date, m.text AS text, hex(m.attributedBody) AS body, m.is_from_me AS fromMe, m.cache_has_attachments AS att,
            (SELECT COUNT(*) FROM chat_message_join j2 JOIN message m2 ON m2.ROWID = j2.message_id
               WHERE j2.chat_id = c.ROWID AND m2.is_read = 0 AND m2.is_from_me = 0 AND m2.item_type = 0
                 AND m2.date > m.date - 2592000000000000) AS unread,
            (SELECT group_concat(h.id, ',') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID) AS members
       FROM chat c
       JOIN (SELECT j.chat_id AS chat_id, MAX(m.date) AS d FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id GROUP BY j.chat_id) last
         ON last.chat_id = c.ROWID
       JOIN message m ON m.ROWID = (SELECT j3.message_id FROM chat_message_join j3 JOIN message m3 ON m3.ROWID = j3.message_id
                                     WHERE j3.chat_id = c.ROWID AND m3.date = last.d LIMIT 1)
      ORDER BY m.date DESC LIMIT ${Number(limit) | 0}`
  )
  return rows.map((r) => {
    const members = String(r.members || '').split(',').filter(Boolean)
    const people = (members.length ? members : [r.ident]).map((h) => personFor(h, map))
    const title = r.name || people.map((p) => (people.length > 1 && p.maybe ? p.maybe : p.name)).join(', ')
    const maybe = !r.name && people.length === 1 ? people[0].maybe : ''
    const text = cleanText(r.text) || cleanText(decodeBody(r.body)) || 'Attachment'
    return {
      id: r.id,
      guid: r.guid,
      title,
      service: r.service,
      group: members.length > 1,
      last: (r.fromMe ? 'You: ' : '') + text,
      date: toMs(r.date),
      unread: r.unread || 0,
      lastFromMe: !!r.fromMe,
      handle: prettyHandle(members.length === 1 ? members[0] : r.ident),
      rawHandle: members.length === 1 ? members[0] : r.ident,
      maybe,
      saved: people.length === 1 && people[0].saved,
      members: members.map((h) => personFor(h, map)),
    }
  })
}

async function listMessages(chatId, limit = 300) {
  const map = await loadNames()
  const rows = await sqlite(
    CHAT_DB,
    `SELECT m.ROWID AS id, m.date AS date, m.text AS text, hex(m.attributedBody) AS body, m.is_from_me AS fromMe,
            m.service AS service, m.cache_has_attachments AS att, h.id AS sender
       FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE j.chat_id = ${Number(chatId) | 0} AND m.item_type = 0 AND COALESCE(m.associated_message_type, 0) = 0
      ORDER BY m.date DESC LIMIT ${Number(limit) | 0}`
  )
  return rows.reverse().map((r) => ({
    id: r.id,
    date: toMs(r.date),
    fromMe: !!r.fromMe,
    service: r.service,
    sender: r.fromMe ? 'You' : nameFor(r.sender, map),
    senderMaybe: r.fromMe ? '' : personFor(r.sender, map).maybe,
    text: cleanText(r.text) || cleanText(decodeBody(r.body)),
    attachment: !!r.att,
  }))
}

// ---------------------------------------------------------------- sending

function osascript(lines, args) {
  return new Promise((resolve, reject) => {
    const argv = []
    for (const l of lines) argv.push('-e', l)
    execFile('/usr/bin/osascript', [...argv, ...args], (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()))
  })
}

// Text and recipient are passed as arguments, never pasted into the script, so nothing in a message can run as code.
async function sendToChat(guid, text) {
  await osascript(['on run argv', 'tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)', 'end run'], [text, guid])
}

async function sendToHandle(handle, text) {
  try {
    await osascript(
      [
        'on run argv',
        'tell application "Messages"',
        'set s to 1st account whose service type = iMessage',
        'send (item 1 of argv) to participant (item 2 of argv) of s',
        'end tell',
        'end run',
      ],
      [text, handle]
    )
  } catch {
    await osascript(
      [
        'on run argv',
        'tell application "Messages"',
        'set s to 1st service whose service type = iMessage',
        'send (item 1 of argv) to buddy (item 2 of argv) of s',
        'end tell',
        'end run',
      ],
      [text, handle]
    )
  }
}

// Save a new person in the Contacts app. It goes to your default Contacts account, which is
// iCloud for most people, so it syncs to your iPhone. Values are passed as arguments, never as code.
async function addContact(c) {
  const v = (x) => String(x || '').trim().slice(0, 200)
  const first = v(c.first), last = v(c.last), company = v(c.company), phone = v(c.phone), email = v(c.email), note = String(c.note || '').trim().slice(0, 2000)
  if (!first && !last && !company) throw new Error('Enter a name or company')
  await osascript(
    [
      'on run argv',
      'set {fn, ln, co, ph, em, nt} to argv',
      'tell application "Contacts"',
      'set p to make new person with properties {first name:fn, last name:ln}',
      'if co is not "" then set organization of p to co',
      'if nt is not "" then set note of p to nt',
      'if ph is not "" then make new phone at end of phones of p with properties {label:"mobile", value:ph}',
      'if em is not "" then make new email at end of emails of p with properties {label:"work", value:em}',
      'save',
      'end tell',
      'end run',
    ],
    [first, last, company, phone, email, note]
  )
  contacts = null // re-read names so the new contact shows right away
}

module.exports = { addContact, status, listChats, listMessages, sendToChat, sendToHandle, decodeBody }
