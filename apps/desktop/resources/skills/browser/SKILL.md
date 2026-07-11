---
name: browser
description: "Drive ShuviX's embedded browser panel — open URLs, take A11y snapshots, click / type / scroll, capture screenshots and PDFs, evaluate JavaScript, and inspect network + console. Trigger when the user wants to view a web page, fetch live page content, automate a browser flow, click through a site, fill a form, log in somewhere, scrape rendered HTML, take a screenshot of a URL, export a page to PDF, watch network requests, debug a deployed site, or generally do anything that says '浏览器', '网页', '打开 …', '截图', 'PDF', 'scrape', 'crawl', 'click on', 'fill in', 'login to', 'navigate', 'inspect', 'evaluate JS', or similar. Uses the dedicated `browser` tool; pairs with `read` (to view captured screenshots) and `write` (to save the page or its derivatives)."
---

# Browser

ShuviX hosts a real Chromium browser panel (multi-tab) inside its main window. Drive it with the **`browser` tool** — one tool, many actions: set `action` plus the parameters that action needs. Tabs are explicit: `open_tab` returns a tabId (like `t1`), and every other action takes that `tabId`.

## Iron rules

1. **Always `snapshot` before `click`/`fill`/`type`** — element uids only come from (and are only valid for) the latest snapshot of that tab. After `navigate`, a page-changing click, or a noticeable delay, snapshot again.
2. Every action except `help`/`list_tabs`/`open_tab` needs a `tabId` (from `list_tabs` or `open_tab`).
3. `screenshot` saves a PNG and prints its path — use the `read` tool on that path only if **you** need to see it; if the user is the consumer, hand them the path.

## Typical workflow

1. `browser(action:"open_tab", url:"https://example.com")` → returns tabId `t1`
2. `browser(action:"snapshot", tabId:"t1")` → interactive elements with uids
3. `browser(action:"fill", tabId:"t1", uid:"e7", text:"…")`, then `click` the submit uid
4. `browser(action:"wait_for", tabId:"t1", text:"Welcome")` to confirm
5. `browser(action:"screenshot", tabId:"t1")` or `pdf` to capture

## Full manual

Call `browser(action:"help")` for the complete manual (all actions, key combos, capture/debugging details, pdf sandbox rules), or `help` with `topic: workflow|interaction|navigation|capture|debugging` for one section. Prefer `help` over guessing parameters.

## Notes

- `open_tab`/`navigate` can hit arbitrary URLs (including `file://`). Don't open `file://` paths outside the session sandbox without the user asking.
- `pdf` output paths must be inside the session sandbox (workspace or readwrite reference dirs).
- If the panel misbehaves (stale uid, wait_for timeout, empty screenshot), the fix is almost always: `wait_for` a known on-page string, then re-`snapshot`.
