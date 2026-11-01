// Persists spaces, their apps, and open tabs to a JSON file in the user's data folder.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COLORS = ['#e8453c', '#4285f4', '#34a853', '#fbbc05', '#a142f4', '#f06292', '#00acc1', '#ff7043']

// Built-in app catalog shown in the "Add app" picker.
const CATALOG = [
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
  { name: 'Trello', url: 'https://trello.com/' },
  { name: 'Asana', url: 'https://app.asana.com/' },
  { name: 'Notion', url: 'https://www.notion.so/' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Claude', url: 'https://claude.ai/' },
  { name: 'QuickBooks', url: 'https://app.qbo.intuit.com/' },
  { name: 'Dropbox', url: 'https://www.dropbox.com/home' },
  { name: 'Chrome Web Store', url: 'https://chromewebstore.google.com/' },
]

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
      const s = this.addSpace({ name: 'Personal' })
      this.addApp(s.id, CATALOG[0])
      this.addApp(s.id, CATALOG[1])
      this.addApp(s.id, CATALOG[2])
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

  addApp(spaceId, { name, url }) {
    const s = this.getSpace(spaceId)
    if (!s) return
    const appEntry = { id: id(), name, url }
    s.apps.push(appEntry)
    this.save()
    return appEntry
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

module.exports = { Store, CATALOG, COLORS }
