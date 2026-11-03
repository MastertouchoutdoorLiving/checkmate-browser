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
    root.innerHTML = `<style>
      .btn{position:fixed;right:24px;bottom:84px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font:500 13px -apple-system,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
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
          <div class="r"><input class="jtkey" placeholder="Paste JobTread grant key" autocomplete="off"/><button type="button" class="jtgo">Connect</button></div>
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
    root.querySelector('.btn').hidden = !show
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
    qroot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      .btn{position:fixed;right:24px;bottom:128px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
      .btn:hover{background:#f0f2f5}
      .pop{position:fixed;right:24px;bottom:172px;z-index:2147483647;width:380px;max-height:60vh;display:flex;flex-direction:column;background:#fff;border:1px solid #d1d7db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:10px;color:#111b21;font-size:13px}
      .head{display:flex;justify-content:space-between;align-items:center;padding:2px 4px 8px}
      button{cursor:pointer;font-size:12.5px}
      .head button,.acts button{border:1px solid #d1d7db;background:#fff;border-radius:8px;padding:4px 10px}
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
      <div class="head"><b>Quick replies</b><button class="edit">Edit</button></div>
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
    qroot.querySelector('.btn').hidden = !document.querySelector('#main footer')
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
    rroot.innerHTML = `<style>
      *{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}
      .btn{position:fixed;right:24px;bottom:172px;z-index:2147483646;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}
      .btn:hover{background:#f0f2f5}
      .menu{position:fixed;right:24px;bottom:216px;z-index:2147483647;width:220px;background:#fff;border:1px solid #d1d7db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:6px;font-size:13px;color:#111b21}
      .menu b{display:block;font-size:12px;color:#667781;padding:6px 8px 4px}
      .menu button{display:block;width:100%;text-align:left;border:0;background:none;border-radius:8px;padding:8px 10px;cursor:pointer;font-size:13px}
      .menu button:hover{background:#f0f2f5}
      .ok{position:fixed;right:24px;bottom:216px;z-index:2147483647;background:#111b21;color:#fff;border-radius:10px;padding:8px 12px;font-size:13px}
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
    rroot.querySelector('.btn').hidden = !document.querySelector('#main footer')
  }, 1000)
}
