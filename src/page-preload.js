// Runs in every page of every space before the site's own scripts.
// This browser can't show the passkey / security-key prompt (Touch ID, phone, USB key),
// so sites like Google would hang on "Complete sign-in using your passkey".
// Hiding passkey support makes them fall back to password + normal 2-step verification.
const { contextBridge, webFrame } = require('electron')

const hidePasskeys = () => {
  try {
    delete window.PublicKeyCredential
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true })
  } catch {}
  const creds = navigator.credentials
  if (creds) {
    for (const m of ['get', 'create']) {
      const orig = creds[m] && creds[m].bind(creds)
      if (!orig) continue
      creds[m] = (opts) =>
        opts && opts.publicKey
          ? Promise.reject(new DOMException('Passkeys are not supported in this browser.', 'NotAllowedError'))
          : orig(opts)
    }
  }
}

if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: hidePasskeys })
else webFrame.executeJavaScript(`(${hidePasskeys.toString()})()`)

// On Google's sign-in pages, look like Firefox inside the page too (matches the request headers set
// in main.js), so Google doesn't block sign-in as "This browser or app may not be secure".
const GOOGLE_SIGNIN_HOSTS = ['accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com']
if (GOOGLE_SIGNIN_HOSTS.includes(location.hostname)) {
  const version = 128 + Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 864e5))
  const mac = process.platform === 'darwin'
  const win = process.platform === 'win32'
  const ua = `Mozilla/5.0 (${mac ? 'Macintosh; Intel Mac OS X 10.15' : win ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`
  const lookLikeFirefox = (ua, platform, appVersion, oscpu) => {
    const nav = Object.getPrototypeOf(navigator)
    const def = (k, v) => {
      try {
        Object.defineProperty(nav, k, { get: () => v, configurable: true })
      } catch {}
    }
    def('userAgent', ua)
    def('appVersion', appVersion)
    def('vendor', '')
    def('platform', platform)
    def('userAgentData', undefined)
    def('oscpu', oscpu)
  }
  const args = mac
    ? [ua, 'MacIntel', '5.0 (Macintosh)', 'Intel Mac OS X 10.15']
    : win
      ? [ua, 'Win32', '5.0 (Windows)', 'Windows NT 10.0; Win64; x64']
      : [ua, 'Linux x86_64', '5.0 (X11)', 'Linux x86_64']
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: lookLikeFirefox, args })
  else webFrame.executeJavaScript(`(${lookLikeFirefox.toString()})(...${JSON.stringify(args)})`)
}

// ---------------------------------------------------------------- password autofill
// Runs in an isolated world: the page can't see this code or call into it.
const { ipcRenderer } = require('electron')

const visible = (el) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.disabled && !el.readOnly
}
const USER_SEL =
  'input[autocomplete~="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[id*="user" i], input[id*="email" i], input[id*="login" i], input[id="identifierId"]'

function findFields() {
  const pass = [...document.querySelectorAll('input[type="password"]')].filter(visible)
  if (pass.some((p) => p.autocomplete === 'new-password') && pass.length > 1) return null // sign-up / change-password form
  const pw = pass[0] || null
  let user = null
  const scope = (pw && pw.form) || document
  const candidates = [...scope.querySelectorAll(USER_SEL + ', input[type="text"], input[type="tel"], input:not([type])')].filter(
    (el) => visible(el) && el.type !== 'password' && el.type !== 'hidden' && el.type !== 'search'
  )
  if (pw) {
    // the text field closest before the password field
    const before = candidates.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)
    user = before.find((el) => el.matches(USER_SEL)) || before[before.length - 1] || null
  } else {
    // username-only step (e.g. Google, Microsoft)
    user = candidates.find((el) => el.matches('input[autocomplete~="username"], input[type="email"], input[id="identifierId"]')) || null
  }
  return user || pw ? { user, pw } : null
}

function setValue(el, value) {
  if (!el || el.value === value) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  el.focus()
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

let logins = null
let filledFor = new WeakSet()
let chooser = null

async function getLogins() {
  if (logins) return logins
  try {
    logins = await ipcRenderer.invoke('pw:lookup')
  } catch {
    logins = []
  }
  return logins
}

function fill(fields, login) {
  if (fields.user && login.username) setValue(fields.user, login.username)
  if (fields.pw) setValue(fields.pw, login.password)
}

function showChooser(anchor, list, fields) {
  if (chooser) chooser.remove()
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'closed' })
  const r = anchor.getBoundingClientRect()
  host.style.cssText = `position:fixed;z-index:2147483647;left:${r.left}px;top:${r.bottom + 4}px;`
  root.innerHTML = `<style>
    .box{font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#fff;color:#1f2328;border:1px solid #dfe2e7;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);min-width:${Math.max(220, r.width)}px;overflow:hidden}
    .h{padding:6px 10px;color:#6b7280;font-size:11px}
    button{display:block;width:100%;text-align:left;border:0;background:none;padding:8px 10px;font:inherit;cursor:pointer}
    button:hover{background:#eef3ff}</style>
    <div class="box"><div class="h">Saved logins</div></div>`
  const box = root.querySelector('.box')
  list.forEach((l) => {
    const b = document.createElement('button')
    b.textContent = l.username || '(no username)'
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      fill(fields, l)
      host.remove()
      chooser = null
    })
    box.appendChild(b)
  })
  document.documentElement.appendChild(host)
  chooser = host
  setTimeout(() => document.addEventListener('mousedown', () => (host.remove(), (chooser = null)), { once: true }), 0)
}

async function scan() {
  const fields = findFields()
  if (!fields) return
  const key = fields.pw || fields.user
  if (filledFor.has(key)) return
  const list = await getLogins()
  if (!list.length) return
  filledFor.add(key)
  if (list.length === 1) fill(fields, list[0])
  else {
    // several accounts for this site: fill nothing until the person picks one
    const anchor = fields.user || fields.pw
    const open = () => showChooser(anchor, list, findFields() || fields)
    anchor.addEventListener('focus', open)
    if (document.activeElement === anchor) open()
  }
}

let scanTimer
const scheduleScan = () => {
  clearTimeout(scanTimer)
  scanTimer = setTimeout(scan, 250)
}

// Offer to save a password when a login form is submitted.
let lastOffered = ''
function captureLogin() {
  const pw = [...document.querySelectorAll('input[type="password"]')].find((p) => p.value)
  if (!pw) return
  if (pw.autocomplete === 'new-password') return
  const f = findFields() || {}
  const username = (f.user && f.user.value) || sessionStorage.getItem('__ms_last_user') || ''
  const sig = username + '\n' + pw.value
  if (sig === lastOffered) return
  lastOffered = sig
  ipcRenderer.send('pw:offer-save', { username, password: pw.value })
}

window.addEventListener('DOMContentLoaded', () => {
  if (!/^https?:$/.test(location.protocol)) return
  scheduleScan()
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true })
  // remember the username typed on a "username first" page (Google, Microsoft) for the password step
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target
      if (el instanceof HTMLInputElement && el.matches(USER_SEL) && el.value) {
        try {
          sessionStorage.setItem('__ms_last_user', el.value)
        } catch {}
      }
    },
    true
  )
  document.addEventListener('submit', captureLogin, true)
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') captureLogin()
    },
    true
  )
  document.addEventListener(
    'click',
    (e) => {
      if (e.target.closest && e.target.closest('button, input[type=submit], [role=button]')) setTimeout(captureLogin, 0)
    },
    true
  )
})
