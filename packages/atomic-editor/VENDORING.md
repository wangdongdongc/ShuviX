# Vendored: @atomic-editor/editor

This package is a **vendored copy** of [kenforthewin/atomic-editor](https://github.com/kenforthewin/atomic-editor)
(MIT, © Kenny Bergquist — see `LICENSE`), pulled into the ShuviX monorepo via **git subtree**
so we can customize the editor at the source level (i18n, native table menu, …).

- **Upstream**: https://github.com/kenforthewin/atomic-editor
- **Vendored at**: tag `v0.4.3`
- **Prefix**: `packages/atomic-editor`
- **Consumed as source** (not built): the renderer imports `@shuvix/atomic-editor` via TS/Vite
  path aliases, same model as `@shuvix/chat-ui`. There is no build step here.

## Local modifications vs upstream

Keep this list current — it's what makes future merges predictable.

- `package.json` — renamed to `@shuvix/atomic-editor`, `private: true`, `exports` point at
  `src/` (we consume source), standalone build/test `devDependencies` + `scripts` stripped.
- `VENDORING.md` — this file (not in upstream).
- `src/table-widget.ts` — `findTableRange` iterate callback: made both non-`false` paths
  return `undefined` explicitly. Behavior-identical; satisfies ShuviX's stricter
  `noImplicitReturns` (upstream's own tsconfig doesn't enable it). Upstreamable.
- `src/table-widget.ts` + `src/index.ts` — **table menu `renderMenu` extension point**
  (additive, upstreamable): `TablesConfig.renderMenu` + `tableContextMenu()` + a
  `tableRenderMenuFacet`; cell menu entries gained stable `id`/`group`. When a renderer is
  configured, `openCellMenu` delegates presentation to it (we render a native OS menu with
  localized labels in the app); otherwise the built-in DOM menu is unchanged. Exported types:
  `TableMenuItem`, `TableMenuItemId`, `TableMenuRenderer`. Good upstream PR candidate.

Prefer **isolating changes in new files** over editing upstream files in place — new files never
conflict on pull. Edit core files only when unavoidable, and note them above.

## Pull upstream updates

```bash
# from the workspace root, on a clean tree
git subtree pull --prefix=packages/atomic-editor \
  https://github.com/kenforthewin/atomic-editor.git <tag-or-branch> --squash
```

`package.json` (and any other locally-modified upstream file) may conflict — resolve by
re-applying the modifications listed above. Re-run `npm install` afterwards.

> **Which ref to pull?** `v0.4.3` is the latest *real* release (npm dist-tag `latest`). Newer
> work lives on `main` (a few unreleased commits past 0.4.3). Pull from `main`, or from the next
> real tag when one ships. After any update, verify `LivePreviewEditor.tsx` still type-checks
> against the editor's exported surface.
>
> ⚠️ Ignore the `v1.26.0` / `v1.26.1` git tags — they are **stale/dangling** (point to commits
> that no longer exist in the repo; GitHub's API returns "No commit found", and they were never
> published to npm). They are NOT newer than 0.4.3; git's alphabetical tag sort just lists them last.

## Contribute changes back

Generic improvements (e.g. configurable table-menu labels) are worth upstreaming so we carry
less local diff. Fork upstream on GitHub, then:

```bash
git subtree push --prefix=packages/atomic-editor <your-fork-url> <branch>
```

…and open a PR. (The extracted history can be messy — many prefer to redo the change in a fresh
upstream clone for clean PR commits.)
