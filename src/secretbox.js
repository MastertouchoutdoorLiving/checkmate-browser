// Stores API keys (JobTread, Quo, AI, calendar address) encrypted with a random key kept in the
// app's own data folder (0600). We do NOT use the macOS Keychain for these any more: the Keychain
// ties access to the app's code signature, so every update (new signature) locked the app out and
// the keys had to be pasted again. Saved passwords still use the Keychain (passwords.js).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app, safeStorage } = require('electron')

let masterKey = null
function master() {
  if (masterKey) return masterKey
  const f = path.join(app.getPath('userData'), 'secret.key')
  try {
    const b = fs.readFileSync(f)
    if (b.length === 32) return (masterKey = b)
  } catch {}
  masterKey = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, masterKey, { mode: 0o600 })
  return masterKey
}

function seal(value) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', master(), iv)
  const ct = Buffer.concat([c.update(String(value), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}
function unseal(b64) {
  const b = Buffer.from(b64, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', master(), b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

// entry: { key, enc } where enc === 'local' (new), true (old Keychain) or false (old plain).
function open(entry) {
  if (!entry || !entry.key) return ''
  try {
    if (entry.enc === 'local') return unseal(entry.key)
    const raw = Buffer.from(entry.key, 'base64')
    return entry.enc ? safeStorage.decryptString(raw) : raw.toString('utf8')
  } catch {
    return ''
  }
}
const pack = (value, extra = {}) => ({ key: seal(value), enc: 'local', ...extra })

module.exports = { open, pack }
