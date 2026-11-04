// Runs in every page of every space before the site's own scripts.
// This browser can't show the passkey / security-key prompt (Touch ID, phone, USB key),
// so sites like Google would hang on "Complete sign-in using your passkey".
// Hiding passkey support makes them fall back to password + normal 2-step verification.
const { contextBridge, webFrame } = require('electron')
// WhatsApp helper buttons (Remind me, Quick replies, Save contact): shown or hidden with one toggle.
var waTools = { open: false }
var msRoots = []
try { waTools.open = localStorage.getItem('__ms_wa_tools') === 'open' } catch {}

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

// ---------------------------------------------------------------- WhatsApp: save the person to Contacts
// Adds a "Save contact" button on web.whatsapp.com. It reads the open conversation (their messages,
// the phone number) and pre-fills name, phone, email and address; you check it and press Save.
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  const FIELDS = [
    ['first', 'Name'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['company', 'Company'],
    ['street', 'Street'],
    ['city', 'City'],
    ['state', 'State'],
    ['zip', 'ZIP'],
    ['note', 'Note'],
  ]
  let host, root
  const fmtPhone = (d) => (d.length === 11 && d[0] === '1' ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : d ? '+' + d : '')
  function readChat() {
    const main = document.querySelector('#main')
    if (!main) return null
    const head = main.querySelector('header')
    const title = ((head && (head.querySelector('span[dir="auto"]') || head.querySelector('span[title]'))) || {}).textContent || ''
    let phone = ''
    for (const r of main.querySelectorAll('[data-id]')) {
      const m = (r.getAttribute('data-id') || '').match(/^(?:false|true)_(\d{6,15})@c\.us/)
      if (m) {
        phone = m[1]
        break
      }
    }
    // Their messages: WhatsApp marks them "message-in" (older versions: data-id "false_…").
    const textOf = (el) => {
      const parts = [...el.querySelectorAll('[data-pre-plain-text], .selectable-text, .copyable-text')]
      // keep only the outermost matches so text isn't counted twice
      const outer = parts.filter((p) => !parts.some((q) => q !== p && q.contains(p)))
      let t = outer.map((p) => p.innerText).join('\n').trim()
      if (!t) t = el.innerText.replace(/\b\d{1,2}:\d{2}\s?(?:AM|PM)?\s*$/i, '').trim()
      return t
    }
    let rows = [...main.querySelectorAll('.message-in')]
    if (!rows.length) rows = [...main.querySelectorAll('[data-id^="false_"]')]
    rows = rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)))
    const incoming = rows.map(textOf).filter(Boolean)
    // Last resort: everything in the conversation.
    if (!incoming.length) {
      const pane = main.querySelector('[role="application"]') || main
      incoming.push(...pane.innerText.split(/\n+/).map((x) => x.trim()).filter((x) => x && !/^\d{1,2}:\d{2}\s?(?:AM|PM)?$/i.test(x)))
    }
    const titleDigits = title.replace(/[^\d]/g, '')
    if (!phone && /^\+?[\d\s()-]{7,}$/.test(title.trim())) phone = titleDigits
    // de-dupe nested matches, newest first
    return { title: title.trim(), phone, texts: [...new Set(incoming)].reverse().slice(0, 300) }
  }
  function ensureUi() {
    if (host && document.body.contains(host)) return
    host = document.createElement('div')
    host.id = '__ms_wa_contact'
    root = host.attachShadow({ mode: 'closed' })
    msWire(root)
    root.innerHTML = `<style>
      .btn{position:fixed;right:24px;bottom:128px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font:500 13px -apple-system,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
      .btn:hover{background:#f0f2f5}
      .bg{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
      .card{background:#fff;border-radius:12px;padding:20px 22px;width:400px;max-height:90vh;overflow:auto;font:13px -apple-system,system-ui,sans-serif;color:#111b21;box-shadow:0 10px 40px rgba(0,0,0,.3)}
      h3{margin:0 0 4px;font-size:16px} p{margin:0 0 12px;color:#667781}
      label{display:block;margin:8px 0 3px;color:#667781;font-size:12px}
      input,textarea{width:100%;box-sizing:border-box;border:1px solid #d1d7db;border-radius:8px;padding:7px 9px;font:13px -apple-system,system-ui,sans-serif}
      .row{display:flex;gap:8px}.row>div{flex:1}
      .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      .actions button{border:0;border-radius:8px;padding:8px 14px;font:500 13px -apple-system,system-ui,sans-serif;cursor:pointer}
      .save{background:#00a884;color:#fff}.cancel{background:#f0f2f5}
      .msg{margin-top:10px;color:#00a884}.err{color:#d93025}
      .jt{border:1px solid #e9edef;background:#f7f8fa;border-radius:10px;padding:8px 10px;margin-top:12px}
      .jt label.ck{display:flex;align-items:center;gap:8px;margin:0;color:#111b21;font-size:13px;cursor:pointer}
      .jt label.ck input{width:auto}
      .jt .org{color:#667781;font-size:12px}
      .jt p{margin:8px 0 6px;font-size:12px}
      .jt .r{display:flex;gap:6px}.jt .r button{border:0;border-radius:8px;padding:0 12px;background:#00a884;color:#fff;cursor:pointer}
      .jt .jm{font-size:12px;margin-top:6px;color:#667781}
      .done a{color:#00a884;cursor:pointer;text-decoration:underline;margin-left:6px}
      [hidden]{display:none!important}
    </style>
    <button class="btn" hidden>👤 Save contact</button>
    <div class="bg" hidden><form class="card">
      <h3>Save to Contacts</h3><p>Filled in from this conversation. Check it, then Save (goes to iCloud and your iPhone).</p>
      <div id="f"></div>
      <div class="jt">
        <label class="ck"><input type="checkbox" class="jton"/> Also add to JobTread <span class="org"></span></label>
        <div class="jtc" hidden>
          <p>Connect once: in JobTread open <b>app.jobtread.com/grants</b>, create a grant key, copy it and paste it here.</p>
          <div class="r"><input class="jtkey" placeholder="Paste JobTread grant key" autocomplete="off"/><button type="button" class="mspaste" data-for=".jtkey">Paste</button><button type="button" class="jtgo">Connect</button></div>
          <div class="jm"></div>
        </div>
      </div>
      <div class="msg" hidden></div>
      <div class="actions"><button type="button" class="cancel">Cancel</button><button type="submit" class="save">Save</button></div>
    </form></div>`
    const f = root.querySelector('#f')
    const inp = (k, l) => (k === 'note' ? `<label>${l}</label><textarea name="${k}" rows="2"></textarea>` : `<label>${l}</label><input name="${k}" />`)
    f.innerHTML =
      FIELDS.filter(([k]) => !['city', 'state', 'zip'].includes(k) && k !== 'note').map(([k, l]) => inp(k, l)).join('') +
      `<div class="row"><div>${inp('city', 'City')}</div><div style="flex:.5">${inp('state', 'State')}</div><div style="flex:.7">${inp('zip', 'ZIP')}</div></div>` +
      inp('note', 'Note')
    const bg = root.querySelector('.bg')
    const msg = root.querySelector('.msg')
    const form = root.querySelector('form')
    const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
    let jt = { connected: false, on: true, org: '' }
    const jtOn = root.querySelector('.jton')
    const jtShow = () => {
      jtOn.checked = jt.connected && jt.on
      root.querySelector('.org').textContent = jt.connected && jt.org ? `(${jt.org})` : jt.connected ? '' : '(not connected)'
      root.querySelector('.jtc').hidden = jt.connected || !jtOn.checked
    }
    const jtRefresh = async () => {
      try { jt = await ipcRenderer.invoke('jt:status') } catch {}
      root.querySelector('.jm').textContent = ''
      jtShow()
    }
    jtOn.addEventListener('change', async () => {
      if (jt.connected) {
        try { jt = await ipcRenderer.invoke('jt:set-on', jtOn.checked) } catch {}
      }
      root.querySelector('.jtc').hidden = jt.connected || !jtOn.checked
    })
    root.querySelector('.jtgo').addEventListener('click', async () => {
      const k = root.querySelector('.jtkey').value.trim()
      const jm = root.querySelector('.jm')
      if (!k) return
      jm.className = 'jm'
      jm.textContent = 'Connecting…'
      try {
        jt = await ipcRenderer.invoke('jt:set-key', k)
        root.querySelector('.jtkey').value = ''
        jtShow()
        jtOn.checked = true
      } catch (err) {
        jm.className = 'jm err'
        jm.textContent = errText(err)
      }
    })
    root.querySelector('.btn').addEventListener('click', async () => {
      const chat = readChat()
      if (!chat) return
      let parsed = {}
      try {
        parsed = (await ipcRenderer.invoke('wa:parse-contact', chat.texts)) || {}
      } catch {}
      const site = ((chat.texts.join(' ').match(/\b(?:https?:\/\/)?(?:www\.)[^\s,]+/i) || [])[0] || '').replace(/[.)]+$/, '')
      const titleIsPhone = !chat.title || /^\+?[\d\s()-]{7,}$/.test(chat.title)
      const name = [parsed.first, parsed.last].filter(Boolean).join(' ') || (titleIsPhone ? '' : chat.title)
      const vals = { ...parsed, first: name, phone: fmtPhone(chat.phone), company: '', note: ['Saved from WhatsApp', site].filter(Boolean).join(' · ') }
      for (const [k] of FIELDS) form.elements[k].value = vals[k] || ''
      jtRefresh()
      msg.hidden = true
      bg.hidden = false
      form.elements.first.focus()
    })
    const close = () => (bg.hidden = true)
    root.querySelector('.cancel').addEventListener('click', close)
    bg.addEventListener('click', (e) => e.target === bg && close())
    form.addEventListener('keydown', (e) => e.key === 'Escape' && close())
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const c = {}
      for (const [k] of FIELDS) c[k] = form.elements[k].value.trim()
      c.last = '' // whole name goes in the first-name field, like in iMessage
      msg.hidden = false
      msg.className = 'msg'
      msg.textContent = 'Saving…'
      try {
        await ipcRenderer.invoke('wa:add-contact', c)
        msg.textContent = '✓ Saved to Contacts'
      } catch (err) {
        msg.className = 'msg err'
        msg.textContent = errText(err)
        if (!(jtOn.checked && jt.connected)) return
      }
      if (jtOn.checked && jt.connected) {
        const line = document.createElement('div')
        line.className = 'msg done'
        line.textContent = 'Adding to JobTread…'
        msg.after(line)
        try {
          const r = await ipcRenderer.invoke('jt:add', c)
          line.textContent = r.existing ? '✓ Already a customer in JobTread' : '✓ Added to JobTread'
          const a = document.createElement('a')
          a.textContent = 'Open'
          a.addEventListener('click', () => ipcRenderer.send('jt:open', r.url))
          line.appendChild(a)
          setTimeout(() => { line.remove(); close() }, 4000)
        } catch (err) {
          line.className = 'msg err'
          line.textContent = 'JobTread: ' + errText(err)
        }
        return
      }
      if (msg.className === 'msg') setTimeout(close, 1200)
    })
    document.body.appendChild(host)
  }
  setInterval(() => {
    if (!document.body) return
    ensureUi()
    const show = !!document.querySelector('#main header')
    root.querySelector('.btn').hidden = !show || !waTools.open
  }, 1000)
}

// ---------------------------------------------------------------- WhatsApp: unread chats for the "Unread" view
// Reads the chat list (name, last message, unread count) and reports it to the browser.
// The browser can also ask this page to open a chat by name.
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  const UNREAD_RE = /unread|não lida|nao lida|no leíd|no leid/i
  const isGreen = (el) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).backgroundColor || '')
    return m && +m[2] > 140 && +m[2] > +m[1] + 60 && +m[2] > +m[3] + 20
  }
  const rowsOf = () => {
    const pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]') || document.querySelector('[aria-label="Lista de conversas"]')
    if (!pane) return []
    const rows = pane.querySelectorAll('[role="listitem"], [role="row"]')
    return [...rows].filter((r) => !r.parentElement.closest('[role="listitem"], [role="row"]'))
  }
  const nameOf = (row) => {
    const t = row.querySelector('span[title][dir="auto"]') || row.querySelector('span[title]')
    return t ? (t.getAttribute('title') || t.textContent || '').trim() : ''
  }
  function readUnread() {
    const out = []
    for (const row of rowsOf()) {
      const name = nameOf(row)
      if (!name) continue
      let count = 0
      let found = false
      for (const el of row.querySelectorAll('[aria-label]')) {
        const label = el.getAttribute('aria-label') || ''
        if (UNREAD_RE.test(label)) {
          found = true
          count = parseInt((/\d+/.exec(label) || /\d+/.exec(el.textContent || '') || ['0'])[0], 10) || count
        }
      }
      if (!found) {
        for (const el of row.querySelectorAll('span')) {
          if (/^\d{1,3}$/.test((el.textContent || '').trim()) && el.children.length === 0 && isGreen(el.parentElement || el)) {
            found = true
            count = parseInt(el.textContent, 10)
          }
        }
      }
      if (!found) continue
      const titled = [...row.querySelectorAll('span[title]')].map((s) => (s.getAttribute('title') || '').trim()).filter((t) => t && t !== name)
      const preview = titled[titled.length - 1] || ''
      const time = ([...row.querySelectorAll('div, span')].map((e) => (e.children.length ? '' : (e.textContent || '').trim())).find((t) => /^(\d{1,2}:\d{2}(\s?[AP]M)?|yesterday|ontem|today|hoje|\d{1,2}\/\d{1,2}\/\d{2,4}|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda|terça|quarta|quinta|sexta|sábado|domingo)/i.test(t)) || '')
      out.push({ name: name.slice(0, 120), preview: preview.slice(0, 200), count, time: time.slice(0, 20) })
    }
    return out.slice(0, 50)
  }
  let lastSent = ''
  setInterval(() => {
    let list = []
    try { list = readUnread() } catch {}
    const sig = JSON.stringify(list)
    if (sig !== lastSent) {
      lastSent = sig
      ipcRenderer.send('wa:unread', list)
    }
  }, 3000)
  ipcRenderer.on('wa:open-chat', async (_e, name) => {
    const want = String(name || '')
    const click = (row) => {
      const target = row.querySelector('[tabindex]') || row
      for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    }
    for (let i = 0; i < 10; i++) {
      const row = rowsOf().find((r) => nameOf(r) === want)
      if (row) return click(row)
      await new Promise((r) => setTimeout(r, 500))
    }
  })
  // Reply typed on the Unread page: open the chat, type the text, press Send.
  ipcRenderer.on('wa:send-chat', async (_e, rid, name, text) => {
    const reply = (res) => ipcRenderer.send('wa:send-result', rid, res)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const want = String(name || '')
    const headName = () => {
      const h = document.querySelector('#main header')
      const t = h && (h.querySelector('span[title][dir="auto"]') || h.querySelector('span[dir="auto"]') || h.querySelector('span[title]'))
      return t ? (t.getAttribute('title') || t.textContent || '').trim() : ''
    }
    try {
      if (headName() !== want) {
        let row = null
        for (let i = 0; i < 10 && !row; i++) { row = rowsOf().find((r) => nameOf(r) === want); if (!row) await sleep(400) }
        if (!row) return reply({ ok: false, error: `Could not find "${want}" in your WhatsApp chat list.` })
        const target = row.querySelector('[tabindex]') || row
        for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        for (let i = 0; i < 20 && headName() !== want; i++) await sleep(250)
        if (headName() !== want) return reply({ ok: false, error: 'WhatsApp did not open that chat. Open it and send from there.' })
      }
      let box = null
      for (let i = 0; i < 20 && !box; i++) { box = document.querySelector('#main footer div[contenteditable="true"]'); if (!box) await sleep(250) }
      if (!box) return reply({ ok: false, error: 'Could not find the WhatsApp message box.' })
      box.focus()
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(box)
      sel.removeAllRanges()
      sel.addRange(r)
      if (!document.execCommand('insertText', false, String(text))) box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: String(text), bubbles: true, cancelable: true }))
      await sleep(300)
      const btn = document.querySelector('#main footer button[aria-label="Send"], #main footer button[aria-label="Enviar"], #main footer [data-icon="send"], #main footer [data-icon="wds-ic-send-filled"]')
      if (btn) (btn.closest('button') || btn).click()
      else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      for (let i = 0; i < 12 && (box.textContent || '').trim(); i++) await sleep(250)
      if ((box.textContent || '').trim()) return reply({ ok: false, error: 'The text is typed in WhatsApp but was not sent. Open WhatsApp and press Enter.' })
      reply({ ok: true })
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) })
    }
  })
}

// ---------------------------------------------------------------- WhatsApp: quick replies
// A "⚡ Quick replies" button above "Save contact". Click a reply to put it in the message box
// ({name} becomes the person's first name). The same list is used in the iMessage app.
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  let qhost, qroot, list = []
  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const chatName = () => {
    const head = document.querySelector('#main header')
    const t = ((head && (head.querySelector('span[dir="auto"]') || head.querySelector('span[title]'))) || {}).textContent || ''
    if (!t || /^[+\d(][\d\s()+\-.]*$/.test(t.trim())) return ''
    return t.trim().split(/[\s,]+/)[0]
  }
  const fill = (text) => {
    const first = chatName()
    return String(text).replace(/\s*\{name\}/g, first ? ' ' + first : '').replace(/^\s+/, '').replace(/\s+([,!.?])/g, '$1')
  }
  const load = async () => {
    try { list = (await ipcRenderer.invoke('qr:list')) || [] } catch {}
  }
  ipcRenderer.on('qr:changed', (_e, l) => { list = l || []; if (qroot && !qroot.querySelector('.pop').hidden && qroot.querySelector('.ed').hidden) renderList() })
  function insert(text) {
    const box = document.querySelector('#main footer div[contenteditable="true"]') || document.querySelector('footer div[contenteditable="true"]')
    if (!box) return
    box.focus()
    const sel = window.getSelection()
    const r = document.createRange()
    r.selectNodeContents(box)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
    if (!document.execCommand('insertText', false, text)) {
      box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }))
    }
  }
  function renderList() {
    const q = qroot.querySelector('.q').value.trim().toLowerCase()
    const items = list.map((r, i) => [r, i]).filter(([r]) => !q || (r.title + ' ' + r.text).toLowerCase().includes(q))
    qroot.querySelector('.list').innerHTML = items.length
      ? items.map(([r, i]) => `<button class="it" data-i="${i}"><b>${escH(r.title || r.text.slice(0, 30))}</b><span>${escH(fill(r.text))}</span></button>`).join('')
      : '<div class="empty">No quick replies yet. Click Edit to add one.</div>'
  }
  function renderEditor() {
    const ed = qroot.querySelector('.ed')
    ed.innerHTML = '<div class="tip">Write {name} where the person\'s first name should go.</div>' +
      list.map((r) => `<div class="row"><input class="t" placeholder="Short name, e.g. On my way" value="${escH(r.title)}"/><textarea class="x" rows="2" placeholder="Message">${escH(r.text)}</textarea><button class="del">Delete</button></div>`).join('') +
      '<div class="acts"><button class="add">+ Add quick reply</button><button class="save">Save</button></div>'
  }
  const collect = () => [...qroot.querySelectorAll('.ed .row')].map((d) => ({ title: d.querySelector('.t').value.trim(), text: d.querySelector('.x').value }))
  function showMode(edit) {
    qroot.querySelector('.ed').hidden = !edit
    qroot.querySelector('.list').hidden = edit
    qroot.querySelector('.q').hidden = edit
    qroot.querySelector('.edit').textContent = edit ? 'Done' : 'Edit'
    if (edit) renderEditor()
    else renderList()
  }
  function ensureQr() {
    if (qhost && document.body.contains(qhost)) return
    qhost = document.createElement('div')
    qhost.id = '__ms_wa_quick'
    qroot = qhost.attachShadow({ mode: 'closed' })
    msWire(qroot)
    qroot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      .btn{position:fixed;right:24px;bottom:172px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
      .btn:hover{background:#f0f2f5}
      .pop{position:fixed;right:24px;bottom:216px;z-index:2147483647;width:420px;max-height:60vh;display:flex;flex-direction:column;background:#fff;border:1px solid #d1d7db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:10px;color:#111b21;font-size:13px}
      .head{display:flex;justify-content:space-between;align-items:center;padding:2px 4px 8px}
      button{cursor:pointer;font-size:12.5px}
      .head button,.acts button{border:1px solid #d1d7db;background:#fff;border-radius:8px;padding:4px 10px}
      .hb{display:flex;gap:6px}
      .aik{border:1px solid #e9edef;border-radius:10px;padding:8px;margin-bottom:8px}
      .r2{display:flex;gap:6px}.r2 input{flex:1;border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font-size:13px}.r2 button{border:0;border-radius:8px;background:#00a884;color:#fff;padding:0 12px}
      .q{border:1px solid #d1d7db;border-radius:8px;padding:7px 9px;font-size:13px;margin-bottom:6px;outline:none}
      .list,.ed{overflow-y:auto;min-height:0}
      .it{display:block;width:100%;text-align:left;border:0;background:none;border-radius:8px;padding:8px 10px}
      .it:hover{background:#f0f2f5}
      .it b{display:block;font-size:13px}.it span{display:block;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .empty,.tip{color:#667781;padding:6px 4px 10px;font-size:12px}
      .row{border:1px solid #e9edef;border-radius:10px;padding:8px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}
      .row input,.row textarea{border:1px solid #d1d7db;border-radius:8px;padding:6px 8px;font-size:13px;resize:vertical}
      .del{align-self:flex-end;border:0;background:none;color:#d93025}
      .acts{display:flex;justify-content:space-between;padding-top:4px}
      .acts .save{background:#00a884;color:#fff;border-color:#00a884}
      [hidden]{display:none!important}
    </style>
    <button class="btn" hidden>⚡ Quick replies</button>
    <div class="pop" hidden>
      <div class="head"><b>Quick replies</b><span class="hb"><button class="ai">✨ Suggest reply</button><button class="mic" title="Dictate">🎤</button><button class="edit">Edit</button></span></div>
      <div class="aik" hidden><div class="tip">Paste a Claude API key once (console.anthropic.com → API Keys).</div><div class="r2"><input class="aikey" placeholder="sk-ant-…"/><button class="mspaste" data-for=".aikey">Paste</button><button class="aisave">Save</button></div><div class="aim tip"></div></div>
      <input class="q" placeholder="Search quick replies"/>
      <div class="list"></div>
      <div class="ed" hidden></div>
    </div>`
    const pop = qroot.querySelector('.pop')
    qroot.querySelector('.btn').addEventListener('click', async () => {
      if (!pop.hidden) return (pop.hidden = true)
      await load()
      qroot.querySelector('.q').value = ''
      showMode(false)
      pop.hidden = false
      qroot.querySelector('.q').focus()
    })
    qroot.querySelector('.q').addEventListener('input', renderList)
    const errT2 = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
    const readConvo = () => {
      const main = document.querySelector('#main')
      if (!main) return []
      let rows = [...main.querySelectorAll('.message-in, .message-out')]
      rows = rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)))
      return rows.map((r) => {
        const t = r.querySelector('[data-pre-plain-text]') || r.querySelector('.copyable-text') || r.querySelector('.selectable-text')
        return { fromMe: r.classList.contains('message-out'), text: ((t && t.innerText) || '').trim() }
      }).filter((m) => m.text).slice(-25)
    }
    const aiBtn = qroot.querySelector('.ai')
    const suggest = async () => {
      aiBtn.textContent = '✨ Thinking…'
      aiBtn.disabled = true
      try {
        const box = document.querySelector('#main footer div[contenteditable="true"]')
        const draft = box ? box.innerText.trim() : ''
        const reply = await ipcRenderer.invoke('ai:suggest', { name: chatName() || '', messages: readConvo(), draft })
        pop.hidden = true
        if (box && draft) {
          box.focus()
          document.execCommand('selectAll')
        }
        insert(reply)
      } catch (err) {
        const m = errT2(err)
        if (/NO_KEY/.test(m)) qroot.querySelector('.aik').hidden = false
        else qroot.querySelector('.aim').textContent = m, (qroot.querySelector('.aik').hidden = false)
      } finally {
        aiBtn.textContent = '✨ Suggest reply'
        aiBtn.disabled = false
      }
    }
    aiBtn.addEventListener('click', suggest)
    qroot.querySelector('.aisave').addEventListener('click', async () => {
      const k = qroot.querySelector('.aikey').value.trim()
      if (!k) return
      qroot.querySelector('.aim').textContent = 'Checking…'
      try {
        await ipcRenderer.invoke('ai:set-key', k)
        qroot.querySelector('.aikey').value = ''
        qroot.querySelector('.aik').hidden = true
        qroot.querySelector('.aim').textContent = ''
        suggest()
      } catch (err) {
        qroot.querySelector('.aim').textContent = errT2(err)
      }
    })
    qroot.querySelector('.mic').addEventListener('click', async () => {
      pop.hidden = true
      const box = document.querySelector('#main footer div[contenteditable="true"]')
      if (box) box.focus()
      await ipcRenderer.invoke('dictate').catch(() => false)
    })
    qroot.querySelector('.q').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') pop.hidden = true
      if (e.key === 'Enter') qroot.querySelector('.it')?.click()
    })
    qroot.querySelector('.list').addEventListener('click', (e) => {
      const b = e.target.closest('.it')
      if (!b) return
      pop.hidden = true
      insert(fill(list[+b.dataset.i].text))
    })
    const saveEd = async () => {
      try { list = (await ipcRenderer.invoke('qr:set', collect())) || [] } catch {}
      showMode(false)
    }
    qroot.querySelector('.edit').addEventListener('click', () => (qroot.querySelector('.ed').hidden ? showMode(true) : saveEd()))
    qroot.querySelector('.ed').addEventListener('click', async (e) => {
      const t = e.target
      if (t.classList.contains('del')) t.closest('.row').remove()
      else if (t.classList.contains('add')) {
        list = collect().concat([{ title: '', text: '' }])
        renderEditor()
        const all = qroot.querySelectorAll('.ed .t')
        all[all.length - 1]?.focus()
      } else if (t.classList.contains('save')) saveEd()
    })
    // WhatsApp's own shortcuts shouldn't fire while typing in our boxes
    for (const ev of ['keydown', 'keypress', 'keyup']) qroot.addEventListener(ev, (e) => e.stopPropagation())
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !e.composedPath().includes(qhost) && qroot.querySelector('.ed').hidden) pop.hidden = true
    }, true)
    document.body.appendChild(qhost)
  }
  setInterval(() => {
    if (!document.body) return
    ensureQr()
    qroot.querySelector('.btn').hidden = !document.querySelector('#main footer') || !waTools.open
    if (!waTools.open) qroot.querySelector('.pop').hidden = true
  }, 1000)
}

// ---------------------------------------------------------------- WhatsApp: remind me to reply
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  let rhost, rroot
  const chatTitle = () => {
    const head = document.querySelector('#main header')
    return (((head && (head.querySelector('span[dir="auto"]') || head.querySelector('span[title]'))) || {}).textContent || '').trim()
  }
  const at = (w) => {
    const d = new Date()
    if (w === '1h') return Date.now() + 3600e3
    if (w === '3h') return Date.now() + 3 * 3600e3
    d.setDate(d.getDate() + (w === 'mon9' ? ((8 - d.getDay()) % 7) || 7 : 1))
    d.setHours(9, 0, 0, 0)
    return +d
  }
  function ensureR() {
    if (rhost && document.body.contains(rhost)) return
    rhost = document.createElement('div')
    rhost.id = '__ms_wa_remind'
    rroot = rhost.attachShadow({ mode: 'closed' })
    msWire(rroot)
    rroot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      .btn{position:fixed;right:24px;bottom:216px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
      .btn:hover{background:#f0f2f5}
      .menu{position:fixed;right:24px;bottom:260px;z-index:2147483647;width:220px;background:#fff;border:1px solid #d1d7db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:6px;font-size:13px;color:#111b21}
      .menu b{display:block;font-size:12px;color:#667781;padding:6px 8px 4px}
      .menu button{display:block;width:100%;text-align:left;border:0;background:none;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:13px}
      .menu button:hover{background:#f0f2f5}
      .ok{position:fixed;right:24px;bottom:260px;z-index:2147483647;background:#111b21;color:#fff;border-radius:10px;padding:8px 12px;font-size:13px}
      [hidden]{display:none!important}
    </style>
    <button class="btn" hidden>⏰ Remind me</button>
    <div class="menu" hidden><b>Remind me to reply</b>
      <button data-w="1h">In 1 hour</button><button data-w="3h">In 3 hours</button>
      <button data-w="tom9">Tomorrow 9:00 AM</button><button data-w="mon9">Monday 9:00 AM</button></div>
    <div class="ok" hidden></div>`
    const menu = rroot.querySelector('.menu')
    const ok = rroot.querySelector('.ok')
    rroot.querySelector('.btn').addEventListener('click', () => (menu.hidden = !menu.hidden))
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-w]')
      if (!b) return
      menu.hidden = true
      const name = chatTitle()
      const when = at(b.dataset.w)
      try {
        await ipcRenderer.invoke('timers:remind', { kind: 'wa', name, title: name, at: when })
        ok.textContent = `⏰ I'll remind you ${b.textContent.toLowerCase()}`
      } catch {
        ok.textContent = 'Could not set the reminder'
      }
      ok.hidden = false
      setTimeout(() => (ok.hidden = true), 2500)
    })
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !e.composedPath().includes(rhost)) menu.hidden = true
    }, true)
    document.body.appendChild(rhost)
  }
  setInterval(() => {
    if (!document.body) return
    ensureR()
    rroot.querySelector('.btn').hidden = !document.querySelector('#main footer') || !waTools.open
    if (!waTools.open) rroot.querySelector('.menu').hidden = true
  }, 1000)
}

let waJtPick = null, waJtUpload = null // set below on WhatsApp; used by the 🔨 JobTread button for drops
// ---------------------------------------------------------------- WhatsApp: send a picture to JobTread
// Right-click a picture → "Send picture to JobTread…". Finds the customer by this chat's phone/name.
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  const esc2 = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const errT = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
  let phost, proot
  function chatInfo() {
    const main = document.querySelector('#main')
    const head = main && main.querySelector('header')
    const title = (((head && (head.querySelector('span[dir="auto"]') || head.querySelector('span[title]'))) || {}).textContent || '').trim()
    let phone = ''
    const idEl = main && main.querySelector('[data-id*="@c.us"]')
    const m = idEl && /_(\d+)@c\.us/.exec(idEl.getAttribute('data-id'))
    if (m) phone = m[1]
    if (!phone && /^\+?[\d\s()-]{7,}$/.test(title)) phone = title.replace(/\D/g, '')
    return { title, phone }
  }
  function ensureP() {
    if (phost && document.body.contains(phost)) return
    phost = document.createElement('div')
    phost.id = '__ms_wa_photo'
    proot = phost.attachShadow({ mode: 'closed' })
    msWire(proot)
    proot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      .bg{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}
      .card{background:#fff;border-radius:12px;padding:20px 22px;width:380px;font-size:13px;color:#111b21;box-shadow:0 10px 40px rgba(0,0,0,.3)}
      h3{margin:0 0 4px;font-size:16px} p{margin:0 0 12px;color:#667781}
      img{max-width:100%;max-height:160px;border-radius:8px;display:block;margin:0 auto 10px}
      select{width:100%;border:1px solid #d1d7db;border-radius:8px;padding:7px;font-size:13px}
      .m{min-height:18px;margin:8px 0;color:#667781}.m.err{color:#d93025}
      .h{font-size:12.5px;color:#2f5297;background:#eef3fd;border-radius:8px;padding:6px 9px;margin-top:8px}
      .f{white-space:pre-line;font-size:13px;margin:0 0 10px;word-break:break-all}.f:empty{display:none}
      .a{display:flex;justify-content:flex-end;gap:8px}
      .a button{border:0;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
      .go{background:#00a884;color:#fff}.no{background:#f0f2f5}
      [hidden]{display:none!important}
    </style>
    <div class="bg" hidden><div class="card">
      <h3>Send picture to JobTread</h3><p>Saved in the Photos folder of the job you pick.</p>
      <img alt=""/><div class="f"></div><select></select><div class="h" hidden></div><div class="m"></div>
      <div class="a"><button class="no">Cancel</button><button class="go">Send</button></div>
    </div></div>`
    proot.querySelector('.no').addEventListener('click', () => (proot.querySelector('.bg').hidden = true))
    for (const ev of ['keydown', 'keypress', 'keyup']) proot.addEventListener(ev, (e) => e.stopPropagation())
    document.body.appendChild(phost)
  }
  // item: { src } (a picture/video in the chat), { files } (dropped from Finder) or { download } (a document just saved).
  // The job linked to this chat (or the customer's only open job) is chosen for you.
  async function pick(item) {
    ensureP()
    const bg = proot.querySelector('.bg')
    const sel = proot.querySelector('select')
    const msg = proot.querySelector('.m')
    const go = proot.querySelector('.go')
    const img = proot.querySelector('img')
    const files = item.files || []
    const isImg = item.src ? !/video/i.test(item.mime || '') : files.length ? files.every((f) => /^image\//.test(f.type)) : /^image\//.test(item.download.mime)
    proot.querySelector('h3').textContent = item.download ? 'Send this file to JobTread?' : files.length > 1 ? `Send ${files.length} files to JobTread` : `Send ${item.src ? (item.mime && /video/.test(item.mime) ? 'video' : 'picture') : isImg ? 'picture' : 'file'} to JobTread`
    proot.querySelector('p').textContent = item.download ? `“${item.download.name}” was saved to your Mac. File it on the job too?` : `Saved in the ${isImg ? 'Photos' : 'Files'} folder of the job you pick.`
    img.hidden = !(item.src && isImg) && !(files.length === 1 && isImg)
    if (item.src) img.src = item.src
    else if (files.length === 1 && isImg) img.src = URL.createObjectURL(files[0])
    proot.querySelector('.f').textContent = item.download ? '📎 ' + item.download.name : files.length && !isImg ? files.map((f) => '📎 ' + f.name).join('\n') : ''
    proot.querySelector('.no').textContent = item.download ? 'Not now' : 'Cancel'
    sel.innerHTML = ''
    proot.querySelector('.h').hidden = true
    msg.className = 'm'
    msg.textContent = 'Looking up the customer…'
    go.disabled = true
    bg.hidden = false
    const info = chatInfo()
    let d = null, L = null
    try {
      d = await ipcRenderer.invoke('jt:find', { phone: info.phone, name: /^\+?[\d\s()-]{7,}$/.test(info.title) ? '' : info.title })
      L = info.title ? await ipcRenderer.invoke('jt:link-get', 'wa:' + info.title).catch(() => null) : null
    } catch (err) {
      msg.className = 'm err'
      msg.textContent = errT(err)
      return
    }
    const jobs = d ? [...d.jobs.filter((j) => !j.closed), ...d.jobs.filter((j) => j.closed)] : []
    if (L && !jobs.some((j) => j.id === L.jobId)) jobs.unshift({ id: L.jobId, name: L.jobName, number: L.jobNumber })
    if (!d && !L) {
      msg.textContent = 'This chat is not a JobTread customer yet. Use 👤 Save contact with "Also add to JobTread" first, or link a job in ⚡ Tools → 🔨 JobTread.'
      return
    }
    sel.innerHTML = jobs.map((j) => `<option value="job:${esc2(j.id)}">Job ${j.number ? '#' + esc2(j.number) + ' · ' : ''}${esc2(j.name)}${j.closed ? ' (closed)' : ''}</option>`).join('') +
      (d ? `<option value="account:${esc2(d.id)}">Customer files · ${esc2(d.name)}</option>` : '')
    const open = jobs.filter((j) => !j.closed)
    const sug = L ? { id: L.jobId, why: `this chat is linked to ${L.jobNumber ? '#' + L.jobNumber + ' ' : ''}${L.jobName}` } : open.length === 1 ? { id: open[0].id, why: `the only open job for ${d.name}` } : null
    if (sug) {
      sel.value = 'job:' + sug.id
      const o = sel.querySelector(`option[value="job:${CSS.escape(sug.id)}"]`)
      if (o) o.textContent = '★ ' + o.textContent
      proot.querySelector('.h').textContent = '★ Suggested: ' + sug.why
      proot.querySelector('.h').hidden = false
    }
    msg.textContent = ''
    go.disabled = false
    go.onclick = async () => {
      go.disabled = true
      msg.className = 'm'
      msg.textContent = 'Sending…'
      try {
        const [targetType, targetId] = sel.value.split(':')
        await upload({ targetType, targetId }, item, info.title)
        // remember the job for this chat, so the next drop on 🔨 goes straight there
        const j = jobs.find((x) => x.id === targetId)
        if (targetType === 'job' && j && info.title && (!L || L.jobId !== j.id))
          await ipcRenderer.invoke('jt:link-set', 'wa:' + info.title, { jobId: j.id, jobName: j.name, jobNumber: String(j.number || ''), status: j.status || '', accountId: (d && d.id) || '', auto: false }).catch(() => {})
        msg.textContent = '✓ Sent to JobTread'
        setTimeout(() => (bg.hidden = true), 1200)
      } catch (err) {
        msg.className = 'm err'
        msg.textContent = errT(err)
        go.disabled = false
      }
    }
  }
  async function upload(t, item, title) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    if (item.download) return ipcRenderer.invoke('jt:upload-download', t, item.download.id)
    if (item.files) {
      for (const f of item.files) await ipcRenderer.invoke('jt:upload-file', t, { name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })
      return
    }
    const blob = await (await fetch(item.src)).blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const mime = blob.type || (/video/.test(item.mime || '') ? 'video/mp4' : 'image/jpeg')
    const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov')
    return ipcRenderer.invoke('jt:upload-file', t, { name: `WhatsApp ${title ? title + ' ' : ''}${stamp}.${ext}`.slice(0, 120), mime, bytes })
  }
  waJtPick = pick
  waJtUpload = upload
  ipcRenderer.on('jt:photo', (_e, src) => {
    // a video's srcURL ends up here too; check what the element under the mouse was
    const isVid = !!document.querySelector(`video[src="${CSS.escape(src)}"]`)
    pick({ src, mime: isVid ? 'video/mp4' : 'image/jpeg' })
  })
  ipcRenderer.on('jt:downloaded', (_e, dl) => {
    if (!dl || !dl.id || !document.querySelector('#main footer')) return
    pick({ download: { id: String(dl.id), name: String(dl.name || 'File'), mime: String(dl.mime || '') } })
  })
}


// ---------------------------------------------------------------- WhatsApp: show / hide the helper buttons
if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  let thost, troot
  function ensureT() {
    if (thost && document.body.contains(thost)) return
    thost = document.createElement('div')
    thost.id = '__ms_wa_toggle'
    troot = thost.attachShadow({ mode: 'closed' })
    troot.innerHTML = `<style>
      .t{position:fixed;right:24px;bottom:84px;z-index:2147483646;height:36px;min-width:36px;padding:0 12px;border-radius:18px;background:#fff;color:#111b21;border:1px solid #d1d7db;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer;font:500 13px -apple-system,system-ui,sans-serif;display:flex;align-items:center;gap:6px}
      .t:hover{background:#f0f2f5}
      [hidden]{display:none!important}
    </style><button class="t" hidden></button>`
    troot.querySelector('.t').addEventListener('click', () => {
      waTools.open = !waTools.open
      try { localStorage.setItem('__ms_wa_tools', waTools.open ? 'open' : 'closed') } catch {}
      draw()
    })
    document.body.appendChild(thost)
  }
  function draw() {
    const t = troot.querySelector('.t')
    t.textContent = waTools.open ? '✕ Hide tools' : '⚡ Tools'
    t.title = waTools.open ? 'Hide JobTread, Remind me, Quick replies and Save contact' : 'Show JobTread, Remind me, Quick replies and Save contact'
  }
  setInterval(() => {
    if (!document.body) return
    ensureT()
    draw()
    troot.querySelector('.t').hidden = !document.querySelector('#main footer')
  }, 1000)
}

// ---------------------------------------------------------------- pasting into our own boxes on WhatsApp
// WhatsApp grabs paste and Cmd+V for its own message box, so the key boxes in our helpers never got
// the text. Our listeners are added before WhatsApp's, so they run first: we paste the text ourselves
// and stop WhatsApp from seeing the event. The "Paste" buttons read the clipboard directly as a backup.
;(() => {
  if (location.hostname !== 'web.whatsapp.com') return
  const ours = (e) => { const t = e.composedPath()[0]; return t && typeof t.id === 'string' && t.id.startsWith('__ms_wa_') ? t : null }
  const focusedBox = () => {
    for (const r of msRoots) { const a = r.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return a }
    return null
  }
  const insert = (el, text) => {
    if (!el || !text) return
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? el.value.length
    el.setRangeText(text.trim(), a, b, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  window.addEventListener('paste', (e) => {
    if (!ours(e)) return
    const el = focusedBox()
    e.stopImmediatePropagation()
    if (!el) return
    e.preventDefault()
    insert(el, e.clipboardData && e.clipboardData.getData('text/plain'))
  }, true)
  // Cmd+V (Ctrl+V): read the clipboard ourselves so WhatsApp can't swallow it.
  window.addEventListener('keydown', async (e) => {
    if (!ours(e) || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'v') return
    const el = focusedBox(); if (!el) return
    e.preventDefault(); e.stopImmediatePropagation()
    insert(el, await ipcRenderer.invoke('clip:text'))
  }, true)
})()

// Each helper's shadow root: remember it, and wire its "Paste" buttons (they read the clipboard directly).
function msWire(root) {
  msRoots.push(root)
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.mspaste')
    if (!btn) return
    e.preventDefault()
    const el = root.querySelector(btn.dataset.for)
    if (!el) return
    el.focus()
    const text = String((await ipcRenderer.invoke('clip:text')) || '').trim()
    if (text) { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })) }
  })
}

// ---------------------------------------------------------------- Gmail ↔ JobTread
// A "🔨 JobTread" button on an open email. The panel finds the sender in JobTread and lets you
// save the email to a job, send its attachments to the job, make a task, or add a new lead.
if (location.hostname === 'mail.google.com' && window.top === window) {
  let ghost = null, groot = null
  let gmState = { thread: '', sender: null, customer: undefined, jobs: [], jobId: '', open: false }
  const gesc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const gerr = (err) => String((err && err.message) || err).replace(/^.*Error: /, '')
  const vis = (el) => el && el.getClientRects().length > 0

  // what's on screen
  function openThread() {
    const subj = [...document.querySelectorAll('h2.hP')].find(vis)
    if (!subj) return null
    const msgs = [...document.querySelectorAll('div.adn')].filter(vis)
    const withBody = msgs.filter((m) => m.querySelector('div.a3s'))
    const last = withBody[withBody.length - 1] || msgs[msgs.length - 1]
    const me = (document.title.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0].toLowerCase()
    // sender: the newest message not sent by you
    let sender = null
    for (const m of [...msgs].reverse()) {
      const g = m.querySelector('.gD[email]')
      if (g && g.getAttribute('email').toLowerCase() !== me) { sender = { email: g.getAttribute('email'), name: g.getAttribute('name') || g.textContent.trim() }; break }
    }
    if (!sender) { const g = document.querySelector('.gD[email]'); if (g) sender = { email: g.getAttribute('email'), name: g.getAttribute('name') || g.textContent.trim() } }
    const bodyEl = last && last.querySelector('div.a3s')
    const body = bodyEl ? bodyEl.innerText.replace(/\n{3,}/g, '\n\n').trim() : ''
    const when = last && last.querySelector('.g3[title]') ? last.querySelector('.g3[title]').getAttribute('title') : ''
    return { id: location.hash + '|' + subj.textContent, subject: subj.textContent.trim(), sender, body, when, attachments: attachmentsOf(msgs) }
  }
  function attachmentsOf(msgs) {
    const out = new Map()
    for (const m of msgs) {
      for (const s of m.querySelectorAll('span[download_url]')) {
        const v = s.getAttribute('download_url') || ''
        const a = v.indexOf(':'), b = v.indexOf(':', a + 1)
        if (a < 0 || b < 0) continue
        const url = v.slice(b + 1)
        out.set(url, { mime: v.slice(0, a), name: v.slice(a + 1, b), url })
      }
      for (const a of m.querySelectorAll('a[href*="view=att"], a[href*="disp=safe"]')) {
        if (out.has(a.href)) continue
        const box = a.closest('.aZo, .aQH > span, [role="listitem"]') || a
        const name = (box.querySelector('.aV3') || {}).textContent || a.getAttribute('aria-label') || a.textContent.trim() || 'Attachment'
        if ([...out.values()].some((x) => x.name === name)) continue
        out.set(a.href, { mime: '', name: name.replace(/^Download attachment\s*/i, '').trim(), url: a.href })
      }
    }
    return [...out.values()].slice(0, 25)
  }
  // a phone number and address from the email (usually in the signature)
  function guessContact(text) {
    const phone = (text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/) || [''])[0]
    const csz = text.match(/([A-Z][A-Za-z .'-]{1,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/)
    const street = (text.match(/\b\d{2,6}[^\S\n]+(?:[NSEW]{1,2}[^\S\n]+)?[A-Za-z0-9 .'-]{2,40}[^\S\n](?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Cir|Circle|Pkwy|Hwy|Trl)\b\.?/i) || [''])[0]
    return { phone, street, city: csz ? csz[1].trim() : '', state: csz ? csz[2] : '', zip: csz ? csz[3] : '' }
  }

  function ensureG() {
    if (ghost && ghost.isConnected) return
    ghost = document.createElement('div')
    ghost.id = '__ms_gm_jt'
    groot = ghost.attachShadow({ mode: 'closed' })
    msWire(groot)
    groot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      [hidden]{display:none!important}
      .fab{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:0;border-radius:20px;padding:9px 15px;background:#3a5fa8;color:#fff;font-size:13.5px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer}
      .fab:hover{background:#2f4f8f}
      .pn{position:fixed;right:18px;bottom:70px;z-index:2147483000;width:350px;max-height:calc(100vh - 110px);overflow-y:auto;background:#fff;border:1px solid #e2d9cc;border-radius:16px;box-shadow:0 14px 40px rgba(0,0,0,.22);padding:14px;color:#2b2620;font-size:13px}
      h3{margin:0 0 2px;font-size:15px}
      .sub{color:#8a8075;font-size:12px;margin-bottom:10px;word-break:break-all}
      .sec{font-size:11px;font-weight:700;color:#8a8075;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px}
      .job{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:1px solid #ebe4d9;background:#fff;border-radius:10px;padding:7px 9px;margin-bottom:5px;cursor:pointer;font-size:12.5px}
      .job:hover{background:#f6f1ea}
      .job.on{border-color:#3a5fa8;background:#eef3fd}
      .job .st{margin-left:auto;color:#8a8075;font-size:11px;white-space:nowrap}
      .job .c{color:#8a8075;font-size:11px;display:block}
      input,select,textarea{width:100%;border:1px solid #e2d9cc;border-radius:8px;padding:7px 9px;font-size:12.5px;background:#fff;color:#2b2620}
      textarea{resize:vertical}
      .g2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
      .g3{display:grid;grid-template-columns:2fr 1fr 1fr;gap:6px}
      label{display:block;font-size:11.5px;color:#8a8075;margin:6px 0 0}
      .btn{border:1px solid #e2d9cc;background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;cursor:pointer;color:#2b2620}
      .btn:hover{background:#f6f1ea}
      .btn.pri{background:#f26b3a;border-color:#f26b3a;color:#fff;font-weight:600}
      .btn:disabled{opacity:.5;cursor:default}
      .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .att{display:flex;gap:7px;align-items:center;font-size:12.5px;margin:3px 0;word-break:break-all}
      .att input{width:auto}
      .msg{font-size:12px;margin-top:8px;color:#8a8075}
      .msg.err{color:#d03b40}.msg.ok{color:#2f9e5b}
      .muted{color:#8a8075;font-size:12.5px}
      .x{position:absolute;right:10px;top:8px;border:0;background:none;font-size:18px;color:#8a8075;cursor:pointer}
      .row{display:flex;gap:6px}
      .chk{display:flex;gap:6px;align-items:center;font-size:12px;color:#2b2620;margin-top:6px}.chk input{width:auto}
    </style>
    <button class="fab" hidden>🔨 JobTread</button>
    <div class="pn" hidden><button class="x" title="Close">×</button><div class="in"></div></div>`
    document.documentElement.appendChild(ghost)
    groot.querySelector('.fab').onclick = () => {
      gmState.open = !gmState.open
      if (gmState.open && gmState.cur && gmState.customer === undefined) lookup(gmState.cur)
      renderG(true)
    }
    wireG()
    groot.querySelector('.x').onclick = () => { gmState.open = false; renderG() }
  }

  let gStatus = null
  async function lookup(t) {
    gmState.customer = 'loading'
    renderG()
    try {
      gStatus = gStatus || (await ipcRenderer.invoke('jt:status'))
      if (!gStatus.connected) { gmState.customer = 'nokey'; return renderG() }
      const d = t.sender ? await ipcRenderer.invoke('jt:find', { email: t.sender.email, name: t.sender.name }) : null
      if (gmState.thread !== t.id) return
      gmState.customer = d
      gmState.jobs = d ? [...d.jobs.filter((j) => !j.closed), ...d.jobs.filter((j) => j.closed)] : []
      const saved = t.sender ? await ipcRenderer.invoke('jt:link-get', 'mail:' + t.sender.email.toLowerCase()).catch(() => null) : null
      gmState.saved = saved
      if (saved && !gmState.jobs.some((j) => j.id === saved.jobId)) gmState.jobs.unshift({ id: saved.jobId, name: saved.jobName, number: saved.jobNumber, customer: saved.customer || '' })
      gmState.jobId = (saved && saved.jobId) || (gmState.jobs.find((j) => !j.closed) || {}).id || ''
    } catch (err) {
      gmState.customer = { error: gerr(err) }
    }
    renderG()
  }

  function jobBtn(j) {
    return `<button class="job ${j.id === gmState.jobId ? 'on' : ''}" data-job="${gesc(j.id)}"><span>${j.number ? '#' + gesc(j.number) + ' ' : ''}${gesc(j.name)}${j.customer ? `<span class="c">${gesc(j.customer)}</span>` : ''}</span><span class="st">${gesc(j.closed ? 'Closed' : j.status || '')}</span></button>`
  }

  function renderG(refocus) {
    const t = gmState.cur
    ensureG()
    const fab = groot.querySelector('.fab'), pn = groot.querySelector('.pn'), box = groot.querySelector('.in')
    fab.hidden = !t
    pn.hidden = !t || !gmState.open
    if (!t || !gmState.open) return
    const c = gmState.customer
    const s = t.sender || { name: '', email: '' }
    let html = `<h3>${gesc(s.name || s.email || 'Email')}</h3><div class="sub">${gesc(s.email)}</div>`
    if (c === 'loading' || c === undefined) html += '<div class="muted">Looking up in JobTread…</div>'
    else if (c === 'nokey') html += '<div class="muted">JobTread is not connected yet. Open the menu CheckMate Browser → Settings: JobTread &amp; AI Keys… and paste your grant key.</div>'
    else if (c && c.error) html += `<div class="msg err">${gesc(c.error)}</div>`
    else {
      if (c) html += `<div class="sec">Customer</div><button class="job" data-open="${gesc(c.url)}"><span><b>${gesc(c.name)}</b>${c.address ? `<span class="c">${gesc(c.address)}</span>` : ''}</span><span class="st">Open ↗</span></button>`
      else {
        const g = guessContact(t.body)
        const nm = s.name && !/@/.test(s.name) ? s.name : ''
        html += `<div class="sec">Not in JobTread yet</div>
          <details class="lead"${gmState.leadOpen ? ' open' : ''}><summary class="btn" style="list-style:none;display:inline-block">➕ Create customer in JobTread</summary>
            <label>Name<input class="l-name" value="${gesc(nm)}"></label>
            <div class="g2"><label>Phone<input class="l-phone" value="${gesc(g.phone)}"></label><label>Email<input class="l-email" value="${gesc(s.email)}"></label></div>
            <label>Street<input class="l-street" value="${gesc(g.street)}"></label>
            <div class="g3"><label>City<input class="l-city" value="${gesc(g.city)}"></label><label>State<input class="l-state" value="${gesc(g.state || (g.city ? 'FL' : ''))}"></label><label>Zip<input class="l-zip" value="${gesc(g.zip)}"></label></div>
            <label>Note<input class="l-note" value="${gesc('From email: ' + t.subject)}"></label>
            <div class="acts"><button class="btn pri" data-a="lead">Create customer</button></div>
          </details>`
      }
      html += `<div class="sec">Job</div>${gmState.jobs.map(jobBtn).join('') || '<div class="muted">No jobs for this sender. Find one below (e.g. for a supplier invoice).</div>'}
        <div class="row" style="margin-top:4px"><input class="q" placeholder="🔎 Find any job: name, number, customer, address" value="${gesc(gmState.q || '')}"></div>
        <div class="found">${(gmState.found || []).map(jobBtn).join('')}</div>`
      const jobOk = !!gmState.jobId
      html += `<div class="sec">Send to the job</div>
        <div class="acts"><button class="btn" data-a="save" ${jobOk ? '' : 'disabled'}>📝 Save email to job</button><button class="btn" data-a="task" ${jobOk ? '' : 'disabled'}>✅ Create task…</button>${gmState.jobId ? '<button class="btn" data-a="openjob">Open job ↗</button>' : ''}</div>
        <div class="taskf" ${gmState.taskOpen ? '' : 'hidden'}>
          <label>Task<input class="t-name" value="${gesc(t.subject.replace(/^(re|fw|fwd):\s*/i, '').slice(0, 120))}"></label>
          <label>Due date<input class="t-due" type="date" value="${(() => { const d = new Date(Date.now() + 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()}"></label>
          <label class="chk"><input type="checkbox" class="t-mine" checked> Also add to my Tasks</label>
          <div class="acts"><button class="btn pri" data-a="task-go">Create task</button></div>
        </div>`
      if (t.attachments.length)
        html += `<div class="sec">Attachments (${t.attachments.length})</div>${t.attachments.map((a, i) => `<label class="att"><input type="checkbox" data-att="${i}" checked> ${gesc(a.name)}</label>`).join('')}
          <div class="acts"><button class="btn" data-a="atts" ${jobOk ? '' : 'disabled'}>📎 Send to job</button></div>`
    }
    html += `<div class="msg ${gmState.msgCls || ''}">${gesc(gmState.msg || '')}</div>`
    const q = groot.activeElement && groot.activeElement.classList.contains('q')
    const pos = q ? groot.activeElement.selectionStart : null
    box.innerHTML = html
    if (q) { const el = box.querySelector('.q'); el.focus(); el.setSelectionRange(pos, pos) }
  }

  const say = (msg, cls) => { gmState.msg = msg; gmState.msgCls = cls || ''; renderG() }
  const curJob = () => [...gmState.jobs, ...(gmState.found || [])].find((j) => j.id === gmState.jobId)
  async function rememberJob() {
    const t = gmState.cur, j = curJob()
    if (!t || !t.sender || !j) return
    await ipcRenderer.invoke('jt:link-set', 'mail:' + t.sender.email.toLowerCase(), { jobId: j.id, jobName: j.name, jobNumber: String(j.number || ''), accountId: j.accountId || '', status: j.status || '' }).catch(() => {})
  }
  let qTimer = null
  function wireG() {
    groot.addEventListener('input', (e) => {
      if (!e.target.classList.contains('q')) return
      gmState.q = e.target.value
      clearTimeout(qTimer)
      qTimer = setTimeout(async () => {
        if ((gmState.q || '').trim().length < 2) { gmState.found = []; return renderG() }
        try { gmState.found = (await ipcRenderer.invoke('jt:jobs-search', gmState.q)).filter((j) => !gmState.jobs.some((x) => x.id === j.id)) } catch (err) { return say(gerr(err), 'err') }
        renderG()
      }, 350)
    })
    groot.addEventListener('toggle', (e) => { if (e.target.classList && e.target.classList.contains('lead')) gmState.leadOpen = e.target.open }, true)
    groot.addEventListener('click', async (e) => {
      const t = gmState.cur
      const jb = e.target.closest('[data-job]')
      if (jb) { gmState.jobId = jb.dataset.job; gmState.msg = ''; return renderG() }
      const op = e.target.closest('[data-open]')
      if (op) return ipcRenderer.send('jt:open', op.dataset.open)
      const a = e.target.closest('[data-a]')?.dataset.a
      if (!a || !t) return
      const box = groot.querySelector('.in')
      const val = (sel) => (box.querySelector(sel) || {}).value || ''
      try {
        if (a === 'openjob') return ipcRenderer.send('jt:open', `https://app.jobtread.com/jobs/${gmState.jobId}`)
        if (a === 'task') { gmState.taskOpen = !gmState.taskOpen; return renderG() }
        if (a === 'lead') {
          say('Creating the customer…')
          const r = await ipcRenderer.invoke('jt:add', { first: val('.l-name'), phone: val('.l-phone'), email: val('.l-email'), street: val('.l-street'), city: val('.l-city'), state: val('.l-state'), zip: val('.l-zip'), note: val('.l-note') })
          gmState.leadOpen = false
          say(r && r.existing ? 'Already in JobTread ✓' : 'Customer created in JobTread ✓', 'ok')
          return lookup(t)
        }
        if (a === 'save') {
          say('Saving…')
          const text = `Email from ${t.sender ? `${t.sender.name} <${t.sender.email}>` : 'unknown'}${t.when ? ' · ' + t.when : ''}\nSubject: ${t.subject}\n\n${t.body}`.slice(0, 4000)
          await ipcRenderer.invoke('jt:comment', { jobId: gmState.jobId, message: text, name: ('Email: ' + t.subject).slice(0, 120) })
          await rememberJob()
          return say('Email saved to the job ✓', 'ok')
        }
        if (a === 'task-go') {
          const name = val('.t-name').trim()
          if (!name) return say('Give the task a name.', 'err')
          const due = val('.t-due')
          say('Creating the task…')
          await ipcRenderer.invoke('jt:task', { jobId: gmState.jobId, name, due, description: `From email "${t.subject}" (${t.sender ? t.sender.email : ''})\n\n${t.body}`.slice(0, 4000) })
          if (box.querySelector('.t-mine')?.checked) {
            const j = curJob()
            await ipcRenderer.invoke('todos:add', { text: `${name}${j ? ' (' + j.name + ')' : ''}`, due: due ? new Date(due + 'T09:00').getTime() : null }).catch(() => {})
          }
          await rememberJob()
          gmState.taskOpen = false
          return say('Task created in JobTread ✓', 'ok')
        }
        if (a === 'atts') {
          const picks = [...box.querySelectorAll('[data-att]')].filter((x) => x.checked).map((x) => t.attachments[Number(x.dataset.att)])
          if (!picks.length) return say('Pick at least one attachment.', 'err')
          let n = 0
          for (const f of picks) {
            say(`Sending ${++n} of ${picks.length}: ${f.name}…`)
            await ipcRenderer.invoke('jt:upload-url', { targetType: 'job', targetId: gmState.jobId }, f)
          }
          await rememberJob()
          return say(`${picks.length} attachment${picks.length > 1 ? 's' : ''} sent to the job ✓`, 'ok')
        }
      } catch (err) {
        say(gerr(err), 'err')
      }
    })
  }

  // Gmail's keyboard shortcuts (c, j, k, e, #…) must not fire while you type in the panel.
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (e) => { if (ghost && e.composedPath()[0] === ghost) e.stopImmediatePropagation() }, true)
  }
  // Check every 1.5 s which email is open (cheap: a few DOM lookups).
  setInterval(() => {
    if (!document.body) return
    const t = openThread()
    ensureG()
    const id = t ? t.id : ''
    if (id !== gmState.thread) {
      gmState = { ...gmState, thread: id, cur: t, customer: undefined, jobs: [], jobId: '', found: [], q: '', msg: '', taskOpen: false, leadOpen: false }
      if (t && gmState.open) lookup(t)
      renderG()
    } else if (t) {
      gmState.cur = { ...t }
      if (gmState.open && gmState.customer === undefined) lookup(t)
      if (groot && !groot.querySelector('.pn').hidden && !groot.activeElement) {} // don't redraw while you type
    }
    if (!t && groot) renderG()
  }, 1500)
}

// ---------------------------------------------------------------- JobTread panel for phone conversations (WhatsApp, Quo)
// Finds the customer by phone, links the conversation to a job, saves notes and tasks to it.
function jtPhonePanel(opts) {
  let host = null, root = null
  const st = { key: '', ctx: null, customer: undefined, jobs: [], found: [], jobId: '', link: null, open: false, msg: '', cls: '', taskOpen: false, q: '', lookupQ: '' }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const err = (e) => String((e && e.message) || e).replace(/^.*Error: /, '')
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const jobText = (j) => `${j.number || j.jobNumber ? '#' + (j.number || j.jobNumber) + ' ' : ''}${j.name || j.jobName}`

  function ensure() {
    if (host && host.isConnected) return
    host = document.createElement('div')
    host.id = opts.hostId
    root = host.attachShadow({ mode: 'closed' })
    msWire(root)
    root.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      [hidden]{display:none!important}
      .fab{position:fixed;z-index:2147483646;${opts.fabCss};border:1px solid #cfdcf5;background:#eef3fd;color:#2f5297;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer;max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fab:hover{background:#e2eafb}
      .fab.drop{outline:2px dashed #3a5fa8;outline-offset:2px}.fab.over{background:#3a5fa8;color:#fff}
      .pn{position:fixed;z-index:2147483647;width:350px;max-height:calc(100vh - 140px);${opts.panelCss};overflow-y:auto;background:#fff;border:1px solid #e2d9cc;border-radius:16px;box-shadow:0 14px 40px rgba(0,0,0,.25);padding:14px;color:#2b2620;font-size:13px}
      h3{margin:0 0 2px;font-size:15px;padding-right:20px}
      .sub{color:#8a8075;font-size:12px;margin-bottom:8px}
      .sec{font-size:11px;font-weight:700;color:#8a8075;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px}
      .job{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:1px solid #ebe4d9;background:#fff;border-radius:10px;padding:7px 9px;margin-bottom:5px;cursor:pointer;font-size:12.5px;color:#2b2620}
      .job:hover{background:#f6f1ea}.job.on{border-color:#3a5fa8;background:#eef3fd}
      .job .st{margin-left:auto;color:#8a8075;font-size:11px;white-space:nowrap}.job .c{color:#8a8075;font-size:11px;display:block}
      input,textarea{width:100%;border:1px solid #e2d9cc;border-radius:8px;padding:7px 9px;font-size:12.5px;background:#fff;color:#2b2620}
      textarea{resize:vertical}
      label{display:block;font-size:11.5px;color:#8a8075;margin:6px 0 0}
      .btn{border:1px solid #e2d9cc;background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;cursor:pointer;color:#2b2620}
      .btn:hover{background:#f6f1ea}.btn.pri{background:#f26b3a;border-color:#f26b3a;color:#fff;font-weight:600}.btn:disabled{opacity:.5;cursor:default}
      .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      .row{display:flex;gap:6px}
      .msg{font-size:12px;margin-top:8px;color:#8a8075}.msg.err{color:#d03b40}.msg.ok{color:#2f9e5b}
      .muted{color:#8a8075;font-size:12.5px}
      .x{position:absolute;right:10px;top:8px;border:0;background:none;font-size:18px;color:#8a8075;cursor:pointer}
      .chk{display:flex;gap:6px;align-items:center;font-size:12px;color:#2b2620;margin-top:6px}.chk input{width:auto}
    </style>
    <button class="fab" hidden>🔨 JobTread</button>
    <div class="pn" hidden><button class="x" title="Close">×</button><div class="in"></div></div>`
    ;(document.body || document.documentElement).appendChild(host)
    root.querySelector('.fab').onclick = () => { st.open = !st.open; if (st.open && st.customer === undefined) lookup(); draw() }
    root.querySelector('.x').onclick = () => { st.open = false; draw() }
    wire()
    wireDrop(root.querySelector('.fab'))
  }

  async function lookup(manual) {
    const c = st.ctx
    if (!c) return
    st.customer = 'loading'
    draw()
    try {
      const s = await ipcRenderer.invoke('jt:status')
      if (!s.connected) { st.customer = 'nokey'; return draw() }
      const q = manual ? st.lookupQ.trim() : ''
      const by = q ? (/@/.test(q) ? { email: q } : /\d{7,}/.test(q.replace(/\D/g, '')) ? { phone: q } : { name: q }) : { phone: c.phone, name: c.name || '' }
      const key = st.key
      const d = by.phone || by.email || by.name ? await ipcRenderer.invoke('jt:find', by) : null
      if (key !== st.key) return
      st.customer = d
      st.jobs = d ? [...d.jobs.filter((j) => !j.closed), ...d.jobs.filter((j) => j.closed)] : []
      st.link = await ipcRenderer.invoke('jt:link-get', st.key).catch(() => null)
      if (st.link && !st.jobs.some((j) => j.id === st.link.jobId)) st.jobs.unshift({ id: st.link.jobId, name: st.link.jobName, number: st.link.jobNumber })
      const open = st.jobs.filter((j) => !j.closed)
      if (!st.link && d && open.length === 1) await saveLink(open[0], true)
      st.jobId = (st.link && st.link.jobId) || (open[0] || {}).id || ''
    } catch (e) {
      st.customer = { error: err(e) }
    }
    draw()
  }
  async function saveLink(j, auto, extra) {
    if (!j) return
    st.link = await ipcRenderer.invoke('jt:link-set', st.key, { jobId: j.id, jobName: j.name, jobNumber: String(j.number || ''), status: j.status || '', accountId: (st.customer && st.customer.id) || j.accountId || '', auto: !!auto, ...(extra || {}) }).catch(() => st.link)
  }
  const recentText = () => {
    const c = st.ctx
    const ins = (c.recent || []).filter((m) => !m.fromMe).slice(-5)
    return ins.length ? ins.map((m) => `${c.title || 'Customer'} (${opts.source}): ${m.text}`).join('\n') : ''
  }
  const jb = (j) => `<button class="job ${j.id === st.jobId ? 'on' : ''}" data-job="${esc(j.id)}"><span>${esc(jobText(j))}${j.customer ? `<span class="c">${esc(j.customer)}</span>` : ''}</span><span class="st">${esc(j.closed ? 'Closed' : j.status || '')}</span></button>`

  function draw() {
    ensure()
    const fab = root.querySelector('.fab'), pn = root.querySelector('.pn'), box = root.querySelector('.in')
    const flash = st.flashUntil > Date.now() ? st.flashText : ''
    const show = !!st.ctx && (opts.visible() || st.drag || !!flash)
    fab.hidden = !show
    if (show) fab.textContent = flash ? flash : st.drag ? (st.link ? `⬇︎ Drop to send to ${jobText(st.link)}` : '⬇︎ Drop here to send to JobTread') : st.link ? `🔨 ${jobText(st.link)}` : '🔨 JobTread'
    fab.classList.toggle('drop', !!st.drag)
    fab.classList.toggle('over', !!st.dragOver)
    pn.hidden = !show || !st.open
    if (pn.hidden) return
    const typing = root.activeElement && /^(INPUT|TEXTAREA)$/.test(root.activeElement.tagName)
    if (typing && st.noRedraw) return
    const c = st.ctx, d = st.customer
    let h = `<h3>${esc(c.title || 'Conversation')}</h3><div class="sub">${esc(c.phone ? (c.phone.replace(/\D/g, '').length === 10 ? '+1' : '+') + c.phone.replace(/\D/g, '') : 'No phone number found')}</div>`
    if (opts.manual || !c.phone) h += `<div class="row"><input class="lq" placeholder="Phone, email or name to look up" value="${esc(st.lookupQ || c.phone || '')}"><button class="btn" data-a="find">Look up</button></div>`
    if (d === 'loading' || d === undefined) h += '<div class="muted" style="margin-top:8px">Looking up in JobTread…</div>'
    else if (d === 'nokey') h += '<div class="muted">JobTread is not connected yet. Open the menu CheckMate Browser → Settings: JobTread &amp; AI Keys… and paste your grant key.</div>'
    else if (d && d.error) h += `<div class="msg err">${esc(d.error)}</div>`
    else {
      h += d ? `<div class="sec">Customer</div><button class="job" data-open="${esc(d.url)}"><span><b>${esc(d.name)}</b>${d.address ? `<span class="c">${esc(d.address)}</span>` : ''}</span><span class="st">Open ↗</span></button>`
        : `<div class="sec">Not in JobTread yet</div><div class="muted">${esc(opts.notFoundTip || 'Find their job below, or add them as a customer first.')}</div>`
      h += `<div class="sec">Job for this conversation</div>${st.jobs.map(jb).join('')}
        <input class="q" placeholder="🔎 Find any job: name, number, customer, address" value="${esc(st.q)}" style="margin-top:4px">
        <div class="found">${st.found.map(jb).join('')}</div>`
      const ok = !!st.jobId
      h += `<div class="sec">Send to the job</div>
        <label>Note<textarea class="nt" rows="4" placeholder="What should go on the job?">${esc(st.note ?? recentText())}</textarea></label>
        <div class="acts"><button class="btn" data-a="note" ${ok ? '' : 'disabled'}>📝 Save note to job</button><button class="btn" data-a="task" ${ok ? '' : 'disabled'}>✅ Create task…</button>${ok ? '<button class="btn" data-a="openjob">Open job ↗</button>' : ''}</div>
        <div class="tf" ${st.taskOpen ? '' : 'hidden'}>
          <label>Task<input class="tn" value="${esc((((c.recent || []).filter((m) => !m.fromMe).slice(-1)[0] || {}).text || '').replace(/\s+/g, ' ').slice(0, 120))}"></label>
          <label>Due date<input class="td" type="date" value="${iso(new Date(Date.now() + 864e5))}"></label>
          <label class="chk"><input type="checkbox" class="tm" checked> Also add to my Tasks</label>
          <div class="acts"><button class="btn pri" data-a="task-go">Create task</button></div>
        </div>`
      if (opts.autoPhotos && ok) h += `<label class="chk"><input type="checkbox" class="ap" ${st.link && st.link.autoPhotos && st.link.jobId === st.jobId ? 'checked' : ''}> Send new photos from this chat to the job (while the chat is open)</label>`
    }
    h += `<div class="msg ${st.cls}">${esc(st.msg)}</div>`
    const a = root.activeElement, cls = a && a.className, pos = a && a.selectionStart
    box.innerHTML = h
    if (cls && /^(q|lq|nt|tn)$/.test(cls)) { const el = box.querySelector('.' + cls); if (el) { el.focus(); try { el.setSelectionRange(pos, pos) } catch {} } }
  }
  const say = (m, cls) => { st.msg = m; st.cls = cls || ''; draw() }
  const curJob = () => [...st.jobs, ...st.found].find((j) => j.id === st.jobId)

  let qT = null
  function wire() {
    root.addEventListener('input', (e) => {
      const c = e.target.className
      if (c === 'nt') st.note = e.target.value
      if (c === 'lq') st.lookupQ = e.target.value
      if (c !== 'q') return
      st.q = e.target.value
      clearTimeout(qT)
      qT = setTimeout(async () => {
        if (st.q.trim().length < 2) { st.found = []; return draw() }
        try { st.found = (await ipcRenderer.invoke('jt:jobs-search', st.q)).filter((j) => !st.jobs.some((x) => x.id === j.id)) } catch (e2) { return say(err(e2), 'err') }
        draw()
      }, 350)
    })
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.className === 'lq') { e.preventDefault(); lookup(true) } })
    root.addEventListener('change', async (e) => {
      if (e.target.className !== 'ap') return
      if (e.target.checked && opts.autoPhotos) { for (const img of opts.autoPhotos()) sent.add(img.id); try { localStorage.setItem(sentKey, JSON.stringify([...sent].slice(-500))) } catch {} } // only photos from now on
      const j = curJob()
      await saveLink(j, false, { autoPhotos: e.target.checked })
      say(e.target.checked ? 'New photos in this chat will go to the job ✓' : 'Photos stay here', 'ok')
    })
    root.addEventListener('click', async (e) => {
      const j = e.target.closest('[data-job]')
      if (j) { st.jobId = j.dataset.job; await saveLink(curJob(), false); st.msg = ''; return draw() }
      const o = e.target.closest('[data-open]')
      if (o) return ipcRenderer.send('jt:open', o.dataset.open)
      const a = e.target.closest('[data-a]')?.dataset.a
      if (!a) return
      const box = root.querySelector('.in')
      const v = (s) => (box.querySelector(s) || {}).value || ''
      try {
        if (a === 'find') { st.lookupQ = v('.lq'); return lookup(true) }
        if (a === 'openjob') return ipcRenderer.send('jt:open', `https://app.jobtread.com/jobs/${st.jobId}`)
        if (a === 'task') { st.taskOpen = !st.taskOpen; return draw() }
        if (a === 'note') {
          const text = v('.nt').trim()
          if (!text) return say('Write the note first.', 'err')
          say('Saving…')
          await ipcRenderer.invoke('jt:comment', { jobId: st.jobId, message: text, name: `${opts.source} · ${st.ctx.title || ''}`.slice(0, 120) })
          st.note = ''
          return say('Note saved to the job ✓', 'ok')
        }
        if (a === 'task-go') {
          const name = v('.tn').trim()
          if (!name) return say('Give the task a name.', 'err')
          const due = v('.td')
          say('Creating the task…')
          await ipcRenderer.invoke('jt:task', { jobId: st.jobId, name, due, description: `From ${opts.source} with ${st.ctx.title || ''}\n\n${v('.nt')}`.slice(0, 4000) })
          if (box.querySelector('.tm')?.checked) {
            const jj = curJob()
            await ipcRenderer.invoke('todos:add', { text: `${name}${jj ? ' (' + (jj.name || jj.jobName) + ')' : ''}`, due: due ? new Date(due + 'T09:00').getTime() : null }).catch(() => {})
          }
          st.taskOpen = false
          return say('Task created in JobTread ✓', 'ok')
        }
      } catch (e2) {
        say(err(e2), 'err')
      }
    })
  }

  // Drag a picture from the chat, or files from Finder, onto the 🔨 button: it shows up while you drag.
  const dragOk = (e) => { const t = [...((e.dataTransfer && e.dataTransfer.types) || [])]; return t.includes('Files') || t.includes('text/uri-list') }
  let dragT = null
  const dragOn = () => { clearTimeout(dragT); if (!st.drag && st.ctx) { st.drag = true; draw() } }
  const dragOff = () => { clearTimeout(dragT); dragT = setTimeout(() => { if (st.drag) { st.drag = false; st.dragOver = false; draw() } }, 250) }
  window.addEventListener('dragstart', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && /^blob:/.test(t.src || '')) dragOn() }, true)
  window.addEventListener('dragenter', (e) => { if (dragOk(e)) dragOn() }, true)
  window.addEventListener('dragover', (e) => { if (dragOk(e)) dragOn() }, true)
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dragOff() }, true)
  window.addEventListener('dragend', dragOff, true)
  window.addEventListener('drop', dragOff, true)
  function wireDrop(fab) {
    fab.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); st.dragOver = true; fab.classList.add('over') })
    fab.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; dragOn() })
    fab.addEventListener('dragleave', () => { st.dragOver = false; fab.classList.remove('over') })
    fab.addEventListener('drop', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      st.drag = false
      st.dragOver = false
      const files = [...e.dataTransfer.files]
      const uri = (e.dataTransfer.getData('text/uri-list') || '').split('\n').map((x) => x.trim()).find((x) => /^blob:/.test(x)) || ''
      const item = files.length ? { files } : uri ? { src: uri, mime: 'image/jpeg' } : null
      draw()
      if (!item) return
      if (st.key) st.link = (await ipcRenderer.invoke('jt:link-get', st.key).catch(() => null)) || st.link // may have been set by the picker
      const link = st.link && st.link.jobId ? st.link : null
      if (!link) {
        if (opts.pick) return opts.pick(item)
        st.open = true
        if (st.customer === undefined) lookup()
        return say('Pick the job for this conversation below, then drop it again.', 'err')
      }
      const tell = (t, ms) => { st.flashText = t; st.flashUntil = Date.now() + ms; draw(); setTimeout(draw, ms + 50) }
      tell(`Sending to ${jobText(link)}…`, 60000)
      try {
        if (opts.upload) await opts.upload({ targetType: 'job', targetId: link.jobId }, item, st.ctx && st.ctx.title)
        else for (const f of files) await ipcRenderer.invoke('jt:upload-file', { targetType: 'job', targetId: link.jobId }, { name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })
        tell(`✓ Sent to ${jobText(link)}`, 3000)
      } catch (e2) {
        tell('⚠️ ' + err(e2), 8000)
      }
    })
  }

  // auto photos: new incoming pictures in the open chat
  const sentKey = '__ms_jt_sent_photos'
  let sent
  try { sent = new Set(JSON.parse(localStorage.getItem(sentKey) || '[]')) } catch { sent = new Set() }
  let photoBusy = false
  async function photos() {
    if (!opts.autoPhotos || photoBusy || !st.link || !st.link.autoPhotos || !st.link.jobId) return
    const since = st.link.photosSince || 0
    photoBusy = true
    try {
      for (const img of opts.autoPhotos()) {
        if (sent.has(img.id)) continue
        if (img.time && img.time < since) { sent.add(img.id); continue }
        sent.add(img.id)
        try {
          const blob = await (await fetch(img.src)).blob()
          if (blob.size < 15000) continue // thumbnails, stickers
          const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
          await ipcRenderer.invoke('jt:upload', { targetType: 'job', targetId: st.link.jobId }, { name: `${opts.source} ${st.ctx.title || ''} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.${ext}`, mime: blob.type || 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) })
        } catch {}
      }
      try { localStorage.setItem(sentKey, JSON.stringify([...sent].slice(-500))) } catch {}
    } finally {
      photoBusy = false
    }
  }

  if (opts.stopKeys) for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, (e) => { if (host && e.composedPath()[0] === host) e.stopImmediatePropagation() }, true)
  setInterval(async () => {
    if (!document.body) return
    ensure()
    const c = opts.ctx()
    const key = c ? opts.keyOf(c) : ''
    if (key !== st.key) {
      Object.assign(st, { key, ctx: c, customer: undefined, jobs: [], found: [], jobId: '', link: null, msg: '', cls: '', taskOpen: false, q: '', note: undefined, lookupQ: '' })
      if (key) {
        st.link = await ipcRenderer.invoke('jt:link-get', key).catch(() => null)
        if (st.open) lookup()
      }
      draw()
    } else if (c) {
      st.ctx = c
      if (root.querySelector('.fab').hidden === opts.visible()) draw()
      photos()
    } else draw()
  }, 1500)
}

if (location.hostname === 'web.whatsapp.com' && window.top === window) {
  const readWa = () => {
    const main = document.querySelector('#main')
    if (!main) return []
    let rows = [...main.querySelectorAll('.message-in, .message-out')]
    rows = rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)))
    return rows.map((r) => {
      const t = r.querySelector('[data-pre-plain-text]') || r.querySelector('.copyable-text') || r.querySelector('.selectable-text')
      return { fromMe: r.classList.contains('message-out'), text: ((t && t.innerText) || '').trim() }
    }).filter((m) => m.text).slice(-25)
  }
  jtPhonePanel({
    hostId: '__ms_wa_jt',
    source: 'WhatsApp',
    fabCss: 'right:24px;bottom:260px',
    panelCss: 'right:24px;bottom:304px;max-height:calc(100vh - 320px)',
    notFoundTip: 'Use "Save contact" (with "Also add to JobTread") to add them, or find their job below.',
    visible: () => waTools.open && !!document.querySelector('#main footer'),
    ctx: () => {
      const main = document.querySelector('#main')
      const head = main && main.querySelector('header')
      if (!head || !main.querySelector('footer')) return null
      const title = (((head.querySelector('span[dir="auto"]') || head.querySelector('span[title]')) || {}).textContent || '').trim()
      if (!title) return null
      let phone = ''
      const idEl = main.querySelector('[data-id*="@c.us"]')
      const m = idEl && /_(\d+)@c\.us/.exec(idEl.getAttribute('data-id'))
      if (m) phone = m[1]
      if (!phone && /^\+?[\d\s()-]{7,}$/.test(title)) phone = title.replace(/\D/g, '')
      return { title, phone, name: /^\+?[\d\s()-]{7,}$/.test(title) ? '' : title, recent: readWa() }
    },
    keyOf: (c) => 'wa:' + c.title,
    pick: (item) => waJtPick && waJtPick(item),
    upload: (t, item, title) => waJtUpload(t, item, title),
    autoPhotos: () => {
      const main = document.querySelector('#main')
      if (!main) return []
      return [...main.querySelectorAll('.message-in img[src^="blob:"]')]
        .filter((i) => i.naturalWidth > 200 && i.naturalHeight > 200)
        .map((i) => { const row = i.closest('[data-id]'); return { id: (row && row.getAttribute('data-id')) || i.src, src: i.src } })
    },
  })
}

if (/(^|\.)(quo\.com|openphone\.com)$/.test(location.hostname) && window.top === window) {
  const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/
  const visibleEl = (el) => el && el.getClientRects().length > 0
  jtPhonePanel({
    hostId: '__ms_quo_jt',
    source: 'Quo',
    manual: true,
    stopKeys: true,
    fabCss: 'right:22px;bottom:22px',
    panelCss: 'right:18px;bottom:70px',
    visible: () => true,
    ctx: () => {
      // The open conversation's phone number: look in the header area first, then the whole page.
      const heads = [...document.querySelectorAll('header, [class*="header" i], [class*="Header"], [data-testid*="header" i]')].filter(visibleEl)
      let phone = '', title = ''
      for (const h of heads) {
        const t = h.innerText || ''
        const m = t.match(PHONE)
        if (m) { phone = m[0].replace(/\D/g, ''); title = t.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''; break }
      }
      const mUrl = decodeURIComponent(location.href).match(/\+1\d{10}/)
      if (!phone && mUrl) phone = mUrl[0].replace(/\D/g, '')
      if (!/(inbox|conversation|contacts|calls|messages|\/c\/)/i.test(location.pathname) && !phone) return { title: 'Quo', phone: '', name: '', recent: [] }
      return { title: title && !PHONE.test(title) ? title : phone ? phone : 'Quo', phone, name: title && !PHONE.test(title) ? title : '', recent: [] }
    },
    keyOf: (c) => 'quo:' + (c.phone || c.title),
  })
}
