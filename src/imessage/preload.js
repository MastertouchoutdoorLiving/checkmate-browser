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
  openPrivacySettings: () => ipcRenderer.send('imsg:open-privacy'),
})
