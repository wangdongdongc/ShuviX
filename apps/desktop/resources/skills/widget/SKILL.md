---
name: widget
description: "Build, maintain, and export ShuviX Widgets — small, persistent React utilities saved under ~/.shuvix/widgets/<id>/ and surfaced in the right-panel Widget tab. Widgets can also persist data via a built-in PostgREST-style HTTP DB API (no auth, schema-isolated per widget). Trigger when the user wants a JSON formatter, expression playground, regex tester, unit converter, color picker, time-zone helper, base64 encoder, todo list, note pad, bookmark store, log viewer, or anything else they describe as 'a small tool', '小工具', 'mini app', 'widget', '小组件'. Also trigger when the user wants to maintain (extend, refactor, restyle) an existing widget by id, or export one as a standalone Vite project. Drives the `bash` tool to invoke the bundled `shuvix` CLI plus `read`/`write`/`edit` for source files."
---

# Widget

A **Widget** is a persistent mini React app the user can invoke any time from the right panel's Widget tab. It lives at `~/.shuvix/widgets/<id>/`. ShuviX serves it over a per-widget HTTP endpoint that auto-mounts when the user opens it.

## CLI you'll use

`shuvix` is on PATH (injected by ShuviX into the bash tool's spawn env). It's a thin client that talks to the running ShuviX process — **only works while ShuviX is running**.

| Command | What it does |
|---|---|
| `shuvix widget list` | List active widgets (id, name, projectDir, url) |
| `shuvix widget list --archived` | List archived widgets |
| `shuvix widget init <id> --name "Display Name" [--description "..."]` | Scaffold a new widget at `~/.shuvix/widgets/<id>/` and trigger initial build. Returns projectDir + url + buildSuccess + buildErrors. Also auto-grants this session read/write access to the widget dir. |
| `shuvix widget build <id>` | Recompile the widget. Returns url + buildSuccess + buildErrors. The widget's browser panel auto-refreshes via SSE. |
| `shuvix widget export <id> --to <absolutePath>` | Copy the widget into a standalone Vite project at the given path. The path **must** be inside this session's working directory (or a readwrite reference dir) — CLI rejects out-of-sandbox targets. |
| `shuvix widget db-init <id> --sql "<DDL>"` | Install / update the widget's DB schema. Idempotent `CREATE TABLE IF NOT EXISTS ...` DDL recommended. Re-runnable on failure (failed SQL is **not** persisted). Use `--file <path>` for multiline SQL. |
| `shuvix widget db-query <id> --sql "<SQL>"` | Run raw SQL scoped to the widget's own schema (debugging / data inspection). SELECT / INSERT / UPDATE / DELETE / DROP all allowed within scope. Returns psql-style table on stdout. Use `--file <path>` for multiline SQL. |

All commands print machine-readable JSON to stdout on success, plain error text to stderr on failure, and use exit code 0/1 accordingly. Read both — the JSON `url` is what you pass to `shuvix browser open <url>` (see the **browser** skill) to preview the widget inside the right-panel browser tab.

## Workflow — new widget

1. **Pick an id.** Kebab-case with at least one dash, matching `/^[a-z0-9]+(-[a-z0-9]+)+$/`. Examples: `json-formatter`, `cel-validator`, `regex-tester`. Short, descriptive, English only.
2. **Pick a `name` and `description`** *in the user's current ShuviX UI language* — these strings are shown verbatim on the Widget library card. The id stays kebab-case ASCII regardless of language.
3. **Init.** Run `shuvix widget init <id> --name "..." --description "..."`. The output JSON includes `projectDir`, `url`, `files`, `buildSuccess`, optional `buildErrors`.
4. **Implement.** Use `write` / `edit` on files under `<projectDir>`. Entry is `index.tsx`. Sandbox access was auto-granted by `widget init`.
5. **Rebuild.** `shuvix widget build <id>` after each batch of edits. On failure, parse `buildErrors` from JSON, fix, retry.
6. **Open.** Run `shuvix browser open <url>` with the `url` from init/build output. Subsequent rebuilds live-reload via SSE — no need to reopen.
7. **README.** Write a short `README.md` under `<projectDir>` describing what the widget does, main interactions, and known extension points. The next AI maintaining this widget will read it.

## Workflow — maintain existing widget

If the user names an existing widget id, **skip init**:

1. `shuvix widget list` to confirm the id exists and get `projectDir`.
2. `read <projectDir>/README.md` to understand purpose + design intent.
3. `read` the relevant source files.
4. Make edits via `edit` / `write`.
5. `shuvix widget build <id>` — the widget panel auto-refreshes if open.
6. Append a short entry to README.md's "扩展记录" / "Changelog" section (use the user's UI language).

## Workflow — export

`shuvix widget export <id> --to <absolutePath>` copies the widget into a standalone Vite project. The target must be inside this session's working directory. After it succeeds, tell the user:

```
cd <targetPath>
npm install
npm run dev
```

See `EXPORT_NOTES.md` in the target folder for known runtime differences from the in-app preview.

## Critical: entry-file mount block

The host HTML only provides an empty `<div id="root"></div>`. Your `index.tsx` MUST end with:

```tsx
const root = document.getElementById('root')
if (root) createRoot(root).render(<YourComponent />)
```

If you refactor `index.tsx` and drop this block, the page renders blank with no error — and `widget build` reports success because compile succeeded. The scaffold has a "DO NOT DELETE" anchor comment around this block; preserve it.

## Technical stack

- **React 19** + TypeScript, function components with Hooks
- **Tailwind CSS v4** — class names via `className`; `dark:` variant auto-follows ShuviX's theme via `prefers-color-scheme`
- **React Router** — `createHashRouter` from `react-router` for multi-page widgets
- **No other npm packages.** No axios, lodash, date-fns, icon libraries, chart libraries — if you need an icon, use inline SVG; if you need HTTP, use `fetch`. The bundler will fail on unknown imports.

## Persistent storage — DB REST API

Widgets can persist data via a built-in PostgREST-style HTTP API served by the same widget server. **All widgets share a single embedded PostgreSQL (PGlite) instance, but each widget gets its own isolated schema automatically** — you write `CREATE TABLE todos (...)` and `fetch('/w/<id>/db/todos')` with bare table names, the backend rewrites them to scope to the widget's private schema. Two widgets can both have a `todos` table without conflict, but **a widget cannot read another widget's data**.

### Step 1 — define schema (CLI, once per design)

Use `shuvix widget db-init <id>` **after** `widget init`, **as a separate step**. If the DDL fails, fix and re-run — failed SQL is never persisted.

```bash
shuvix widget db-init my-todo --sql "
CREATE TABLE IF NOT EXISTS todos (
  id        serial PRIMARY KEY,
  text      text   NOT NULL,
  done      bool   NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todos_done_idx ON todos(done);
"
```

Always use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so the DDL is idempotent — ShuviX re-runs it automatically when the widget is registered (e.g. after restart) so your schema is self-healing.

For multi-line DDL prefer `--file <path>` to avoid shell-escaping pain:

```bash
shuvix widget db-init my-todo --file schema.sql
```

### Step 2 — call the API from widget code

Endpoint shape: `/w/<id>/db/<table>` (use `import.meta.env` or hardcode the widget id you were given). Same origin as the widget's HTML — no auth, no CORS dance.

```ts
// Read with filters / ordering / pagination
const res = await fetch('/w/my-todo/db/todos?done=is.false&order=created_at.desc&limit=20')
const rows = await res.json()      // → array of row objects

// Insert one or many
await fetch('/w/my-todo/db/todos', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'buy milk' })
})
// or body: [{ text: 'a' }, { text: 'b' }]

// Update — WHERE clause REQUIRED (no "update all" footgun)
await fetch('/w/my-todo/db/todos?id=eq.7', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ done: true })
})

// Delete — WHERE clause REQUIRED
await fetch('/w/my-todo/db/todos?id=eq.7', { method: 'DELETE' })
```

**All write methods return the affected rows as a JSON array** (PostgREST `Prefer: return=representation` default). Errors come back as `{ "code": "...", "message": "..." }` with 4xx (bad query / constraint) or 5xx (internal).

### URL operator cheat sheet

PostgREST-compatible subset. Each filter is `?column=operator.value`; multiple filters AND together.

| Operator | SQL meaning | Example |
|---|---|---|
| `eq` | `=` | `?id=eq.5` |
| `neq` | `<>` | `?status=neq.archived` |
| `gt` `gte` `lt` `lte` | `> >= < <=` | `?score=gte.80&score=lt.100` |
| `like` `ilike` | LIKE / ILIKE (case-insensitive); `*` is wildcard | `?name=ilike.*foo*` |
| `in` | `IN (...)` | `?status=in.(active,pending)` |
| `is` | `IS NULL/TRUE/FALSE/UNKNOWN` | `?deleted_at=is.null` |

Control parameters (not filters):
- `?select=col1,col2` — column projection (default `*`)
- `?order=col.desc.nullslast,col2.asc` — multi-column sort, optional `nullsfirst`/`nullslast`
- `?limit=20&offset=40` — pagination

### Available PostgreSQL extensions

Pre-loaded and usable in DDL / queries — no extra step needed:

- **`pg_trgm`** — trigram fuzzy search: `WHERE text % 'searchterm'` or GIN index `USING gin (text gin_trgm_ops)`
- **`vector`** — embedding columns: `embedding vector(1536)`, similarity `<->`, `<#>`, `<=>`
- Others available: `hstore`, `ltree`, `citext`, `tablefunc`, `cube`, `earthdistance`, `intarray`, `unaccent`, `fuzzystrmatch`

### Debugging / inspecting data

Use `shuvix widget db-query <id> --sql "SELECT ..."` during development to see what's actually stored:

```bash
shuvix widget db-query my-todo --sql "SELECT id, text, done FROM todos ORDER BY id DESC LIMIT 10"
shuvix widget db-query my-todo --sql "DELETE FROM todos WHERE done"   # housekeeping
```

The SQL is auto-scoped to the widget's schema; write bare table names like `todos`, **never** reference another widget's schema (`widget_other.foo`) — that's blocked.

### Not supported (one-line refusals — don't try these)

- Embedded resources `?select=*,fk(*)` — issue two requests instead
- Logical operators `and()`, `or()` nesting — keep filters AND-only
- RPC endpoints `/rpc/funcname` — call SQL through `db-query` instead
- Upsert / `on_conflict` / `Prefer` headers — use PATCH after a SELECT
- Cross-widget data access — widgets are isolated; communicate through the user, not the DB

### Decide first: does this widget need persistence?

If the widget is **stateless** (JSON formatter, regex tester, base64 encoder, calculators, date helpers) — **don't** call `db-init`, just use `useState`. The DB API is for widgets that store user-generated records across sessions: notes, todos, bookmarks, history, snippets, saved configs.

## ⚠️ DESIGN GUIDE — follow this strictly

Widgets are **dense, single-purpose utilities**, NOT landing pages or marketing sites. Mental model: menu-bar app, browser extension popup, VSCode sidebar view.

### Layout
- **No hero sections.** No big welcome title, no "Get Started" button, no emoji at `h1` size. Get straight to the task.
- **Fill the viewport.** The user opens the widget to *use* it — make the working area the main content. No empty space below a small card.
- **Use width.** Content max-width ~`max-w-3xl`, `mx-auto`, with `p-3` or `p-4` padding. NOT `max-w-sm mx-auto flex items-center justify-center min-h-screen`.
- **Vertical stacking** for narrow panels; use `grid` / `flex-row` only when the data warrants columns.

### Typography
- Body: `text-xs` (12px) or `text-sm` (14px). **Never** use anything larger than `text-base` (16px) for headings.
- Weight: `font-medium` / `font-semibold`. Avoid `font-bold` in body text.
- Code/data/tokens: `font-mono text-xs`.

### Spacing (tight)
- Padding: `p-2.5`, `p-3`, `p-4`. Avoid `p-6` / `p-8`.
- Gap: `gap-1.5`, `gap-2`, `gap-3`. Avoid `gap-8`.
- Margin: `mt-1`, `mt-2`, `mt-4`. Avoid `my-12`.

### ⚠️ Dark mode is MANDATORY
Every color utility MUST have a `dark:` variant. Widgets auto-follow ShuviX's theme.

**Required palette (copy-paste these, don't invent):**

| Purpose | Light | Dark |
|---|---|---|
| Page bg | `bg-white` | `dark:bg-neutral-950` |
| Surface / card bg | `bg-neutral-50` | `dark:bg-neutral-900` |
| Hover bg | `hover:bg-neutral-100` | `dark:hover:bg-neutral-800` |
| Border | `border-neutral-200` | `dark:border-neutral-800` |
| Text primary | `text-neutral-900` | `dark:text-neutral-100` |
| Text secondary | `text-neutral-600` | `dark:text-neutral-400` |
| Text tertiary / muted | `text-neutral-400` | `dark:text-neutral-500` |
| Accent text | `text-violet-600` | `dark:text-violet-400` |
| Accent solid btn | `bg-violet-600 hover:bg-violet-500 text-white` | same |
| Accent ring | `ring-violet-500/30` `focus:border-violet-500` | same |
| Success | `text-emerald-600` | `dark:text-emerald-400` |
| Error | `text-rose-600` | `dark:text-rose-400` |
| Warning | `text-amber-600` | `dark:text-amber-400` |

### Decoration
- Rounded: `rounded-md` (6px) or `rounded-lg` (8px). **Never** `rounded-2xl` / `rounded-3xl` except for pill badges or avatars.
- Shadows: **none by default.** Only `shadow-sm` on floating popovers / dropdowns. **Never** `shadow-lg` / `shadow-xl`.
- Transitions: `transition-colors` on interactive elements. No complex motion.

### Interaction patterns
- **Keyboard first.** Enter runs/submits. Escape clears. `Cmd/Ctrl+Enter` for secondary if natural.
- **Live compute.** Use `useMemo` / `useDeferredValue` to update result as the user types. Don't add artificial loading spinners for local work.
- **Copy button** on any generated output (icon-only, top-right of the output block).
- **Inline errors** under the relevant field (small, rose-600/dark:rose-400). Not modals.
- **Monospace** for inputs expecting code/data/JSON: `font-mono text-xs`.

### Component patterns (use these shapes)

Input:
```tsx
<input
  className="w-full px-2.5 py-1.5 text-sm rounded-md border
             border-neutral-200 dark:border-neutral-800
             bg-neutral-50 dark:bg-neutral-900
             text-neutral-900 dark:text-neutral-100
             placeholder:text-neutral-400 dark:placeholder:text-neutral-600
             focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
/>
```

Textarea (for code/JSON):
```tsx
<textarea
  className="w-full px-2.5 py-2 font-mono text-xs rounded-md border
             border-neutral-200 dark:border-neutral-800
             bg-neutral-50 dark:bg-neutral-900
             focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500
             resize-none"
  rows={8}
/>
```

Primary button:
```tsx
<button className="px-3 py-1.5 text-xs font-medium rounded-md
                   bg-violet-600 hover:bg-violet-500 text-white
                   transition-colors">
  Run
</button>
```

Secondary / ghost button:
```tsx
<button className="px-3 py-1.5 text-xs font-medium rounded-md
                   border border-neutral-200 dark:border-neutral-800
                   text-neutral-700 dark:text-neutral-300
                   hover:bg-neutral-100 dark:hover:bg-neutral-800
                   transition-colors">
  Clear
</button>
```

Card / result panel:
```tsx
<div className="rounded-md border border-neutral-200 dark:border-neutral-800
                bg-white dark:bg-neutral-950 p-3">
  …
</div>
```

Code / output block:
```tsx
<pre className="font-mono text-xs text-neutral-700 dark:text-neutral-300
                bg-neutral-50 dark:bg-neutral-900 rounded-md p-3
                overflow-auto max-h-80">{result}</pre>
```

Badge / tag:
```tsx
<span className="px-1.5 py-0.5 rounded text-[10px] font-medium
                 bg-violet-500/10 text-violet-600 dark:text-violet-400">
  parsed
</span>
```

### ❌ Anti-patterns — DO NOT produce

- Large hero banner with centered title on empty page
- "Welcome to X" / "Get Started" screens / onboarding steps
- Emoji at heading size (🎉, 🚀, ✨ as 2xl)
- `flex items-center justify-center min-h-screen` with a narrow `max-w-sm` card
- Heavy shadows (`shadow-xl`, `shadow-2xl`), thick borders (`border-2`)
- Decorative gradients (`bg-gradient-to-br from-purple-500`)
- Card-inside-card-inside-card nesting
- Loading spinners for operations finishing in < 200ms
- Hardcoded single-mode palette (e.g. only `bg-slate-900 text-slate-100` without light counterpart)
- Any `import` from packages other than `react`, `react-dom`, `react-router`

## Troubleshooting

- **`shuvix: command not found`** → you're in a shell ShuviX didn't launch (manual terminal, SSH session). The CLI is on PATH only inside ShuviX-spawned shells. Tell the user.
- **`Cannot find ~/.shuvix/cli-token` / `Cannot reach ShuviX`** → ShuviX isn't running, or this session was started before ShuviX. Ask the user to relaunch ShuviX.
- **`widget init` succeeds but `buildSuccess: false`** → scaffold compiled bad code (rare). Read `buildErrors` from the JSON, fix `index.tsx`, run `widget build <id>`.
- **Browser panel shows blank page after a refactor** → you removed the `createRoot(root).render(...)` mount block at the bottom of `index.tsx`. Add it back.
