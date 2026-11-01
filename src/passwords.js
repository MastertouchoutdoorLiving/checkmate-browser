// Built-in password vault.
// Saved logins are encrypted on disk with the operating system's keychain
// (macOS Keychain / Windows DPAPI / Linux secret store) via Electron's safeStorage.
// Passwords never leave this computer.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { safeStorage } = require('electron')

class PasswordVault {
  constructor(dir) {
    this.file = path.join(dir, 'passwords.enc')
    this.items = null // loaded lazily so the keychain prompt only appears when needed
  }

  available() {
    // Test-only escape hatch for Linux CI machines without a keyring. Never set on a real computer.
    if (process.platform === 'linux' && process.env.MULTISPACE_TEST_PLAINTEXT_VAULT === '1' && safeStorage.setUsePlainTextEncryption) {
      safeStorage.setUsePlainTextEncryption(true)
    }
    return safeStorage.isEncryptionAvailable()
  }

  load() {
    if (this.items) return this.items
    this.items = []
    if (fs.existsSync(this.file)) {
      try {
        this.items = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file)))
      } catch (err) {
        console.error('[passwords] could not decrypt vault:', err.message)
        throw new Error('Could not unlock saved passwords (keychain access was denied).')
      }
    }
    return this.items
  }

  save() {
    if (!this.available()) throw new Error('Secure storage is not available on this computer.')
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(this.items)), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  // Safe summary for the UI (no passwords).
  list() {
    return this.load()
      .map(({ id, host, url, username, name }) => ({ id, host, url, username, name }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username))
  }

  add({ url, username, password, name }) {
    const host = hostKey(url)
    if (!host || !password) return false
    const items = this.load()
    const existing = items.find((i) => i.host === host && i.username === (username || ''))
    if (existing) {
      existing.password = password
      existing.url = url
    } else {
      items.push({ id: crypto.randomBytes(6).toString('hex'), host, url, username: username || '', password, name: name || '' })
    }
    return true
  }

  remove(id) {
    this.items = this.load().filter((i) => i.id !== id)
    this.save()
  }

  // Logins for a page. `pageUrl` comes from the main process (the frame's real URL),
  // never from the page itself, so a site can only get its own passwords.
  forUrl(pageUrl) {
    let u
    try {
      u = new URL(pageUrl)
    } catch {
      return []
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return []
    const host = u.hostname.replace(/^www\./, '')
    return this.load()
      .filter((i) => i.host === host || host.endsWith('.' + i.host) || i.host.endsWith('.' + host))
      .map(({ username, password }) => ({ username, password }))
  }

  // Import a CSV exported from Chrome, Shift, Edge, Brave, Firefox, Safari, Bitwarden, 1Password, LastPass…
  importCsv(text) {
    const rows = parseCsv(text)
    if (rows.length < 2) return { added: 0, skipped: 0 }
    const header = rows[0].map((h) => h.trim().toLowerCase())
    const col = (...names) => header.findIndex((h) => names.includes(h))
    const iUrl = col('url', 'login_uri', 'website', 'login url', 'web site', 'origin_url')
    const iUser = col('username', 'login_username', 'user name', 'login', 'email', 'login name')
    const iPass = col('password', 'login_password')
    const iName = col('name', 'title')
    if (iUrl < 0 || iPass < 0) throw new Error('This file has no "url" and "password" columns. Export passwords as CSV from Chrome or Shift.')
    let added = 0
    let skipped = 0
    for (const r of rows.slice(1)) {
      const url = (r[iUrl] || '').trim()
      const ok = this.add({
        url: /^[a-z]+:\/\//i.test(url) ? url : url ? 'https://' + url : '',
        username: iUser >= 0 ? (r[iUser] || '').trim() : '',
        password: r[iPass] || '',
        name: iName >= 0 ? r[iName] || '' : '',
      })
      ok ? added++ : skipped++
    }
    this.save()
    return { added, skipped }
  }
}

function hostKey(url) {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return ''
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let q = false
  text = text.replace(/^﻿/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++
        else q = false
      } else field += c
    } else if (c === '"') q = true
    else if (c === ',') row.push(field), (field = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((x) => x !== '')) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

module.exports = { PasswordVault, parseCsv }
