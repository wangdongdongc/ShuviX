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
  `src/` (we consume source), standalone **build** `devDependencies` + `scripts` stripped.
  The `test` script is back (2026-09-18) and the root `npm run test` chains it: the package's
  own 9 test files had been passing but running nowhere, and they cover in-tree customizations
  (wiki-links, tables) alongside upstream's. They need happy-dom + `@vitejs/plugin-react`, which
  the desktop vitest config cannot give them (`environment: 'node'`, no react plugin), so this
  package keeps its own `vitest.config.ts` rather than folding into that one. A `typecheck`
  script is back for the same reason: `apps/desktop/tsconfig.web.json` **excludes**
  `packages/atomic-editor/src/**/__tests__/**`, so without it these files compile under no gate
  at all — which is how a test file can go green while not type-checking.
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

- `src/mermaid-blocks.ts` — **ShuviX-added file** (not upstream): mermaid live preview widget +
  the `renderMermaid` façade (lazy module load, theme-keyed SVG cache, serialized `initialize`),
  also consumed by the app's ChartView. Rendered SVG is passed through
  `sanitizeRenderedSvg` (`@shuvix/chat-protocol/utils/svgSanitize`) before it leaves this module —
  consumers inject it via `innerHTML` into the privileged renderer, and mermaid's
  `click <node> href "javascript:…"` directive otherwise carries a `javascript:` URL straight
  into the DOM. If upstreaming the widget, drop that import (or vendor the sanitizer) to keep
  the package dependency-free — the same applies to the two files below.

- `src/fenced-preview.ts` — **ShuviX-added file** (not upstream): the reveal machinery shared by
  the two fenced live previews (cursor inside the fence → raw source, outside → rendered widget),
  plus the pointer-down freeze, the focus mirror, the tree-growth re-run and the doc-change
  pre-filter. Extracted from `mermaid-blocks.ts` when `svg-blocks.ts` arrived: those four are
  exactly the parts a second copy gets subtly wrong without anyone noticing.

- `src/svg-blocks.ts` — **ShuviX-added file** (not upstream): ```svg live preview — hand-written
  SVG rendered in place, the same carrier chat draws figures from. Rendering is one synchronous
  `sanitizeAuthoredSvg` call (`@shuvix/chat-protocol/utils/svgSanitize`), the strict tier: the
  author controls every tag, so `<style>`, `<foreignObject>` and anything that would fetch are
  refused. Frame judgement (is this source renderable yet?) comes from
  `@shuvix/chat-protocol/utils/svgFence`, shared with the chat renderer. No light card under the
  figure, unlike mermaid: colors come from `--viz-*` / `--theme-*` tokens, so it must sit on the
  editor's own surface to follow the theme.

- `src/comment-blocks.ts` — **ShuviX-added file** (not upstream): HTML comment (`<!-- … -->`)
  handling for the live preview. In the read-only viewer comments are removed entirely (block
  comments line-and-all, leaving no blank gap; inline ones hidden per line segment); editable
  documents dim them instead of hiding, so the caret never edits invisible text. Implemented as
  a StateField (CM6 won't take block-replace decorations from a ViewPlugin), reusing the
  upstream `tree-progress` plugin; no `@shuvix/*` imports, so freely upstreamable. Wiring, in
  upstream files: `src/index.ts` exports `commentBlocks`, `src/AtomicCodeMirrorEditor.tsx` adds
  it to the default extension list, and `styles/inline-preview.css` adds the
  `.cm-atomic-comment` dim rule.

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
