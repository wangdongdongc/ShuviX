---
name: widget
description: "How to build, change, export and debug ShuviX Widgets — persistent mini React apps the user reopens from the Widget panel: the `shuvix widget` CLI lifecycle, the closed dependency set, storing records in the widget's own database, reading files on the user's computer in a way that also works when ShuviX is used from a browser, the design guide for the panel, a wide window and a phone, checking the layout with screenshots, and reworking an older widget. Load this when the user asks for a widget, mini app, 小工具 or 小组件, or a small tool they will come back to, and before changing or debugging an existing widget."
---

# ShuviX Widgets

A widget is a small React app in its own directory under ShuviX's widgets folder. ShuviX bundles it and serves it under `/w/<id>/`. The user opens it from the Widget tab of the right panel, where it runs inside the panel or in its own window (a browser tab when they use ShuviX remotely). Each widget has its own database schema and its own git repository. ShuviX records a commit after every successful build, so you never run git yourself.

This file is the whole workflow. The references hold the details; each row of the index at the end says when to read one.

## When a widget is the answer

- The user calls it a widget, mini app, 小工具 or 小组件, or wants a small tool they will reopen: a formatter, converter, tracker, a dashboard over their own files. A one-off question gets an answer or a script, not a widget.
- One widget per purpose. A change to an existing widget is a change to that widget, never a second one.

## Rules that always hold

1. **Lifecycle goes through the `shuvix` CLI**, which is on PATH in every shell ShuviX starts. `shuvix widget build` is the only build: never install packages, never run npm, npx or a bundler.
2. **Closed dependency set**: React 19 with TypeScript, Tailwind CSS v4 through `className` (`dark:` follows the app theme), and React Router (`createHashRouter` from `react-router`) only for a genuinely multi-page widget. Nothing else resolves; an unknown import fails the build. Icons are inline SVG, HTTP is `fetch`, dates are `Intl` and `Date`.
3. **`index.tsx` ends with the mount block**, inside the scaffold's "DO NOT DELETE" comment:
   ```tsx
   const root = document.getElementById('root')
   if (root) createRoot(root).render(<App />)
   ```
4. **Stay inside the widget's own directory** (`projectDir`). Never edit or delete `widget.json`: it is the widget's identity, and ShuviX rewrites it itself.
5. **Everything the widget fetches lives under its own `/w/<id>/`**: `db/<table>` for its records (`references/data.md`), `fs/file` and `fs/list` for files on the user's computer (`references/files.md`). Never write `shuvix-media://`, `file://` or `http://127.0.0.1:<port>`: they only work on the desktop, and the widget breaks when it is opened from a browser.
6. **Persistent state goes in the database**, not `localStorage`, `IndexedDB` or cookies: opened from a browser, the widget runs sandboxed without an origin of its own, where those are unavailable.
7. **It works in the panel, a wide window and on a phone.** The same widget opens in the right panel (300–420px wide), in its own window or a browser tab (up to full screen), and in a phone's browser (touch). **Dark mode is mandatory.** How to lay it out for all three, and the rest of the look, are in `references/design.md`: read it before writing UI.
8. **Never report a widget that has not built.** Finish with a green build. **Do not open it for the user**: say it is ready in the Widget panel, by its name. A build reloads the widget wherever it is already open. Run `shuvix widget open <id>` only when the user asks you to open it.

## A new widget

1. **Id**: lowercase ASCII kebab-case with at least one dash (`/^[a-z0-9]+(-[a-z0-9]+)+$/`), e.g. `json-formatter`, whatever the user's language. **`name` and `description`** in the user's language; they show verbatim on the widget's card and in its window title.
2. `shuvix widget init <id> --name "…" --description "…"`. Work under the returned `projectDir`; the entry file is `index.tsx`.
3. **Before writing code**, decide whether it stores records (`references/data.md`; if so, write and install `schema.sql` now) and whether it reads the user's files (`references/files.md`).
4. Implement it, following `references/design.md`.
5. Write a short `README.md` in the language of `name`: what it does, its main interactions, its data model, the files it reads, its extension points.
6. `shuvix widget build <id> --message "<one-line summary>"`. On `buildSuccess: false`, fix `buildErrors` and build again.
7. `shuvix widget preview <id>` and `read` the screenshots; fix, build and preview again until it looks right at every size (`references/design.md`, "Check it").
8. Report that it is ready in the Widget panel (rule 8).

## Changing an existing widget

1. `shuvix widget list` to find its id and `projectDir`.
2. `shuvix widget build <id> --message "chore: baseline before <task>"` **before touching anything**: it shows whether the widget builds, gives this conversation access to its directory, and, if it builds, commits whatever was already there, so your change lands as its own commit.
3. Read `README.md` and every file you are about to change, and follow their conventions. A widget written before this skill existed may need more than the change you were asked for: read `references/maintenance.md`.
4. Change it with targeted `edit`s and add one line to the README's changelog, in the README's language.
5. `shuvix widget build <id> --message "<what changed>"` and fix any errors. If you changed what it looks like, preview it (`references/design.md`, "Check it"). Then report (rule 8).

Never rename, repurpose, archive or delete a widget the user did not ask about.

## Reporting

Reply with the result only, in a few lines:

```
json-formatter ("JSON 格式化") — formats and validates pasted JSON, with error position and copy button. Stateless. Window opened.
```

Add a line only for a real deviation: something you could not build or implement, or a design rule you had to break. Never paste source code.

## References

| Read                            | When                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `references/cli.md`             | you need a command's exact options, output fields or errors                             |
| `references/data.md`            | the widget stores records: `schema.sql`, the REST API, changing tables                  |
| `references/files.md`           | the widget reads or lists files on the user's computer                                  |
| `references/design.md`          | before writing or restyling UI                                                          |
| `references/maintenance.md`     | changing an existing widget, especially one written before this skill                   |
| `references/export.md`          | the user wants the widget as a standalone project                                       |
| `references/troubleshooting.md` | a build fails, the window is blank or shows an error, `shuvix` is missing, a fetch fails |
