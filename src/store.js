// Persists spaces, their apps, and open tabs to a JSON file in the user's data folder.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COLORS = ['#e8453c', '#4285f4', '#34a853', '#fbbc05', '#a142f4', '#f06292', '#00acc1', '#ff7043']

// Built-in app catalog shown in the "Add app" picker.
const IMESSAGE_ICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#34c759"/><path fill="#fff" d="M16 7c-5.5 0-10 3.6-10 8.1 0 2.6 1.5 4.9 3.8 6.4-.2 1.4-.9 2.7-2 3.6 2 .1 3.9-.6 5.3-1.8.9.2 1.9.3 2.9.3 5.5 0 10-3.6 10-8.1S21.5 7 16 7z"/></svg>'
  )

const CATALOG = [
  { name: 'iMessage', url: 'internal:imessage', icon: IMESSAGE_ICON },
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Google Calendar', url: 'https://calendar.google.com/' },
  { name: 'Google Drive', url: 'https://drive.google.com/' },
  { name: 'Google Docs', url: 'https://docs.google.com/' },
  { name: 'Google Sheets', url: 'https://sheets.google.com/' },
  { name: 'Google Meet', url: 'https://meet.google.com/' },
  { name: 'Outlook', url: 'https://outlook.office.com/mail/' },
  { name: 'Slack', url: 'https://app.slack.com/client' },
  { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { name: 'Messenger', url: 'https://www.messenger.com/' },
  { name: 'Facebook', url: 'https://www.facebook.com/' },
  { name: 'Instagram', url: 'https://www.instagram.com/' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com/' },
  { name: 'X', url: 'https://x.com/' },
  { name: 'JobTread', url: 'https://app.jobtread.com/' },
  { name: 'Schedulus', url: 'https://schedulus.com/' },
  { name: 'Quo', url: 'https://quo.com/' },
  // Master Touch suppliers
  { name: 'Heritage Pool Plus', url: 'https://www.heritagepoolplus.com/' },
  { name: 'ConstructCC', url: 'https://constructcc.com/' },
  { name: 'Proline', url: 'https://www.prolinedist.com/account/login' },
  { name: 'Horner Xpress', url: 'https://hornerxpressway.com/profile/login' },
  { name: 'Pool360', url: 'https://www.pool360.com/' },
  { name: 'Podium', url: 'https://app.podium.com/' },
  { name: 'Trello', url: 'https://trello.com/' },
  { name: 'Asana', url: 'https://app.asana.com/' },
  { name: 'Notion', url: 'https://www.notion.so/' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Claude', url: 'https://claude.ai/' },
  { name: 'QuickBooks', url: 'https://app.qbo.intuit.com/' },
  { name: 'Dropbox', url: 'https://www.dropbox.com/home' },
  { name: 'Chrome Web Store', url: 'https://chromewebstore.google.com/' },
]

// Apps a new install (and a new space) starts with: the Master Touch team set.
const DEFAULT_APPS = ['Gmail', 'Google Drive', 'JobTread', 'Schedulus', 'Quo', 'Heritage Pool Plus', 'ConstructCC', 'Proline', 'Horner Xpress', 'Pool360']

const id = () => crypto.randomBytes(6).toString('hex')

function defaultState() {
  return {
    activeSpaceId: null,
    spaces: [],
    settings: { appsPanelOpen: true },
  }
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'spaces.json')
    try {
      this.state = { ...defaultState(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    } catch {
      this.state = defaultState()
    }
    if (this.state.spaces.length === 0) {
      const s = this.addSpace({ name: 'Master Touch' })
      for (const n of DEFAULT_APPS) {
        const c = CATALOG.find((x) => x.name === n)
        if (c) this.addApp(s.id, c)
      }
    }
    if (!this.getSpace(this.state.activeSpaceId)) this.state.activeSpaceId = this.state.spaces[0].id
  }

  save() {
    clearTimeout(this._t)
    this._t = setTimeout(() => this.saveNow(), 300)
  }

  saveNow() {
    clearTimeout(this._t)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  getSpace(spaceId) {
    return this.state.spaces.find((s) => s.id === spaceId)
  }

  addSpace({ name, color }) {
    const space = {
      id: id(),
      name: name || 'New space',
      color: color || COLORS[this.state.spaces.length % COLORS.length],
      apps: [],
      tabs: [], // persisted open tabs: { url, appId }
    }
    this.state.spaces.push(space)
    this.save()
    return space
  }

  updateSpace(spaceId, patch) {
    const s = this.getSpace(spaceId)
    if (!s) return
    if (patch.name != null) s.name = patch.name
    if (patch.color != null) s.color = patch.color
    this.save()
    return s
  }

  removeSpace(spaceId) {
    this.state.spaces = this.state.spaces.filter((s) => s.id !== spaceId)
    if (this.state.activeSpaceId === spaceId) this.state.activeSpaceId = this.state.spaces[0]?.id || null
    this.save()
  }

  moveSpace(spaceId, delta) {
    const list = this.state.spaces
    const i = list.findIndex((s) => s.id === spaceId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    this.save()
  }

  addApp(spaceId, { name, url, subtitle, icon }) {
    const s = this.getSpace(spaceId)
    if (!s) return
    const appEntry = { id: id(), name, url, subtitle: subtitle || '', ...(icon ? { icon } : {}) }
    s.apps.push(appEntry)
    this.save()
    return appEntry
  }

  updateApp(spaceId, appId, patch) {
    const a = this.getSpace(spaceId)?.apps.find((x) => x.id === appId)
    if (!a) return
    for (const k of ['name', 'url', 'subtitle', 'icon']) if (patch[k] != null) a[k] = patch[k]
    this.save()
    return a
  }

  // Reorder to match a list of ids (from drag and drop).
  reorder(list, ids) {
    const byId = new Map(list.map((x) => [x.id, x]))
    const out = ids.map((id) => byId.get(id)).filter(Boolean)
    for (const x of list) if (!out.includes(x)) out.push(x)
    list.splice(0, list.length, ...out)
    this.save()
  }

  moveApp(spaceId, appId, delta) {
    const list = this.getSpace(spaceId)?.apps
    if (!list) return
    const i = list.findIndex((a) => a.id === appId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    this.save()
  }

  removeApp(spaceId, appId) {
    const s = this.getSpace(spaceId)
    if (!s) return
    s.apps = s.apps.filter((a) => a.id !== appId)
    this.save()
  }

  setTabs(spaceId, tabs) {
    const s = this.getSpace(spaceId)
    if (!s) return
    s.tabs = tabs
    this.save()
  }
}

module.exports = { Store, CATALOG, COLORS, DEFAULT_APPS }
