// Bridge for the built-in iMessage page.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('imsg', {
  status: () => ipcRenderer.invoke('imsg:status'),
  chats: () => ipcRenderer.invoke('imsg:chats'),
  messages: (chatId) => ipcRenderer.invoke('imsg:messages', chatId),
  sendToChat: (guid, text) => ipcRenderer.invoke('imsg:send-chat', guid, text),
  sendToHandle: (handle, text) => ipcRenderer.invoke('imsg:send-handle', handle, text),
  prefs: () => ipcRenderer.invoke('imsg:prefs'),
  setPrefs: (p) => ipcRenderer.invoke('imsg:set-prefs', p),
  addContact: (c) => ipcRenderer.invoke('imsg:add-contact', c),
  openUrl: (url) => ipcRenderer.send('imsg:open-url', url),
  openInMessages: (handle) => ipcRenderer.send('imsg:open-messages', handle),
  openPrivacySettings: () => ipcRenderer.send('imsg:open-privacy'),
})
