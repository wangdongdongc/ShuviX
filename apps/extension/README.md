# ShuviX for Chrome

A side panel next to any page in your own Chrome. Click the ShuviX toolbar icon on a tab and a
conversation opens for that tab; it follows the tab (close and reopen the panel and it is still
there) and ends when the tab closes.

The extension runs no agent and holds no model or key. **The conversation runs in the ShuviX
desktop app**: the side panel is chat-ui in single-session channel mode, and the extension's
service worker relays it to the desktop over Chrome native messaging. The same link lets the
desktop operate your Chrome — the built-in `chrome` capability, which only these tab
conversations have — through `chrome.tabs`, `chrome.scripting` and `chrome.debugger`.

```
side panel (per tab) ─┐
                      ├─ service worker ⇄ native messaging ⇄ local component ⇄ ShuviX desktop
side panel (per tab) ─┘                                    (cli.js native-host)
```

- **Needs the desktop app running.** The desktop registers the local component (a native
  messaging host) with every Chromium browser it finds each time it starts; open the app once
  after installing it. Settings → MCP → the built-in `chrome` row shows connected browsers and
  can repair the registration.
- **Each site asks once.** The first time a conversation opens or works on a site, ShuviX asks
  (builtin policy `ask-on-new-site`); the tab you opened the panel on is already allowed.
- **Tabs you ask about ride along.** The chips above the input choose which tabs go with the
  message (this tab by default); the model gets their titles and addresses, and reads page
  content itself when it needs it.

Protocol and contracts: `packages/chat-protocol/src/chromeBridge.ts`. Desktop side:
`apps/desktop/src/main/services/chromeBridge/` (bridge server, native host installer, the `chrome`
backend) and `apps/desktop/src/main/frontend/chrome/` (tab sessions, the side panel's call
whitelist).

## Develop

```bash
npm run build:ext   # build the unpacked extension into apps/extension/dist
npm run dev:ext     # the same, rebuilding on every change (then reload it in chrome://extensions)
```

Load `apps/extension/dist` in `chrome://extensions` (Developer mode → Load unpacked). The
extension id is fixed by the `key` in `public/manifest.json`; the desktop's host manifest allows
exactly that id.
