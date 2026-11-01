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
