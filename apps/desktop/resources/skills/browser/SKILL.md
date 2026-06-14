---
name: browser
description: "Drive ShuviX's embedded browser panel — open URLs, take A11y snapshots, click / type / scroll, capture screenshots and PDFs, evaluate JavaScript, and inspect network + console. Trigger when the user wants to view a web page, fetch live page content, automate a browser flow, click through a site, fill a form, log in somewhere, scrape rendered HTML, take a screenshot of a URL, export a page to PDF, watch network requests, debug a deployed site, or generally do anything that says '浏览器', '网页', '打开 …', '截图', 'PDF', 'scrape', 'crawl', 'click on', 'fill in', 'login to', 'navigate', 'inspect', 'evaluate JS', or similar. Drives the `bash` tool to invoke the bundled `shuvix browser` CLI; pairs with `read` (to view captured screenshots) and `write` (to save the page or its derivatives)."
---

# Browser

ShuviX hosts a real Chromium WebContentsView panel inside its main window. This skill drives it: open a URL, observe the page's accessibility tree, interact (click / fill / type / scroll), capture images / PDFs, evaluate JavaScript, and inspect network + console traffic. All actions go through the `shuvix browser` CLI — no custom tool, just `bash`.

## CLI you'll use

`shuvix` is on PATH (injected by ShuviX into the `bash` tool's spawn env). It's a thin client that talks to the running ShuviX process — **only works while ShuviX is running**.

### Panel
| Command | What it does |
|---|---|
| `shuvix browser open <url>` | Open the panel at URL. Required first step before any other action. |
| `shuvix browser close` | Close the panel and detach CDP. |

### Observation
| Command | What it does |
|---|---|
| `shuvix browser snapshot` | Print the accessibility tree with element UIDs (e.g. `uid=e3 button "Submit"`). Always run **before** click / fill / type — UIDs are the only stable handles. |
| `shuvix browser screenshot [--full-page] [--uid <id>]` | Save a PNG to the session's tool_results dir and print the absolute path. Pass `--uid` to crop to one element, `--full-page` for the whole scrollable page, neither for the viewport. Use the `read` tool on the printed path when you actually need to see the image — don't dump it blind. |
| `shuvix browser pdf --out <path> [--page-size A4\|A3\|A5\|Letter\|Legal] [--landscape] [--no-print-background] [--no-prefer-css-page-size] [--scale <n>]` | Render the page to PDF. `<path>` **must** be inside the session's working directory (or a readwrite reference dir) — out-of-sandbox targets are rejected. Keep `--prefer-css-page-size` on (default) when the HTML declares `@page` rules; only pass `--no-prefer-css-page-size` when you explicitly want the CLI flags to override the CSS. |

### Interaction
| Command | What it does |
|---|---|
| `shuvix browser click --uid <id>` | Click element by UID from the latest snapshot. |
| `shuvix browser fill --uid <id> --value <text>` | Set the value of an input / select / textarea by UID. |
| `shuvix browser type --text <text> [--uid <id>] [--submit-key <key>]` | Type into the focused element (or a UID). `--submit-key Enter` to submit after. |
| `shuvix browser press-key --key <combo>` | Press a key combo. e.g. `Enter`, `Tab`, `Escape`, `Control+A`, `Meta+Shift+R`. |
| `shuvix browser scroll [--direction up\|down\|left\|right] [--amount <px>] [--uid <id>]` | Scroll the page (or an element). Default: down 500px. |

### Navigation
| Command | What it does |
|---|---|
| `shuvix browser navigate --url <url>` | Navigate the already-open panel to a new URL (no panel reopen). |
| `shuvix browser navigate --nav back\|forward\|reload` | History navigation / reload. |

### Evaluation
| Command | What it does |
|---|---|
| `shuvix browser evaluate --expression <js>` | Run a JS expression in the page; returns its JSON-stringified value. For multi-line scripts, `write` a `.js` file then pass `--expression "$(cat file.js)"` from a single-line bash command. |

### Waiting
| Command | What it does |
|---|---|
| `shuvix browser wait-for --text <s> [--timeout <ms>]` | Poll until `<s>` appears in `document.body.innerText`. Default timeout 10000ms. Exits non-zero on timeout — handle accordingly. |

### Debugging
| Command | What it does |
|---|---|
| `shuvix browser network` | List HTTP requests captured since the last navigation. |
| `shuvix browser console` | List console messages captured since the last navigation. |

All commands print plain text to stdout on success, plain error text to stderr on failure, and use exit code 0 / 1 accordingly.

## Typical workflows

### Inspect / scrape a page
1. `shuvix browser open <url>`
2. `shuvix browser snapshot` — read the A11y tree to locate the data of interest
3. `shuvix browser evaluate --expression "document.querySelector('…').textContent"` (or grab structured DOM)
4. `shuvix browser close` when done (or leave open for the user)

### Automate a form / login flow
1. `shuvix browser open <login-url>`
2. `shuvix browser snapshot` — find the input UIDs
3. `shuvix browser fill --uid e7 --value "user@example.com"`
4. `shuvix browser fill --uid e9 --value "$PASSWORD"`
5. `shuvix browser click --uid e12` (submit) — **or** `shuvix browser type --uid e9 --text "$PASSWORD" --submit-key Enter`
6. `shuvix browser wait-for --text "Welcome"` to confirm success
7. `shuvix browser snapshot` again on the post-login page

### Capture a page
1. `shuvix browser open <url>`
2. `shuvix browser wait-for --text "<anchor text from the rendered page>"` — make sure it actually painted
3. `shuvix browser screenshot --full-page` → reads back as `/.../tool_results/.../screenshot-…png`
4. `read <printed-path>` only if **you** actually need to inspect the image; if the user is the consumer, just hand them the path.

### Export to PDF (e.g. Kami templates)
1. `shuvix browser open <url-or-file>`
2. `shuvix browser wait-for --text "…"` if the page renders async
3. `shuvix browser pdf --out ./out/report.pdf`
4. If the HTML uses `@page` rules (Kami output does), default `--prefer-css-page-size` is correct — overriding margins via flags usually pushes content onto an extra blank page.

### Debug a deployed page
1. `shuvix browser open <url>`
2. `shuvix browser network` — see what loaded / failed
3. `shuvix browser console` — see runtime errors
4. `shuvix browser evaluate --expression "JSON.stringify({title:document.title,bodyLen:document.body.innerText.length})"`

## Critical: snapshot before interaction

UIDs come from `snapshot`. They are stable for the current page state, but a new navigation / SPA route change / DOM mutation invalidates them. Rule: **after any `navigate`, `click`, `fill`, `wait-for` or noticeable delay, run a fresh `snapshot` before the next interaction.** Otherwise the next `click --uid …` may target a stale node and silently miss.

## Sandbox

- `shuvix browser pdf --out …` and any path you pass to `read` after `screenshot` are subject to the session's read/write allowlist (same rules as the `write` tool).
- The screenshot helper writes into the session-scoped `tool_results` directory automatically — you don't need to allowlist it, just `read` the path it prints.
- `shuvix browser open` / `navigate` can hit arbitrary URLs (including `file://`). Don't open `file://` paths outside the session sandbox without the user asking — pasting local files into the browser bypasses the read allowlist.

## Troubleshooting

- **`shuvix: command not found`** → You're in a shell ShuviX didn't launch (manual terminal, SSH session). The CLI is on PATH only inside ShuviX-spawned shells. Tell the user.
- **`Cannot find ~/.shuvix/cli-token` / `Cannot reach ShuviX`** → ShuviX isn't running, or this session was started before ShuviX. Ask the user to relaunch ShuviX.
- **`Browser panel is not open. Use action="open" with a url first.`** → You skipped `shuvix browser open …`, or a previous `close` detached the panel. Open it again first.
- **`click` doesn't seem to do anything** → The UID is stale (page changed since the last `snapshot`). Run `snapshot` again and use the fresh UID.
- **`wait-for` times out** → The text never rendered, OR the page renders it inside a Shadow DOM / iframe (`document.body.innerText` doesn't include those). Fall back to `evaluate` with a targeted querySelector.
- **`screenshot` produces empty image** → The view hasn't painted yet. Run `wait-for` on a known on-page string first, then re-shoot.
- **`pdf` rejects the path** → `--out` resolved outside the session sandbox. Pass an absolute path inside the workspace, or a path relative to the session's working directory.
- **`evaluate` returns `(undefined)`** → Either the expression actually evaluates to `undefined`, or it threw — the error is printed instead of the value. Wrap risky expressions in `try { … } catch (e) { return String(e) }` to surface failures.
