// "Let Claude control this browser" — a small local-only HTTP bridge, OFF by default and never saved.
// When switched on from the menu it listens on 127.0.0.1 and writes the port and a random token to a file only
// this Mac user can read. Anything that wants to use it must send that token. Switching it off (or quitting)
// removes the file and closes the port. Built-in pages (iMessage, Unread, Tasks) are never exposed.
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

let server = null
let infoFile = null

function isOn() {
  return !!server
}

function start(ctx) {
  if (server) return Promise.resolve(info())
  const token = crypto.randomBytes(24).toString('hex')
  infoFile = path.join(ctx.userData, 'claude-control.json')
  const pick = (spaceId, tabId) => {
    const rt = ctx.runtimes.get(spaceId || ctx.activeSpaceId())
    const t = rt && rt.tabs.get(tabId != null ? Number(tabId) : rt.activeTabId)
    if (!t || t.internal || t.view.webContents.isDestroyed()) throw new Error('No such tab (built-in pages are not available)')
    return t
  }
  const handle = async (route, b) => {
    switch (route) {
      case '/tabs': {
        const out = []
        for (const [spaceId, rt] of ctx.runtimes) {
          for (const t of rt.tabs.values()) {
            if (t.internal) continue
            out.push({ spaceId, tabId: t.id, active: t.id === rt.activeTabId, title: t.title, url: t.url })
          }
        }
        return { activeSpaceId: ctx.activeSpaceId(), tabs: out }
      }
      case '/open': {
        if (!/^https?:\/\//i.test(String(b.url || ''))) throw new Error('url must start with http(s)://')
        return { tabId: ctx.openUrl(b.spaceId || ctx.activeSpaceId(), b.url) }
      }
      case '/select':
        ctx.selectTab(b.spaceId || ctx.activeSpaceId(), pick(b.spaceId, b.tabId).id)
        return { ok: true }
      case '/navigate':
        await pick(b.spaceId, b.tabId).view.webContents.loadURL(String(b.url))
        return { ok: true }
      case '/text': {
        const t = pick(b.spaceId, b.tabId)
        const text = await t.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""')
        return { url: t.url, title: t.title, text: String(text).slice(0, Number(b.max) || 60000) }
      }
      case '/eval': {
        const r = await pick(b.spaceId, b.tabId).view.webContents.executeJavaScript(String(b.code))
        return { result: r === undefined ? null : r }
      }
      case '/click': {
        // Real mouse click at page coordinates (x, y), for pages that ignore scripted clicks.
        const wc = pick(b.spaceId, b.tabId).view.webContents
        const x = Math.round(Number(b.x)), y = Math.round(Number(b.y))
        wc.sendInputEvent({ type: 'mouseMove', x, y })
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return { ok: true }
      }
      case '/type': {
        const wc = pick(b.spaceId, b.tabId).view.webContents
        await wc.insertText(String(b.text))
        return { ok: true }
      }
      case '/screenshot': {
        const img = await pick(b.spaceId, b.tabId).view.webContents.capturePage()
        return { png_base64: img.toPNG().toString('base64') }
      }
      default:
        throw Object.assign(new Error('Unknown route'), { status: 404 })
    }
  }
  server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    // A web page must never be able to call this: require the token and refuse browser-origin requests.
    if (req.method !== 'POST' || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' })
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1e6) req.destroy()
    })
    req.on('end', async () => {
      try {
        send(200, await handle(req.url.split('?')[0], body ? JSON.parse(body) : {}))
      } catch (e) {
        send(e.status || 400, { error: e.message })
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      server = null
      reject(e)
    })
    server.listen(0, '127.0.0.1', () => {
      try {
        fs.writeFileSync(infoFile, JSON.stringify({ port: server.address().port, token }), { mode: 0o600 })
        fs.chmodSync(infoFile, 0o600)
      } catch (e) {
        stop()
        return reject(e)
      }
      resolve(info())
    })
  })
}

function info() {
  return server ? { port: server.address().port, file: infoFile } : null
}

function stop() {
  if (server) server.close()
  server = null
  if (infoFile) try { fs.unlinkSync(infoFile) } catch {}
}

module.exports = { start, stop, isOn }
