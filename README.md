# CheckMate Browser

A desktop browser for people who juggle several accounts, inspired by the "spaces + apps" layout of tools like Shift.
It runs on Chromium (through Electron), so sites behave the way they do in Chrome, and it can install **Chrome extensions straight from the Chrome Web Store**.

![layout](docs/layout.png)

## What it does

- **Spaces = separate accounts.** Each space (the round icons on the far left) is a fully isolated browser profile with its own cookies, logins, and storage. Sign in to a different Gmail, Slack, or Facebook account in each space, all at the same time.
- **Apps aren't tabs.** Apps you pin open in their own place when you click them in the apps panel and stay loaded in the background; the tab strip only shows other websites you open. Cmd+W never closes an app.
- **Apps per space.** Pin web apps (Gmail, Calendar, Drive, Slack, WhatsApp, Outlook, QuickBooks, or any URL) in the panel next to the spaces. Clicking an app jumps to its tab, or opens it if it isn't open yet.
- **Unread badges.** Counts are read from page titles like `Inbox (12)`, then shown on the app, the tab, the space icon, and the dock/taskbar icon.
- **Tabs and an address bar** that work like Chrome's: search or type a URL, back/forward/reload, middle-click to close a tab.
- **Chrome extensions.**
  - Open the Chrome Web Store (puzzle icon at the bottom left, then **Open Chrome Web Store**) and click **Add to Chrome**.
  - Or load an unpacked extension folder (**Extensions → Load Unpacked Extension…**).
  - Extension toolbar buttons and popups show at the right end of the address bar, and extension right-click menu items appear in the page context menu.
  - Extensions that live in a side panel open on the right when you click their icon. Click the icon again to close the panel.
  - The **Claude** icon opens claude.ai in that panel, so you can sign in and chat next to any page.
  - Extensions are installed once and loaded into every space. Each space keeps its own extension data, just like separate Chrome profiles.
  - Installed Web Store extensions auto-update at startup and every 5 hours.
- **Remembers everything** between launches: spaces, apps, open tabs, and logins. Logins are written to disk every 30 seconds and again when you quit (even from Ctrl+C or closing the Terminal window), so WhatsApp Web and similar sites stay signed in. Opening the browser a second time just brings the open window forward, because two copies can't share the saved logins.
- **Open link in another space** from the right-click menu, so a link from one account can be opened while signed in as another.

## Passwords

- **Import your old passwords:** in Chrome or Shift go to Settings → Passwords (Google Password Manager) → Export passwords, which saves a `.csv` file. Then in this browser click the key icon at the bottom left (or **Passwords → Import Passwords**) and pick that file. You'll be offered to move the CSV to the Trash afterwards, since it isn't encrypted.
- Logins fill in automatically on their sites, in every space. If a site has several saved accounts, click the username box to pick one.
- When you sign in somewhere new, the browser offers to save the password.
- Passwords are encrypted with your Mac's Keychain and never leave the computer.

## iMessage (Mac only)

Add **iMessage** from **+ Add app**. It shows your conversations and lets you reply, with unread badges like the other apps.

- Three columns: the **Inbox** (favorites as big avatars on top, then conversations grouped by Today / Yesterday / This week / Earlier), the conversation, and a **details** panel (members, favorite, mark unread, open in Messages). The panel button at the top right shows or hides details.
- Filter by **All / Unread / Read / Favorites**. Right-click any conversation to mark it read or unread or add it to Favorites.
- Links in messages open as a tab in the same space.
- **Send pictures and files:** paste a picture (Cmd+V), drag it onto the conversation, or click the paperclip. It shows above the message box; add text if you like and press Enter. A copy is kept in ~/Pictures/MultiSpace Browser, because Messages can only send files from folders it's allowed to read.
- **New message:** click the pencil, then type a name in **To:** and pick from your Mac's Contacts (all phone numbers and emails are listed; use the arrow keys and Enter). If you already have a conversation with that person, it opens that conversation instead.
- **Add to Contacts:** for a number that isn't saved, click the person+ button at the top (or **Add to Contacts** in the details panel). The full name goes in one Name field (saved as the first name, so it's easy to search). Name, phone, email and street address are filled in from what they texted you (highlight text in the chat first to use exactly that). Check the highlighted fields before saving. It's saved through the Mac's Contacts app to your default account (usually iCloud), so it shows on your iPhone too. The first time, macOS asks to let the browser control Contacts; click OK.
- **Save contacts from WhatsApp:** open a chat on WhatsApp Web and click **👤 Save contact** (bottom right). The phone number, name, email, address and website are filled in from the conversation; check them and click Save. It goes to Contacts (iCloud and your iPhone), the same way as from iMessage.
- **Send to team on WhatsApp:** right-click a message (or use the details panel) and pick **Send to team on WhatsApp**. Choose a teammate (add them once with their WhatsApp number), edit the message, and it opens your WhatsApp Web chat with them with the text already typed. Press Enter to send. For a WhatsApp group, pick "A group or someone else": the message is copied, so paste it into the group.
- **Swipe left to delete:** swipe a conversation left with two fingers on the trackpad (or drag it with the mouse) to show **Read/Unread** and **Delete**. A long swipe deletes right away, and **Undo** brings it back. Deleting removes it from this browser's list only (it comes back if they message again); it doesn't delete it from your iPhone or the Messages app.
- People who aren't in your Contacts but shared their name and photo with you show as their shared name with a **Maybe** tag, like in the Messages app. Phone numbers are shown as +1 (954) 804-5573.

- The first time, macOS needs to allow the browser to read your Messages history: System Settings → Privacy & Security → **Full Disk Access** → turn on **Terminal** (or **CheckMate Browser** if you installed it as an app), then restart the browser.
- The first time you send, macOS asks to let it control **Messages**. Click OK.
- Photos and videos show right in the conversation (click a photo to see it large). iPhone HEIC photos are converted to JPEG on your Mac so they can be shown. Other files (PDFs etc.) show as a chip; click it to see the file in Finder. Reading a message here doesn't mark it as read in Messages.

### New message alerts

The browser plays a beep and shows a Mac notification when a new iMessage comes in, even when the iMessage app isn't open. Clicking the notification opens that conversation. Turn either one off with the bell next to **Inbox**, or in the **Messages** menu. No alert is shown for the conversation you're already reading.

## Unread (everything in one list)

The **Unread** app (first in the apps panel) shows every unread conversation in one place:

- **iMessage:** each unread conversation, with the last message.
- **WhatsApp:** each unread chat from WhatsApp's chat list, while WhatsApp is open in the browser.
- **Other apps:** Quo, Gmail, Slack and others show how many unread they have, when the site puts the number in its tab title.

Click a row to jump straight to that conversation or app.

## Quick replies

Saved messages you can drop into iMessage or WhatsApp with one click. In iMessage click ⚡ next to the paperclip (or type / at the start of the message). In WhatsApp click **⚡ Quick replies** above **Save contact**. Click **Edit** to add, change or delete them. Write `{name}` where the person's first name should go. iMessage and WhatsApp use the same list.

## Save contact → JobTread

The **Save contact** form (iMessage and WhatsApp) has an **Also add to JobTread** box. Connect it once: in JobTread open app.jobtread.com/grants, create a grant key and paste it in. It is stored encrypted. Each save then creates the customer in JobTread with a contact (name, email, phone, notes) and the job location (address). If a customer with the same name already exists, nothing is duplicated.

## More helpers in iMessage and WhatsApp

- **Remind me to reply:** ⏰ in the iMessage conversation header, or **⏰ Remind me** in WhatsApp. Pick 1 hour, 3 hours, tomorrow 9 AM or Monday 9 AM. At that time it beeps, shows a notification, and clicking it opens the conversation.
- **Send later (iMessage):** write the message, click the clock next to Send and pick when. Scheduled messages show above the message box, where you can cancel them. The browser has to be open at that time; if it was closed, the message goes out when you open it again.
- **JobTread card:** with JobTread connected, the iMessage details panel shows the customer, address and jobs (found by phone, email or name). Click to open in JobTread.
- **Pictures to JobTread:** in iMessage click a picture → **Send to JobTread**. In WhatsApp right-click a picture → **Send picture to JobTread…**. Pick the job; it goes in the job's Photos folder.
- **✨ Suggest reply:** writes a short reply from the conversation (and improves your draft if you started one). Needs a Claude API key from console.anthropic.com, pasted once.
- **🎤 Dictate:** uses the Mac's own Dictation (turn it on in System Settings → Keyboard → Dictation).

## Memory saver

Apps you haven't opened for 30 minutes go to sleep and free their memory; clicking one wakes it up. Only the app you were on loads at startup. WhatsApp, Gmail, Quo and the built-in pages always stay awake so unread counts and notifications keep working. Turn it off in View → Save Memory.

## Automatic updates

Installed copies check GitHub for a new version every few hours, download it in the background and ask to restart. Use the app menu → **Check for Updates…** to check now. New team members install from the latest release: https://github.com/MastertouchoutdoorLiving/checkmate-browser/releases/latest (download **CheckMate-Browser.dmg**, open it, drag the app into Applications; the first time, right-click the app → Open, or allow it in System Settings → Privacy & Security → Open Anyway).

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

### Install it as a normal Mac app (no Terminal needed afterwards)

```bash
npm run install-mac
```

This builds **CheckMate Browser.app**, puts it in **Applications** and opens it. From then on, open it from Launchpad, Applications or the Dock (right-click its Dock icon → Options → Keep in Dock). Your spaces, logins and passwords carry over. To update later, unzip the new version and run the same command again.

For iMessage, give **CheckMate Browser** (instead of Terminal) Full Disk Access in System Settings → Privacy & Security.

### Give it to your team (Mac)

```bash
npm run share-mac
```

Builds **CheckMate-Browser-<version>.dmg** (works on Apple-chip and Intel Macs) and puts it on your Desktop. Send it to your team by Google Drive, email, etc. Each person opens the .dmg and drags the app into Applications. Your logins, spaces and passwords are **not** inside it; everyone starts fresh with their own.

The first time, macOS says it can't check the app (it isn't signed with an Apple Developer ID). Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**. With an Apple Developer account the app can be signed so this warning goes away.

### Windows / Linux installers

```bash
npm run dist
```

Builds an `.exe` installer on Windows or an AppImage on Linux in `dist/` (build each platform on that platform).

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New tab | Ctrl/Cmd + T |
| Close tab | Ctrl/Cmd + W |
| New space | Ctrl/Cmd + Shift + N |
| Go to space 1–9 | Ctrl/Cmd + 1…9 |
| Focus address bar | Ctrl/Cmd + L |
| Show/hide apps panel | Ctrl/Cmd + B |
| Back / Forward | Ctrl/Cmd + [ / ] |
| Zoom | Ctrl/Cmd + = / - / 0 |
| Page developer tools | Ctrl+Shift+I (Alt+Cmd+I on Mac) |

Right-click or double-click a space icon to rename it, change its color, reorder it, or delete it. Deleting a space signs you out of everything in it and wipes its data.

## How it works

| File | Purpose |
| --- | --- |
| `src/main.js` | Main process: windows, one Chromium session per space (`persist:space-<id>`), tabs, menus, extension wiring |
| `src/store.js` | Saves spaces, apps, and open tabs to `spaces.json` in the app's data folder; holds the app catalog |
| `src/ui-preload.js` | Safe bridge between the browser UI and the main process; registers the extension toolbar element |
| `src/ui/` | The browser chrome itself (spaces rail, apps panel, tab strip, toolbar, dialogs) in plain HTML/CSS/JS |

Chrome extension support comes from two open-source (MIT) libraries:
[`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions) adds the `chrome.tabs`, `chrome.action`, `chrome.contextMenus`, `chrome.cookies`, `chrome.notifications`, `chrome.windows` and other APIs that plain Electron lacks, and
[`electron-chrome-web-store`](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-web-store) makes the Chrome Web Store's "Add to Chrome" button work and keeps extensions updated.

## Known limits

- **Not every extension will work.** Content-script extensions (ad blockers, Dark Reader, Grammarly-style helpers, password managers' autofill) generally work well. Extensions that need Chrome-only services such as `chrome.identity` (Google account sign-in inside the extension), Chrome Sync, or side panels may be partly or fully broken. Test the ones you rely on.
- **Google sign-in.** Google blocks sign-in from browsers it thinks are "embedded apps" ("Couldn't sign you in. This browser or app may not be secure"). To avoid that, on Google's sign-in pages only, this browser presents itself as Firefox, which Google accepts; everywhere else it's Chrome. If Google still refuses, wait a few minutes and try again, or sign in from a different Google page (for example Drive).
- **No Chrome Sync or Google password manager.** Use a password-manager extension instead (Bitwarden, 1Password, LastPass).
- Not code-signed yet, and there is no auto-update of the app itself yet.

## Ideas for next steps

- Per-space notification controls and Do Not Disturb hours
- Quick switcher / search across all tabs in all spaces (Ctrl/Cmd + K)
- Import bookmarks and passwords from Chrome
- Lock a space behind a password, and sync spaces between computers
- Code signing and app auto-update
