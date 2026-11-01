// "Maybe:" names for people who aren't in your Contacts.
// When someone shares their name and photo with you in iMessage, macOS keeps it in
// ~/Library/Messages/NickNameCache (small key/value databases holding archived records).
// We read those read-only and pull out the shared first/last name for each phone number or email.
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = process.env.MULTISPACE_TEST_NICKDIR || path.join(os.homedir(), 'Library', 'Messages', 'NickNameCache')

// ---------------------------------------------------------------- minimal binary plist reader
class UID {
  constructor(v) {
    this.v = v
  }
}
function parseBplist(buf) {
  if (!buf || buf.length < 40 || buf.toString('latin1', 0, 6) !== 'bplist') return null
  const t = buf.length - 32
  const offSize = buf[t + 6]
  const refSize = buf[t + 7]
  const numObjects = Number(buf.readBigUInt64BE(t + 8))
  const top = Number(buf.readBigUInt64BE(t + 16))
  const tableOff = Number(buf.readBigUInt64BE(t + 24))
  if (numObjects > 1e6 || tableOff >= buf.length) return null
  const readN = (pos, n) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i]
    return v
  }
  const offsets = []
  for (let i = 0; i < numObjects; i++) offsets.push(readN(tableOff + i * offSize, offSize))
  const cache = new Map()
  const depth = { n: 0 }
  function obj(i) {
    if (cache.has(i)) return cache.get(i)
    if (++depth.n > 2000) throw new Error('too deep')
    const v = read(offsets[i])
    depth.n--
    cache.set(i, v)
    return v
  }
  function lenAt(pos, info) {
    if (info !== 0xf) return [info, pos + 1]
    const m = buf[pos + 1]
    const n = 1 << (m & 0xf)
    return [readN(pos + 2, n), pos + 2 + n]
  }
  function read(pos) {
    const marker = buf[pos]
    const type = marker >> 4
    const info = marker & 0xf
    switch (type) {
      case 0x0:
        return info === 8 ? false : info === 9 ? true : null
      case 0x1: {
        const n = 1 << info
        return n === 8 ? Number(buf.readBigInt64BE(pos + 1)) : readN(pos + 1, n)
      }
      case 0x2:
        return info === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1)
      case 0x3:
        return new Date((buf.readDoubleBE(pos + 1) + 978307200) * 1000)
      case 0x4: {
        const [len, start] = lenAt(pos, info)
        return buf.slice(start, start + len)
      }
      case 0x5: {
        const [len, start] = lenAt(pos, info)
        return buf.toString('latin1', start, start + len)
      }
      case 0x6: {
        const [len, start] = lenAt(pos, info)
        const b = Buffer.from(buf.slice(start, start + len * 2))
        b.swap16()
        return b.toString('utf16le')
      }
      case 0x8:
        return new UID(readN(pos + 1, info + 1))
      case 0xa: {
        const [len, start] = lenAt(pos, info)
        const out = []
        for (let k = 0; k < len; k++) out.push(obj(readN(start + k * refSize, refSize)))
        return out
      }
      case 0xd: {
        const [len, start] = lenAt(pos, info)
        const out = {}
        for (let k = 0; k < len; k++) {
          const key = obj(readN(start + k * refSize, refSize))
          out[String(key)] = obj(readN(start + (len + k) * refSize, refSize))
        }
        return out
      }
      default:
        return null
    }
  }
  return obj(top)
}

// Turn an NSKeyedArchiver plist into plain values (dictionaries, arrays, strings).
function unarchive(root) {
  if (!root || !Array.isArray(root.$objects) || !root.$top) return root
  const objs = root.$objects
  const seen = new Map()
  function res(v, d = 0) {
    if (d > 60) return null
    if (v instanceof UID) {
      if (seen.has(v.v)) return seen.get(v.v)
      seen.set(v.v, null)
      const r = res(objs[v.v], d + 1)
      seen.set(v.v, r)
      return r
    }
    if (v === '$null') return null
    if (Array.isArray(v)) return v.map((x) => res(x, d + 1))
    if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
      if (v['NS.keys'] && v['NS.objects']) {
        const o = {}
        v['NS.keys'].forEach((k, i) => (o[String(res(k, d + 1))] = res(v['NS.objects'][i], d + 1)))
        return o
      }
      if (v['NS.objects']) return v['NS.objects'].map((x) => res(x, d + 1))
      if ('NS.string' in v) return res(v['NS.string'], d + 1)
      if ('NS.bytes' in v) return v['NS.bytes']
      const o = {}
      for (const [k, x] of Object.entries(v)) if (k !== '$class') o[k] = res(x, d + 1)
      return o
    }
    return v
  }
  const top = root.$top
  const k = 'root' in top ? 'root' : Object.keys(top)[0]
  return res(top[k])
}

// ---------------------------------------------------------------- finding names and handles
const looksLikeHandle = (s) => typeof s === 'string' && (/^\+?[\d\s().\-]{7,}$/.test(s.trim()) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()))

function findName(v, d = 0) {
  if (!v || typeof v !== 'object' || d > 8 || Buffer.isBuffer(v)) return ''
  if (!Array.isArray(v)) {
    let first = '', last = '', display = ''
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== 'string' || !x.trim()) continue
      const key = k.toLowerCase()
      if (/first/.test(key) && /name|^first$/.test(key)) first = x.trim()
      else if (/last/.test(key) && /name|^last$/.test(key)) last = x.trim()
      else if (/display.?name|^name$|full.?name/.test(key)) display = x.trim()
    }
    const n = [first, last].filter(Boolean).join(' ') || display
    if (n) return n
  }
  for (const x of Object.values(v)) {
    const n = findName(x, d + 1)
    if (n) return n
  }
  return ''
}

function findHandles(v, out, d = 0) {
  if (!v || typeof v !== 'object' || d > 8 || Buffer.isBuffer(v)) return out
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && /handle|phone|email|address|^id$/i.test(k) && looksLikeHandle(x)) out.push(x)
    else if (Array.isArray(x) && /handle/i.test(k)) x.forEach((y) => looksLikeHandle(y) && out.push(y))
    else findHandles(x, out, d + 1)
  }
  return out
}

function decodeValue(hex) {
  if (!hex) return null
  const b = Buffer.from(hex, 'hex')
  try {
    const p = parseBplist(b)
    if (p != null) return unarchive(p)
  } catch {}
  const s = b.toString('utf8')
  return /^[\x20-\x7e]+$/.test(s) ? s : null
}

let cache = null
let cacheAt = 0

// Returns Map(handleKey -> name). `keyOf` normalises a phone/email the same way as Contacts lookups.
async function loadNicknames(sqlite, keyOf) {
  if (cache && Date.now() - cacheAt < 2 * 60 * 1000) return cache
  const map = new Map()
  let files = []
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith('.db')).map((f) => path.join(DIR, f))
  } catch {}
  const records = new Map() // record key -> name
  const links = [] // [handle, value string]
  const direct = [] // [handle, name]
  for (const db of files) {
    let tables = []
    try {
      tables = await sqlite(db, "SELECT name FROM sqlite_master WHERE type='table'")
    } catch {
      continue
    }
    for (const { name: table } of tables) {
      if (!/^[A-Za-z_][\w]*$/.test(table)) continue
      let cols
      try {
        cols = (await sqlite(db, `PRAGMA table_info(${table})`)).map((c) => c.name)
      } catch {
        continue
      }
      const kc = cols.find((c) => /^key$/i.test(c))
      const vc = cols.find((c) => /^value$/i.test(c))
      if (!kc || !vc) continue
      let rows = []
      try {
        rows = await sqlite(db, `SELECT CAST(${kc} AS TEXT) AS k, hex(${vc}) AS v FROM ${table} LIMIT 20000`)
      } catch {
        continue
      }
      for (const r of rows) {
        const key = String(r.k || '')
        const val = decodeValue(r.v)
        if (val == null) continue
        if (typeof val === 'string') {
          if (looksLikeHandle(key)) links.push([key, val])
          continue
        }
        const name = findName(val)
        if (!name) {
          // a handle -> record mapping stored as an archive
          if (looksLikeHandle(key)) {
            const s = Object.values(val).find((x) => typeof x === 'string')
            if (s) links.push([key, s])
          }
          continue
        }
        records.set(key, name)
        if (looksLikeHandle(key)) direct.push([key, name])
        for (const h of findHandles(val, [])) direct.push([h, name])
      }
    }
  }
  for (const [h, n] of direct) {
    const k = keyOf(h)
    if (k && !map.has(k)) map.set(k, n)
  }
  for (const [h, rec] of links) {
    const k = keyOf(h)
    if (k && !map.has(k) && records.has(rec)) map.set(k, records.get(rec))
  }
  cache = map
  cacheAt = Date.now()
  return map
}

module.exports = { loadNicknames, parseBplist, unarchive }
