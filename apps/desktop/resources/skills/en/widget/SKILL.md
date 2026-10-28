---
name: widget
description: "How to build, change, export and debug ShuviX Widgets — small React apps the user reopens from the Widget panel, each with its own SQLite database and an API that its screen and agents share: the widget tool's building actions, defining the API in api.ts, calling it from the screen with shuvix/widget, the closed dependency set, reading files on the user's computer in a way that also works when ShuviX is used from a browser, the design guide for the panel, a wide window and a phone, checking the layout with screenshots, and upgrading an older widget. Load this when the user asks for a widget, mini app, 小工具 or 小组件, or a small tool they will come back to, and before changing or debugging an existing widget."
---

# ShuviX Widgets

A widget is a small React app in its own directory under ShuviX's widgets folder. ShuviX bundles it and serves it under `/w/<id>/`. The user opens it from the Widget tab of the right panel, where it runs inside the panel or in its own window (a browser tab when they use ShuviX remotely).

A widget that keeps records has an **API**: the operations defined in its `api.ts`, which run on ShuviX's side against the widget's own SQLite database. Its screen reads and writes only through them, and agents call the same operations with the `widget` tool's `call` — so an action has the same effect whoever takes it, and the open screen refreshes when an agent writes. Each widget also has its own git repository; ShuviX commits after every successful build, so you never run git yourself.

This file is the whole workflow. The references hold the details; each row of the index at the end says when to read one.

## When a widget is the answer

- The user calls it a widget, mini app, 小工具 or 小组件, or wants a small tool they will reopen: a formatter, converter, tracker, a dashboard over their own files. A one-off question gets an answer or a script, not a widget.
- One widget per purpose. A change to an existing widget is a change to that widget, never a second one.

## Rules that always hold

1. **Building goes through the `widget` tool** (`create`, `build`, `preview`, `sql`, `export`, `open`; `references/tool.md`). `build` is the only build: never install packages, never run npm, npx or a bundler, never run git in a widget.
2. **Closed dependency set.** The screen: React 19 with TypeScript, Tailwind CSS v4 through `className` (`dark:` follows the app theme), React Router (`createHashRouter` from `react-router`) only for a genuinely multi-page widget, and `shuvix/widget` to call the API. `api.ts`: `shuvix/widget-api` and `zod`. Nothing else resolves; an unknown import fails the build. Icons are inline SVG, dates are `Intl` and `Date`.
3. **`index.tsx` ends with the mount block**, inside the scaffold's "DO NOT DELETE" comment:
   ```tsx
   const root = document.getElementById('root')
   if (root) createRoot(root).render(<App />)
   ```
4. **Stay inside the widget's own directory.** Never edit or delete `widget.json`: it is the widget's identity, and ShuviX rewrites it itself.
5. **Records live in the widget's database and change only through its API** (`references/api.md`, `references/data.md`). The screen calls the API with `createClient` from `shuvix/widget`; it reads files on the user's computer through `fs/file` and `fs/list` (`references/files.md`). Never write `shuvix-media://`, `file://` or `http://127.0.0.1:<port>`: they only work on the desktop, and the widget breaks when it is opened from a browser.
6. **Persistent state goes in the database** (through an operation), not `localStorage`, `IndexedDB` or cookies: opened from a browser, the widget runs sandboxed without an origin of its own, where those are unavailable.
7. **It works in the panel, a wide window and on a phone.** The same widget opens in the right panel (300–420px wide), in its own window or a browser tab (up to full screen), and in a phone's browser (touch). **Dark mode is mandatory.** How to lay it out for all three, and the rest of the look, are in `references/design.md`: read it before writing UI.
8. **Never report a widget that has not built.** Finish with a green build. **Do not open it for the user**: say it is ready in the Widget panel, by its name. A build reloads the widget wherever it is already open. Use `open` only when the user asks you to open it.

## A new widget

1. **Id**: lowercase ASCII kebab-case with at least one dash (`/^[a-z0-9]+(-[a-z0-9]+)+$/`), e.g. `json-formatter`, whatever the user's language. **`name` and `description`** in the user's language; they show verbatim on the widget's card and in its window title.
2. `create` with `widget`, `name` and `description`. Work in the folder it returns; the entry file is `index.tsx`. This conversation may now change the widget and use it.
3. **Before writing code**, decide whether it keeps records. If it does, write `schema.sql` and create the tables with `sql` (`references/data.md`), then write `api.ts` (`references/api.md`). Decide whether it reads the user's files (`references/files.md`).
4. Implement the screen, following `references/design.md`.
5. Write a short `README.md` in the language of `name`: what it does, its main interactions, its operations and tables, the files it reads, its extension points.
6. `build` with a one-line `message`. If it fails, fix what it reports and build again. Then try each operation with `call` and `dry_run: true` (`references/api.md`, "Test it").
7. `preview` and look at the screenshots; fix, build and preview again until it looks right at every size (`references/design.md`, "Check it").
8. Report that it is ready in the Widget panel (rule 8).

## Changing an existing widget

1. `list` to find its id and folder.
2. `build` with `message: "chore: baseline before <task>"` **before touching anything**. The first time in a conversation this asks the user to let it change the widget; once allowed, the folder is yours to edit. It shows whether the widget builds and, if it does, commits whatever was already there, so your change lands as its own commit.
3. Read `README.md`, `api.ts` and every file you are about to change, and follow their conventions. A widget without `api.ts` that reads or writes `/db/…` predates the API: read `references/maintenance.md`.
4. Change it with targeted `edit`s and add one line to the README's changelog, in the README's language. Do not rename or remove an operation unless asked: other sessions and the user's bots may use it.
5. `build` with a `message` saying what changed, and fix any errors; `build` warns when an operation disappeared or its input changed. If you changed what it looks like, `preview` it. Then report (rule 8).

Never rename, repurpose, archive or delete a widget the user did not ask about.

## Reporting

Reply with the result only, in a few lines:

```
reading-list ("读书清单") — books the user wants to read, is reading or finished, with notes. 4 operations agents can call (listBooks, addBook, setStatus, addNote). Ready in the Widget panel.
```

Add a line only for a real deviation: something you could not build or implement, or a design rule you had to break. Never paste source code.

## References

| Read                            | When                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `references/tool.md`            | you need an action's exact parameters, results or errors                                    |
| `references/api.md`             | the widget keeps records: writing `api.ts`, calling it from the screen, testing operations  |
| `references/data.md`            | the tables: `schema.sql` in the SQLite dialect, changing tables, looking at the data        |
| `references/files.md`           | the widget reads or lists files on the user's computer                                      |
| `references/design.md`          | before writing or restyling UI                                                              |
| `references/maintenance.md`     | changing an existing widget, especially one written before its API existed                  |
| `references/export.md`          | the user wants the widget as a standalone project                                           |
| `references/troubleshooting.md` | a build fails, the window is blank or shows an error, an operation or a fetch fails         |
