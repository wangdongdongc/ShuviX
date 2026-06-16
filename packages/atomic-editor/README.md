# Atomic Editor

**Obsidian-style live preview for [CodeMirror 6](https://codemirror.net/), in React.**

[![npm version](https://img.shields.io/npm/v/@atomic-editor/editor?color=7c3aed&labelColor=2d2d2d)](https://www.npmjs.com/package/@atomic-editor/editor)
[![license](https://img.shields.io/npm/l/@atomic-editor/editor?color=7c3aed&labelColor=2d2d2d)](./LICENSE)

A markdown editor where formatting renders as you type — headings, bold,
tables, images, task lists — while the text underneath stays plain markdown.
The document you read is the document you edit: no split preview, no mode
toggle, and copy / save / round-trip behave exactly like a plain textarea
full of markdown.

It's the writing surface behind
[**Atomic**](https://github.com/kenforthewin/atomic), a personal knowledge
base — extracted to stand on its own, and hardened on real user documents.

[**Try the live demo →**](https://kenforthewin.github.io/atomic-editor/)

## Features

- **Live preview, not a preview pane.** Headings, emphasis, links, images,
  and tables render inline; the raw syntax appears only on the line your
  cursor is on, then tucks itself away when you move on.
- **Raw markdown is the source of truth.** Every decoration is view-only, so
  copy, save, and round-trip through any other markdown tool are byte-for-byte
  identical to a plain textarea.
- **Virtualized and layout-stable.** CM6 renders only the viewport, and lines
  never reflow when you click into them — open a 500-page document and scroll
  stays smooth, even on iOS.
- **WYSIWYG tables.** Click a cell to edit in place; wide tables scroll
  horizontally inside a contained wrapper instead of stretching the page.
- **Wiki links.** `[[target]]` / `[[target|label]]` with async resolution,
  autocomplete, and click-to-open — for knowledge-base-style cross-linking.
- **Smart lists.** Enter continues tight bullets and task checkboxes, Enter on
  an empty item dedents, and `- [ ]` becomes a real, clickable checkbox.
- **Syntax-highlighted code** for 20+ languages, each grammar lazy-loaded the
  first time a fence uses it so unused languages never hit the wire.
- **Themed with CSS variables** — dark by default, light via a single
  `data-theme="light"` attribute, every color overridable.
- **Minimal find panel** (Ctrl/Cmd+F) styled to match the editor.

## Install

```bash
npm install @atomic-editor/editor \
  @codemirror/state @codemirror/view @codemirror/commands \
  @codemirror/autocomplete @codemirror/language @codemirror/search \
  @codemirror/lang-markdown \
  @lezer/common @lezer/highlight \
  react react-dom
```

The CodeMirror and React packages are declared as **peer dependencies**
rather than regular deps. You install them alongside the editor so
your bundler resolves a single shared copy — two copies of
`@codemirror/state` in one bundle would silently break the editor's
state-field identity checks.

Fenced-code language grammars (`@codemirror/lang-javascript`,
`@codemirror/lang-python`, etc.) are **optional peers** — install only
the ones you want highlighted. See
[Syntax highlighting](#syntax-highlighting) below.

## Use

```tsx
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import '@atomic-editor/editor/styles.css';

function App() {
  return (
    <AtomicCodeMirrorEditor
      markdownSource={'# Hello\n\nA paragraph.'}
      onMarkdownChange={(md) => console.log(md)}
      onLinkClick={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
    />
  );
}
```

The editor fills its parent — wrap it in a height-bounded flex or grid
container.

### Imperative handle

Pass a ref if you need to drive the editor from outside — e.g. wire
your own toolbar buttons, or open the search panel from a global
keybinding:

```tsx
import { useRef } from 'react';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '@atomic-editor/editor';

function App() {
  const editor = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  return (
    <>
      <button onClick={() => editor.current?.openSearch()}>Search</button>
      <AtomicCodeMirrorEditor
        markdownSource={'…'}
        editorHandleRef={editor}
      />
    </>
  );
}
```

Methods: `focus`, `undo`, `redo`, `openSearch(query?)`, `closeSearch`,
`revealText(query)`, `isSearchOpen`, `getMarkdown`, `getContentDOM`.

### Arriving from a search result

Two props drop the user near a relevant paragraph on mount:

- **`initialSearchText`** opens the search panel pre-filled with the
  query. Full navigation surface — arrow keys to step through matches,
  close to dismiss. Good when the user explicitly invoked find.
- **`initialRevealText`** does a less intrusive scroll-into-view with
  a 3.2 s fade-out highlight on the first match — no panel, no cursor
  move. Good for "I clicked a search result, take me to the paragraph
  it came from".

Both accept `string | null`. The reveal matcher falls back
progressively — exact, whitespace-collapsed, individual lines, then
truncated prefixes (140 and 80 chars) — so hits still resolve when
the query came from an LLM-massaged snippet that doesn't match the
source byte-for-byte. For post-mount reveals, call
`editorHandle.revealText(query)` via the imperative handle.

The fade highlight uses CSS variables
`--atomic-editor-initial-reveal-bg` and
`--atomic-editor-initial-reveal-bg-strong`; override to theme the
peak and settled colors independently of the main search-match
palette.

## Syntax highlighting

Fenced code blocks are plain monospace by default. To enable
highlighting, pass a `codeLanguages` array. `@codemirror/lang-markdown`
dynamically imports each grammar the first time a fence uses it, so
large lists don't bloat the initial bundle.

### Option 1: use the curated list (~20 languages)

```bash
# Install the lang-* peers you want highlighted.
npm install \
  @codemirror/lang-javascript @codemirror/lang-python \
  @codemirror/lang-rust @codemirror/lang-go @codemirror/lang-html \
  @codemirror/lang-css @codemirror/lang-json @codemirror/lang-yaml \
  @codemirror/legacy-modes  # ruby/swift/shell/toml/dockerfile
```

```tsx
import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';

<AtomicCodeMirrorEditor
  markdownSource={'…'}
  codeLanguages={ATOMIC_CODE_LANGUAGES}
/>
```

See [`src/code-languages.ts`](./src/code-languages.ts) for the full
list (JavaScript, TypeScript, Python, Go, Rust, Ruby, Java, C, C++,
PHP, Swift, Shell, SQL, HTML, CSS, XML, JSON, YAML, TOML, Dockerfile,
Markdown).

### Option 2: bring your own

```tsx
import { LanguageDescription } from '@codemirror/language';
import { python } from '@codemirror/lang-python';

const codeLanguages = [
  LanguageDescription.of({
    name: 'Python',
    alias: ['py'],
    extensions: ['py'],
    load: () => Promise.resolve(python()),
  }),
];

<AtomicCodeMirrorEditor markdownSource={'…'} codeLanguages={codeLanguages} />
```

## Wiki links

`[[target]]` and `[[target|label]]` links — the way Atomic and Obsidian
cross-link notes — ship as a composable extension. It renders labeled links,
resolves bare targets asynchronously (to show a real title and a
resolved / missing state), opens links on click, and offers autocomplete as
soon as you type `[[`:

```tsx
import { AtomicCodeMirrorEditor, wikiLinks } from '@atomic-editor/editor';

<AtomicCodeMirrorEditor
  markdownSource={'See [[atom-42|the design doc]] for details.'}
  extensions={[
    wikiLinks({
      suggest: async (query) => store.search(query),     // autocomplete source
      resolve: async (target) => store.resolve(target),  // label + status for bare links
      onOpen: (target) => router.open(target),           // click / Cmd-click to navigate
    }),
  ]}
/>;
```

Draft links stay editable while the cursor is inside them; resolution is
debounced and cached. See [`src/wiki-links.ts`](./src/wiki-links.ts) for the
full config — custom serialization, resolver policies, suggestion limits, and
the `WikiLinkSuggestion` / `WikiLinkResolvedTarget` types.

## Theming

Every color, font, and size reads from a CSS custom property with an
inline fallback. Override on any ancestor of the editor.

The package ships a **light variant** that activates whenever
`data-theme="light"` is set on an ancestor — including `<html>` or
`<body>`. The dark defaults remain unchanged; the light block just
re-maps the same variables.

```html
<html data-theme="light">…</html>
```

| Variable                              | Dark default (auto-light on `[data-theme="light"]`) |
| ------------------------------------- | --------------------------------------------------- |
| `--atomic-editor-font`                | system sans                                         |
| `--atomic-editor-font-mono`           | system mono                                         |
| `--atomic-editor-body-size`           | `1.0625rem`                                         |
| `--atomic-editor-body-leading`        | `1.7`                                               |
| `--atomic-editor-measure`             | `70ch`                                              |
| `--atomic-editor-fg`                  | `#dcddde`                                           |
| `--atomic-editor-fg-muted`            | `#888`                                              |
| `--atomic-editor-fg-faint`            | `#666`                                              |
| `--atomic-editor-bg`                  | `#1e1e1e`                                           |
| `--atomic-editor-bg-panel`            | `#252525`                                           |
| `--atomic-editor-bg-surface`          | `#2d2d2d`                                           |
| `--atomic-editor-border`              | `#3d3d3d`                                           |
| `--atomic-editor-accent`              | `#7c3aed`                                           |
| `--atomic-editor-accent-bright`       | `#a78bfa`                                           |
| `--atomic-editor-accent-soft`         | blockquote rail / reveal tint                       |
| `--atomic-editor-link`                | `#818cf8`                                           |
| `--atomic-editor-link-hover`          | `#a5b4fc`                                           |
| `--atomic-editor-code-bg`             | subtle dark panel                                   |
| `--atomic-editor-selection-bg`        | accent-tinted 28%                                   |
| `--atomic-editor-search-bg`           | accent-tinted 28%                                   |
| `--atomic-editor-search-bg-active`    | accent-tinted 60%                                   |
| **Code-token colors** (Palenight)     |                                                     |
| `--atomic-editor-hl-keyword`          | `#c792ea`                                           |
| `--atomic-editor-hl-string`           | `#c3e88d`                                           |
| `--atomic-editor-hl-number`           | `#f78c6c`                                           |
| `--atomic-editor-hl-comment`          | `#6a7a82`                                           |
| `--atomic-editor-hl-type`             | `#ffcb6b`                                           |
| `--atomic-editor-hl-function`         | `#82aaff`                                           |
| `--atomic-editor-hl-property`         | `#82aaff`                                           |
| `--atomic-editor-hl-regexp`           | `#f07178`                                           |
| `--atomic-editor-hl-escape`           | `#89ddff`                                           |
| `--atomic-editor-hl-tag`              | `#f07178`                                           |
| `--atomic-editor-hl-variable`         | `#eeffff`                                           |
| `--atomic-editor-hl-operator`         | `#89ddff`                                           |
| `--atomic-editor-hl-invalid`          | `#ff5370`                                           |

## Extending with plugins

CodeMirror 6 is extension-based, and so is this package. Pass any
number of CM6 extensions via the `extensions` prop to layer in
autocomplete sources, custom decorations, domain-specific keymaps,
collaboration (yjs), vim mode, or anything else. (The
[wiki-links](#wiki-links) extension above is built with exactly this hook.)

```tsx
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';

const hashtags = autocompletion({
  override: [(ctx: CompletionContext) => {
    const match = ctx.matchBefore(/#\w*$/);
    if (!match) return null;
    return {
      from: match.from + 1,
      options: myTagStore.list().map((tag) => ({ label: tag })),
    };
  }],
});

<AtomicCodeMirrorEditor
  markdownSource={'…'}
  extensions={[hashtags]}
/>
```

Consumer extensions are appended after the built-ins, so wrap a custom
keymap in `Prec.high` (from `@codemirror/state`) if it needs to beat
the default bindings. The array is captured at mount — pass a stable
reference unless you want a remount.

### Low-level composition

If the React wrapper's extension set is too opinionated, every piece
is exported individually so you can assemble a fully custom editor:

```ts
import {
  inlinePreview, // live preview decorations
  imageBlocks,   // rendered image widgets
  tables,        // WYSIWYG table widget
  wikiLinks,     // [[...]] links
  atomicEditorTheme,
  atomicMarkdownSyntax,
  extendEmphasisPair,
} from '@atomic-editor/editor';
```

You could build an editor that includes `inlinePreview()` + `tables()`
but skips `atomicEditorTheme` for your own `EditorView.theme({...})`,
or swap `atomicMarkdownSyntax` for a custom
`syntaxHighlighting(HighlightStyle.define([...]))`. At that point
you're outside the React wrapper and in plain CM6 territory.

## Design notes

See [docs/architecture.md](./docs/architecture.md) for the full design
rationale. Short version:

- **Raw markdown is the source of truth.** All decorations are
  view-only — copy, save, and round-trip to any markdown parser are
  identical to what you'd expect from a plain textarea.
- **No layout shifts.** Every line has a stable height regardless of
  cursor position. Inline decorations hide syntax tokens on inactive
  lines without changing line heights.
- **Narrow invalidation.** Decoration rebuilds only touch lines whose
  content (or surrounding trigger characters) changed, so editing a
  paragraph in a 50KB doc costs O(change size), not O(doc).
- **Mouse-freeze guard.** Clicks don't trigger a decoration rebuild
  mid-interaction — eliminates a class of cursor-drift bugs.
- **iOS-aware.** Momentum-scroll halts (image remount jank, heightmap
  drift, anchor conflicts) were tracked down and fixed; the demo's
  sample-size picker doubles as a stress harness for spotting any
  regressions.

## Contributing

```bash
git clone https://github.com/kenforthewin/atomic-editor
cd atomic-editor
npm install
npm run dev        # demo dev server at http://localhost:5173
npm test           # vitest unit tests
npm run build      # tsc emit to dist/
npm run test:e2e   # Playwright probe suite against the demo
```

The Playwright suite (`scripts/test-editor.mjs`) is the primary
regression-catching tool — around 50 probes covering CLS during idle /
scroll / typing, click-freeze timing, every block-type decoration
(headings, lists, tasks, tables, images, fences, HRs, wiki links),
cursor-scoped link reveal, copy-as-raw-markdown, tight-list
continuation, escape handling, and late-doc rendering via the
parser-progress mechanic. Run after any change to the editor's
extensions.

Because the editor ships inside [Atomic](https://github.com/kenforthewin/atomic),
real user documents are its de-facto fuzz corpus — odd inputs (multi-line
link titles, over-escaped RSS imports, wide tables) tend to surface there
first, and fixes land here. Issues and PRs welcome.

## License

MIT. See [LICENSE](./LICENSE).
