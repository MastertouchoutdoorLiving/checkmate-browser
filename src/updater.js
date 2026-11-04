// Automatic updates (Mac): checks GitHub for a newer CheckMate Browser, downloads it in the background,
// and swaps it in when you restart. No Terminal needed.
const { app, net, dialog } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')

const REPO = 'MastertouchoutdoorLiving/checkmate-browser'
const ASSET = 'CheckMate-Browser-mac.zip'
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

let ready = null // { version, appPath } once a new version is unpacked and waiting
let busy = false
let getWin = () => null

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number)
  const pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, out) => (e ? rej(e) : res(out))))
// The installed .app (…/CheckMate Browser.app)
const bundlePath = () => path.resolve(process.execPath, '..', '..', '..')

async function check({ manual = false } = {}) {
  if (busy || ready) {
    if (manual && ready) promptRestart()
    return
  }
  busy = true
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CheckMate-Browser' } })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const rel = await res.json()
    const version = String(rel.tag_name || '').replace(/^v/, '')
    if (!version || !newer(version, app.getVersion())) {
      if (manual) dialog.showMessageBox(getWin(), { message: 'CheckMate Browser is up to date.', detail: `Version ${app.getVersion()}` })
      return
    }
    const asset = (rel.assets || []).find((a) => a.name === ASSET)
    if (!asset) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkmate-update-'))
    const zip = path.join(dir, ASSET)
    const dl = await net.fetch(asset.browser_download_url)
    if (!dl.ok) throw new Error(`Download failed (${dl.status})`)
    fs.writeFileSync(zip, Buffer.from(await dl.arrayBuffer()))
    await run('/usr/bin/ditto', ['-x', '-k', zip, dir])
    const appDir = fs.readdirSync(dir).find((n) => n.endsWith('.app'))
    if (!appDir) throw new Error('The update has no app inside.')
    ready = { version, appPath: path.join(dir, appDir) }
    promptRestart()
  } catch (e) {
    if (manual) dialog.showMessageBox(getWin(), { type: 'warning', message: 'Could not check for updates.', detail: String(e.message || e) })
  } finally {
    busy = false
  }
}

async function promptRestart() {
  if (!ready) return
  const { response } = await dialog.showMessageBox(getWin(), {
    message: `CheckMate Browser ${ready.version} is ready.`,
    detail: 'Restart now to use the new version? Your apps, logins and passwords stay the same. If you choose Later, it updates the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) installAndRelaunch(true)
}

// A small script waits for this app to close, swaps the new version in, re-signs it for this Mac if it isn't signed by Apple Developer ID, and opens it.
function installAndRelaunch(relaunch, quit = true) {
  if (!ready) return
  const target = bundlePath()
  const script = path.join(path.dirname(ready.appPath), 'install.sh')
  fs.writeFileSync(
    script,
    `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done
rm -rf "${target}.old"
mv "${target}" "${target}.old" || exit 1
if ! cp -R "${ready.appPath}" "${target}"; then mv "${target}.old" "${target}"; exit 1; fi
# keep a real (Developer ID) signature; only ad-hoc sign builds that have none
codesign --verify --deep --strict "${target}" >/dev/null 2>&1 || codesign --force --deep --sign - "${target}" >/dev/null 2>&1
xattr -dr com.apple.quarantine "${target}" >/dev/null 2>&1
rm -rf "${target}.old"
${relaunch ? `open "${target}"` : ''}
`,
    { mode: 0o755 }
  )
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
  ready = null
  if (quit) app.quit()
}

function start(winGetter) {
  getWin = winGetter
  if (process.platform !== 'darwin' || !app.isPackaged) return
  // Only when installed as a normal app we can replace.
  if (!/\.app$/.test(bundlePath())) return
  setTimeout(() => check(), 20 * 1000)
  setInterval(() => check(), CHECK_EVERY_MS)
  app.on('before-quit', () => {
    if (ready) installAndRelaunch(false, false)
  })
}

module.exports = { start, check }
