# Changing an existing widget

## Finding it

- `list` gives the id, the folder and what this conversation may do with it. An archived widget is not listed: tell the user to restore it from Settings → Archived first.
- If its folder exists but it is not listed, its `widget.json` is missing or corrupt: report that instead of repairing it.
- Ask which widget the user means when the request fits more than one.

## Before the first edit

`build` with `message: "chore: baseline before <task>"`:

- the first time in a conversation it asks the user to let this conversation change the widget; allowed, you may edit its folder too;
- it tells you whether the widget builds as it stands, so you do not take the blame for a break that was already there;
- if it builds, it commits whatever was already in the folder (the user's own edits, a half-finished earlier session), so your change lands as a commit of its own. A widget that predates version control gets its repository here.

If that build fails, nothing is committed and the widget was already broken. Fixing it is part of the job only when the user asked for it or your change cannot land without it; otherwise say so.

Then read `README.md`, `api.ts` and every file you are about to change, and follow their conventions: naming, file layout, how state is held.

## Making the change

- Targeted `edit`s, not rewrites. Keep the mount block and its "DO NOT DELETE" comment.
- Operations: add new ones freely; change or remove an existing one only when asked (`api.md`). Table changes follow `data.md`.
- Add one line to the README's changelog, in the README's language.
- `build` with a `message` saying what changed; `call` what you changed with `dry_run: true`; `preview` if its look changed. Do not open it for the user (`SKILL.md`, rule 8).

## Widgets written before the API

An older widget has no `api.ts`: its screen reads and writes `/w/<id>/db/<table>` directly, its data is in a database shared by all older widgets, and agents cannot use it (`list` shows `storage="legacy-postgres"`). When the user asks to update one, or your change touches its data, upgrade it:

1. **Baseline build**, as above.
2. **Read its tables** with `sql` and `legacy: true`: `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`, and look at a few rows of each.
3. **Write the new version in one go**: `schema.sql` in the SQLite dialect (`data.md`), `api.ts` with operations for everything the screen did through `/db` (`api.md`), and the screen rewritten to call them with `shuvix/widget` (every `fetch('/w/<id>/db/…')` goes).
4. **`build`.** The first successful build of a widget with `api.ts` moves it to its own SQLite database, which starts empty; the result says so. If the build fails, nothing moved: fix it and build again.
5. **Create the tables**: `sql` with the text of `schema.sql`.
6. **Copy the rows**, table by table: read them as JSON with `sql`, `legacy: true` and `SELECT json_agg(t) FROM <table> t`, then insert them with `sql`, e.g. `INSERT INTO books (id, title, done) SELECT value->>'id', value->>'title', value->>'done' FROM json_each('<the JSON, with every ' doubled>')`. Booleans become `0` / `1`, timestamps ISO 8601 text, arrays and objects JSON text. Split a large table into batches.
7. **Check**: the row counts match (`SELECT count(*) …` on both sides), the operations work (`call`), the screen shows the data (`preview`).
8. Report what you converted. The old data stays in the shared database until the widget is deleted, so a mistake in step 6 can be redone.

Also bring in line anything that breaks when ShuviX is opened from a browser. Search the widget's `.ts` / `.tsx` files for:

```
shuvix-media:|file://|127\.0\.0\.1|localhost:|localStorage|sessionStorage|indexedDB|document\.cookie
```

| Found                                                       | Change to                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix-media:///abs/path` (or built as `` `shuvix-media://${p}` ``) | `fileUrl('/abs/path')` / `fileUrl(p)` from one URL module (`files.md`); the path inside is what follows `shuvix-media://`, decoded |
| `file:///…`                                                 | the same `fileUrl(…)`                                                                                                             |
| `http://127.0.0.1:<port>/w/<id>/…` or `localhost:<port>`    | the path alone: `/w/<id>/…`                                                                                                       |
| `localStorage` / `sessionStorage` / `IndexedDB` / cookies   | a table and an operation (`api.md`). Nothing to migrate: the widget's address changes port on every ShuviX start, so browser storage never outlived a restart |
| a README line saying the design rules live in the Widget Builder agent | a line saying they live in the built-in skill `builtin:widget`                                                    |

A hard-coded home folder (`/Users/<name>/…`) can stay, but `~/…` is better (`files.md`).

Many older widgets were laid out for a window of their own. When updating one, preview it and make it work in the panel, a wide window and on a phone (`design.md`, "Where it runs").

Widgets written before themes color with Tailwind's palette in `dark:` pairs. They still work in light and dark, but they ignore the user's theme. When you update one, move its colors to the theme names (`design.md`, "Colors follow the app's theme"). Search for:

```
\b(bg|text|border|divide|ring|outline|fill|stroke|placeholder)-(white|black|(neutral|gray|slate|zinc|stone|violet|purple|indigo|emerald|rose|red|amber)-[0-9]+)|#[0-9a-fA-F]{3,8}\b
```

| Found                                                   | Change to                                         |
| ------------------------------------------------------- | ------------------------------------------------- |
| `bg-white dark:bg-neutral-950`                          | `bg-page`                                         |
| `bg-neutral-50 dark:bg-neutral-900`                     | `bg-surface`                                      |
| `hover:bg-neutral-100 dark:hover:bg-neutral-800`        | `hover:bg-hover`                                  |
| `border-neutral-200 dark:border-neutral-800`            | `border-line`                                     |
| `text-neutral-900 dark:text-neutral-100`                | `text-fg`                                         |
| `text-neutral-600 dark:text-neutral-400`                | `text-fg-muted`                                   |
| `text-neutral-400 dark:text-neutral-500`                | `text-fg-subtle`                                  |
| `text-violet-600 dark:text-violet-400`                  | `text-accent`                                     |
| `bg-violet-600 hover:bg-violet-500 text-white`          | `bg-accent hover:bg-accent-hover text-on-accent`  |
| `ring-violet-500/30`, `focus:border-violet-500`         | `ring-accent/30`, `focus:border-accent`           |
| `text-emerald-600 dark:text-emerald-400` (rose, amber)  | `text-success` (`text-danger`, `text-warning`)    |
| hex colors in a chart's options                         | `themeColor('viz-1')` … with `useTheme()`         |

Other shades map to the nearest row. Then `preview` with `theme: "light"` and `"dark"`: anything still fixed shows up on one of them.
