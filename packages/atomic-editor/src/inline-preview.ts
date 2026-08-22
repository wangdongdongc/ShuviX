import { completionStatus } from '@codemirror/autocomplete';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  EditorSelection,
  Prec,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { previewFrozenField, setFrozen } from './editor-interaction';
import { isMathPosition, overlapsMathSyntax } from './math-blocks';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// Inline preview — the Obsidian "Live Preview" model.
//
// Goals:
//   1. No layout shifts between active/inactive state. The raw markdown
//      source is always the DOM text; we only apply line-level CSS
//      classes (setting font-size / weight unconditionally) and hide
//      syntax tokens on inactive lines via empty Decoration.replace.
//      Line heights are driven by CSS class, not by token visibility.
//
//   2. No reveal during mouse interaction. Clicking a heading places the
//      cursor on its line, which would normally "reveal" the `# ` prefix
//      — and that reveal shifts the heading text rightward under the
//      user's cursor, sometimes turning a click into a micro-drag.
//      Obsidian sidesteps this by delaying the reveal until the mouse
//      has been released for a moment; we do the same via a freeze flag.

export interface InlinePreviewConfig {
  /**
   * Called when the user plain-clicks a rendered link. Defaults to
   * `window.open(url, '_blank', 'noopener,noreferrer')`. Consumers in
   * platform-specific shells (Tauri, Electron, Capacitor) should pass
   * their own opener so links route through the host's external-URL
   * mechanism.
   */
  onLinkClick?: (url: string) => void;
}

function defaultOnLinkClick(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc. — silent failure
    // is fine; the caller can supply an opener that handles this.
  }
}

// Autolinks carry no scheme: a bare email (`a@b.com`) or `www.` host won't
// route through the OS opener as-is. Normalize to a usable URL so the host's
// `openExternal` does the right thing (mail client / browser). Explicit
// schemes (http:, https:, mailto:, …) and `[label](url)` destinations pass through.
export function normalizeLinkUrl(url: string): string {
  if (/^[a-z][\w+.-]*:/i.test(url)) return url;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  if (/^www\./i.test(url)) return `https://${url}`;
  return url;
}

// Buffer after mouse release before the freeze lifts and the active line
// reveals its raw source. The real anti-shift protection is the freeze held
// during pointerdown→pointerup; this tail is just a small settle buffer, so
// keep it short for a snappy reveal (keyboard cursor moves reveal instantly —
// they never freeze).
const FREEZE_TAIL_MS = 40;

// ---- freeze plumbing -----------------------------------------------------
//
// State lives in editor-interaction (mermaid / math read it too); this
// module owns the pointer wiring that drives it.

// Returns the `.cm-atomic-link` element under the pointer, if any. The
// whole rendered link is the click-to-open affordance (matching wiki
// links: `[[target]]`) — a plain click anywhere on the link text opens
// it rather than placing a caret. There is no trailing open-icon.
function linkHitTarget(event: MouseEvent, root?: HTMLElement): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const linkEl = target.closest<HTMLElement>('.cm-atomic-link');
  if (!linkEl || (root && !root.contains(linkEl))) return null;
  return linkEl;
}

// A plain (unmodified) click opens the link; a modifier-click falls
// through to native caret placement so the raw `[label](url)` still
// reveals for editing.
function isPlainClick(event: MouseEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// Tracks mouse state on the editor and drives the freeze flag. We listen
// on the content DOM for pointerdown and on the window for pointerup —
// users can release outside the editor after a drag, and we'd miss the
// up event if we listened on the content DOM only.
const freezeMousePlugin = ViewPlugin.fromClass(
  class {
    private down = false;
    private releaseTimer: number | null = null;
    private readonly onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Only freeze when the pointerdown lands inside the content. The
      // scrollbar (on the outer .cm-scroller) would otherwise engage the
      // freeze too — which keeps decorations stale for the whole drag
      // and the syntax only "pops in" on release. Gesture/wheel scroll
      // doesn't have this issue because it never fires a pointerdown on
      // the scrollbar chrome.
      const target = event.target;
      if (!(target instanceof Node) || !this.view.contentDOM.contains(target)) {
        return;
      }
      if (isPlainClick(event) && linkHitTarget(event, this.view.contentDOM)) {
        // Let the follow-up click open the link, but stop CM6 from
        // interpreting the press as a text-editing click. Without this,
        // pointerdown moves the selection into the Link node and reveals
        // `[label](url)` before the click handler opens it. A modifier-
        // click is excluded so the raw source can still be revealed/edited.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      this.down = true;
      if (this.releaseTimer != null) {
        window.clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      if (!this.view.state.field(previewFrozenField)) {
        this.view.dispatch({ effects: setFrozen.of(true) });
      }
    };
    private readonly onUp = () => {
      if (!this.down) return;
      this.down = false;
      if (this.releaseTimer != null) window.clearTimeout(this.releaseTimer);
      this.releaseTimer = window.setTimeout(() => {
        this.releaseTimer = null;
        if (!this.view.state.field(previewFrozenField)) return;
        try {
          this.view.dispatch({ effects: setFrozen.of(false) });
        } catch {
          // view destroyed while timer was pending.
        }
      }, FREEZE_TAIL_MS);
    };

    constructor(readonly view: EditorView) {
      // Capture-phase listener on view.dom so we dispatch setFrozen(true)
      // BEFORE CM6's own pointerdown handler runs its selection logic.
      // Without capture, CM6's listener can win the order race and
      // rebuild decorations (revealing `# `/`**`) before we freeze.
      view.dom.addEventListener('pointerdown', this.onDown, true);
      window.addEventListener('pointerup', this.onUp);
      window.addEventListener('pointercancel', this.onUp);
    }

    update(_: ViewUpdate) {
      // No-op — we don't drive freeze off doc changes.
    }

    destroy() {
      this.view.dom.removeEventListener('pointerdown', this.onDown, true);
      window.removeEventListener('pointerup', this.onUp);
      window.removeEventListener('pointercancel', this.onUp);
      if (this.releaseTimer != null) window.clearTimeout(this.releaseTimer);
    }
  },
);

// ---- decoration building --------------------------------------------------

const LINE_CLASS_BY_BLOCK: Record<string, string> = {
  ATXHeading1: 'cm-atomic-h1',
  ATXHeading2: 'cm-atomic-h2',
  ATXHeading3: 'cm-atomic-h3',
  ATXHeading4: 'cm-atomic-h4',
  ATXHeading5: 'cm-atomic-h5',
  ATXHeading6: 'cm-atomic-h6',
  // Setext headings (SetextHeading1/2) are intentionally disabled at the
  // parser level (see markdown({ extensions: [{ remove: ['SetextHeading'] }] })
  // in AtomicCodeMirrorEditor), so no mapping is needed for them here.
  Blockquote: 'cm-atomic-blockquote',
  FencedCode: 'cm-atomic-fenced-code',
};

const HIDEABLE_SYNTAX = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'CodeInfo',
  'LinkMark',
  'URL',
  'LinkTitle',
  'StrikethroughMark',
  'QuoteMark',
]);

// Children of a Link node whose visibility follows the link-scoped
// rule (cursor-inside-link) instead of the default line-based rule.
// The same token names can appear under an Image node — those stay
// on the line-based rule because images are a different UX surface.
const LINK_CHILD_SYNTAX = new Set(['LinkMark', 'URL', 'LinkTitle']);

const INLINE_MARK_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-atomic-strong',
  Emphasis: 'cm-atomic-em',
  InlineCode: 'cm-atomic-inline-code',
  Strikethrough: 'cm-atomic-strike',
  Link: 'cm-atomic-link',
};

// Inline constructs whose delimiter marks reveal LOCALLY — only when the
// cursor touches that specific span (Obsidian-style), not merely its line.
// Their marks (`**`, `*`, `` ` ``, `~~`) route through `activeInlineStarts`
// instead of the line-based rule. Block/line constructs (headings, quotes,
// fenced code) keep the line-based reveal. `Link` has its own set
// (`activeLinkStarts`) since its children are handled on a separate path.
const INLINE_REVEAL_NODES = new Set([
  'Emphasis',
  'StrongEmphasis',
  'InlineCode',
  'Strikethrough',
]);

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    // The `.cm-atomic-list-marker` class is what forces the
    // uniform 1.2em inline-block alcove shared by bullets, task
    // checkboxes, and ordered-list numbers. `.cm-atomic-bullet`
    // layers on bullet-specific color / weight.
    const span = document.createElement('span');
    span.className = 'cm-atomic-list-marker cm-atomic-bullet';
    span.textContent = '•';
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const BULLET_WIDGET = new BulletWidget();

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    // The `.cm-atomic-list-marker` class provides the uniform
    // inline-block alcove shared by bullets, checkboxes, and
    // ordered numbers. We apply it directly to the `<input>` so
    // selectors like `input.cm-atomic-task-checkbox` still work
    // (a wrapper span broke a Playwright probe that targets the
    // input by its class).
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-atomic-list-marker cm-atomic-task-checkbox';
    input.setAttribute('contenteditable', 'false');
    // Read-only viewer: render the checkbox as a non-interactive marker.
    // `disabled` blocks the native toggle, and we skip wiring the click
    // handler so a tick can't mutate the doc via a direct dispatch
    // (EditorState.readOnly only guards commands, not manual dispatch).
    if (view.state.readOnly) {
      input.disabled = true;
      return input;
    }
    input.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(input);
      if (pos < 0) return;
      const current = view.state.doc.sliceString(pos, pos + 3);
      const next = /\[x\]/i.test(current) ? '[ ]' : '[x]';
      if (current === next) return;
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });
    });
    return input;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

// ViewPlugin-sourced Decoration.replace ranges are forbidden from
// crossing a line break — CM6 throws "Decorations that replace line
// breaks may not be specified via plugins" at build time. Lezer
// happily emits tokens that do cross line breaks (a LinkTitle /
// Image title "wrapping across\ntwo lines", for instance), so every
// Decoration.replace we push has to be split into per-line segments
// first. The newline between segments stays visible — acceptable
// compromise, and it matches how other markdown editors render these
// uncommon multi-line forms.
function pushReplace(
  ranges: Range<Decoration>[],
  doc: Text,
  from: number,
  to: number,
  spec: Parameters<typeof Decoration.replace>[0] = {},
): void {
  if (from >= to) return;
  const startLine = doc.lineAt(from);
  if (to <= startLine.to) {
    ranges.push(Decoration.replace(spec).range(from, to));
    return;
  }
  // Multi-line: first segment carries the widget (if any) so it
  // renders in place of the opening token; subsequent segments are
  // plain hides. Emitting the widget on every segment would stack
  // duplicates (e.g. a BulletWidget on line 2+ of a wrapped item).
  let cursor = from;
  let firstSegment = true;
  while (cursor < to) {
    const line = doc.lineAt(cursor);
    const segEnd = Math.min(to, line.to);
    if (segEnd > cursor) {
      ranges.push(
        Decoration.replace(firstSegment ? spec : {}).range(cursor, segEnd),
      );
      firstSegment = false;
    }
    cursor = line.to + 1;
  }
}

// Nesting level of the list item owning `mark` (a ListMark node): 0 for a
// top-level item, 1 for one nested inside it, and so on.
//
// Deliberately counted from the TREE (enclosing Bullet/OrderedList nodes),
// not from the marker's source column. Column math has to assume an indent
// step — the old `floor(column / 2)` did — and markdown has no such rule:
// a nested list only needs to start past its parent's content column, so
// hand- and agent-written docs indent by 2, 3, or 4 spaces, or a tab. With
// column math, a 4-space document rendered at DOUBLE the intended indent
// (and a tab-indented one at zero, `floor(1/2) === 0`). The tree already
// knows the real nesting, so every style renders at exactly one step per
// level.
function listNestingDepth(mark: SyntaxNode): number {
  let depth = -1; // the item's own list is an ancestor → start below zero
  for (let n: SyntaxNode | null = mark; n; n = n.parent) {
    if (n.name === 'BulletList' || n.name === 'OrderedList') depth++;
  }
  return Math.max(0, depth);
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const ranges: Range<Decoration>[] = [];

  const activeLines = new Set<number>();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      const firstLine = doc.lineAt(r.from).number;
      const lastLine = doc.lineAt(r.to).number;
      for (let n = firstLine; n <= lastLine; n++) activeLines.add(n);
    }
  }

  // Does any selection range touch [from, to] (inclusive on both ends, so a
  // cursor sitting exactly on a boundary counts as inside — the next
  // keystroke would affect that span)? Only while focused. This is the core
  // predicate for Obsidian-style LOCAL reveal: a specific span reveals its
  // source when the cursor is on it, independent of the rest of the line.
  const selTouches = (from: number, to: number): boolean =>
    view.hasFocus &&
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  // The inner `[label]` of a `[[label]]` wiki-link is parsed by lezer as its
  // own Link node. Leave it ENTIRELY to the wiki-links extension — don't
  // style or hide it here. Otherwise the two extensions fight: when the
  // wiki-link reveals its raw source, inline-preview would still hide the
  // INNER brackets, leaving only one visible `[ ]` layer. Detected by the
  // extra `[` immediately before and `]` immediately after the Link node.
  const isWikiWrappedLink = (from: number, to: number): boolean =>
    from >= 1 &&
    doc.sliceString(from - 1, from) === '[' &&
    doc.sliceString(to, to + 1) === ']';

  // Decorate the whole parsed tree — not the current viewport — so
  // that scrolling never needs to rebuild the decoration set. Prior
  // design walked viewport-only and rebuilt on every scroll, which
  // on iOS caused scroll-up momentum halts whenever new decorations
  // were applied to lines at the top of the viewport (anchor
  // conflict with the scroll animation). Cost: a one-shot whole-doc
  // walk on every doc / selection / focus change instead of a
  // smaller walk on every scroll.
  //
  // `ensureSyntaxTree(..., doc.length, ...)` guarantees the tree
  // actually covers the whole doc before we walk it. Without this,
  // for moderately long atoms the incremental parser's initial
  // pass falls short of the end, we'd walk only a prefix, and
  // content past that point renders as raw `##`/`**` forever —
  // decorations don't rebuild on scroll anymore. Subsequent calls
  // are near-free because ensureSyntaxTree short-circuits once the
  // tree reaches the target.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  // `from` positions of Link nodes whose range overlaps a selection.
  // Link children (LinkMark/URL/LinkTitle) hide unless their parent
  // Link's `from` is in this set — i.e. the cursor has entered the
  // link specifically, not merely landed on the same line. Images
  // aren't included; they already have their own widget UX and the
  // line-based reveal is the right fit for `![alt](url)`.
  const activeLinkStarts = new Set<number>();

  // Starts of inline constructs (Emphasis/StrongEmphasis/InlineCode/
  // Strikethrough) the cursor is currently touching — their marks reveal.
  // Populated in the same pre-order walk (parent entered before its marks).
  const activeInlineStarts = new Set<number>();

  // Single pre-order walk. A tree walk visits a parent before its
  // children, which lets us compute two pieces of look-ahead state on
  // the way in — right before the children that depend on them:
  //   - Fenced-code active expansion: clicking any line of a fence
  //     activates the whole block. FencedCode is entered before its
  //     CodeMark/CodeInfo children, so expanding activeLines here means
  //     those children hide/reveal consistently with the block.
  //   - activeLinkStarts: a Link is entered before its LinkMark/URL/
  //     LinkTitle children, so recording it here makes the link-scoped
  //     reveal rule ready when those children are processed.
  // (A previous version ran a separate pre-pass plus a taskMarkerByLine
  // map. Folding both into this one walk halves the per-rebuild tree
  // traversal — meaningful because this runs on every cursor move and
  // its cost scales with document size.)
  tree.iterate({
    enter: (node) => {
      // The markdown grammar does not apply inside a `$…$` / `$$…$$`
      // formula: `\\`, `_` and `*` are TeX there. Skip the subtree for
      // any node that sits inside a formula OR straddles its boundary —
      // the latter is how `$\mathfrak{T}_\Gamma$ 的… $\mathfrak{E}_\Gamma$`
      // ends up italicizing the prose between the two formulas (lezer
      // pairs the two `_`). A no-op when math-blocks isn't installed.
      if (overlapsMathSyntax(state, node.from, node.to)) return false;
      if (node.name === 'FencedCode') {
        const firstLine = doc.lineAt(node.from).number;
        const lastLine = doc.lineAt(node.to).number;
        let anyActive = false;
        for (let n = firstLine; n <= lastLine; n++) {
          if (activeLines.has(n)) {
            anyActive = true;
            break;
          }
        }
        if (anyActive) {
          for (let n = firstLine; n <= lastLine; n++) activeLines.add(n);
        }
      }
      // Local-reveal bookkeeping: record inline constructs the cursor
      // touches, so their delimiter marks reveal independently of the
      // rest of the line. A parent is entered before its mark children,
      // so the set is ready by the time those marks are processed.
      if (node.name === 'Link') {
        // Skip the inner Link of a `[[wiki]]` — it belongs to the
        // wiki-links extension (see isWikiWrappedLink).
        if (!isWikiWrappedLink(node.from, node.to) && selTouches(node.from, node.to)) {
          activeLinkStarts.add(node.from);
        }
      } else if (INLINE_REVEAL_NODES.has(node.name)) {
        if (selTouches(node.from, node.to)) activeInlineStarts.add(node.from);
      }
      const lineClass = LINE_CLASS_BY_BLOCK[node.name];
      if (lineClass) {
        const firstLine = doc.lineAt(node.from);
        const lastLine = doc.lineAt(node.to);
        for (let n = firstLine.number; n <= lastLine.number; n++) {
          const line = doc.line(n);
          ranges.push(Decoration.line({ class: lineClass }).range(line.from));
        }
      }

      const markClass = INLINE_MARK_CLASS[node.name];
      if (
        markClass &&
        node.from < node.to &&
        !(node.name === 'Link' && isWikiWrappedLink(node.from, node.to))
      ) {
        ranges.push(Decoration.mark({ class: markClass }).range(node.from, node.to));
      }

      if (HIDEABLE_SYNTAX.has(node.name) && node.from < node.to) {
        const lineNum = doc.lineAt(node.from).number;

        // Link children use a link-scoped rule (cursor-inside-link)
        // rather than the line-based rule. A LinkMark under an
        // Image node falls through to line-based — images have
        // their own widget UX that the line-based reveal fits.
        let shouldHide: boolean;
        // Autolink / bare-email URL: the URL text IS the link's visible
        // content (`<https://x>`, `<a@b.com>`, or a GFM bare `a@b.com`),
        // so hiding it would erase the whole link off-line. Only a
        // bracketed link's destination `[label](url)` — where the URL is
        // preceded by `(` — is safe to hide; the `label` stays visible.
        if (
          node.name === 'URL' &&
          doc.sliceString(Math.max(0, node.from - 1), node.from) !== '('
        ) {
          shouldHide = false;
          // The URL is the link's sole visible content (autolink / bare email).
          // Tag it `.cm-atomic-link` so it gets the same click-to-open
          // affordance as a `[label](url)` link.
          ranges.push(
            Decoration.mark({ class: 'cm-atomic-link' }).range(node.from, node.to),
          );
        } else if (LINK_CHILD_SYNTAX.has(node.name)) {
          let parent = node.node.parent;
          while (parent && parent.name !== 'Link' && parent.name !== 'Image') {
            parent = parent.parent;
          }
          if (parent && parent.name === 'Link') {
            // Wiki inner `[label]`: leave the brackets alone (never hide)
            // so the wiki-links extension fully owns `[[...]]`.
            shouldHide = isWikiWrappedLink(parent.from, parent.to)
              ? false
              : !activeLinkStarts.has(parent.from);
          } else {
            shouldHide = !activeLines.has(lineNum);
          }
        } else if (
          node.name === 'EmphasisMark' ||
          node.name === 'CodeMark' ||
          node.name === 'StrikethroughMark'
        ) {
          // Inline delimiter marks: reveal only when the cursor is inside
          // THIS construct (local reveal). Walk up to the enclosing inline
          // node and consult activeInlineStarts. A CodeMark under a
          // FencedCode (not an inline node) finds no inline parent and
          // falls back to the line-based rule — correct, since fenced
          // blocks reveal by line/block, not per-delimiter.
          let parent = node.node.parent;
          while (parent && !INLINE_REVEAL_NODES.has(parent.name)) {
            parent = parent.parent;
          }
          shouldHide = parent
            ? !activeInlineStarts.has(parent.from)
            : !activeLines.has(lineNum);
        } else {
          shouldHide = !activeLines.has(lineNum);
        }

        if (shouldHide) {
          let hideTo = node.to;
          if (node.name === 'HeaderMark' || node.name === 'QuoteMark') {
            while (hideTo < doc.length && doc.sliceString(hideTo, hideTo + 1) === ' ') {
              hideTo++;
            }
          }
          pushReplace(ranges, doc, node.from, hideTo);
        }
      }

      // Backslash escapes: `\.`, `\*`, `\(`, etc. RSS-to-markdown
      // converters escape a lot of punctuation defensively, and the
      // backslashes show through as literal chars without preview.
      // Hide just the leading backslash on inactive lines so the
      // escaped character remains visible — mirrors how Obsidian
      // renders escapes. The Escape node spans both characters
      // (`\` + escaped char), so we only replace the first position.
      if (node.name === 'Escape' && node.to - node.from >= 2) {
        const lineNum = doc.lineAt(node.from).number;
        if (!activeLines.has(lineNum)) {
          pushReplace(ranges, doc, node.from, node.from + 1);
        }
      }

      if (node.name === 'ListMark' && node.from < node.to) {
        const line = doc.lineAt(node.from);
        // Detect a task item from the line text. ListMark is visited
        // before the TaskMarker on its line, so a forward single-pass
        // walk can't look the marker position up from a map; the
        // capture group is the `- ` lead-in and its length lands
        // taskFrom exactly on the `[` (matching TaskMarker.from).
        const taskLead = line.text.match(/^(\s*[-*+]\s+)\[[ xX]\]/);
        const taskFrom =
          taskLead != null ? line.from + taskLead[1].length : undefined;

        // A marker only becomes a list item once it is followed by a SPACE
        // (Obsidian-style): while the user is still typing `-` or `1.` with
        // nothing after it, lezer already parses an empty list item, but we
        // must NOT indent or render a marker yet — it reads as a premature
        // jump. Bail until the trailing whitespace exists.
        const nextChar = doc.sliceString(node.to, node.to + 1);
        const hasTrailingSpace = nextChar === ' ' || nextChar === '\t';
        if (!hasTrailingSpace) return;

        // Obsidian-style list indent: only the LINE START (the marker)
        // is aligned — every item's marker begins at the same column
        // (BASE + nesting). The content follows immediately after the
        // marker with a fixed gap (the marker's CSS margin-right), so
        // the text column is NOT forced to align across items: a bullet
        // sits closer to its text than "10." does. We deliberately do
        // NOT reserve a fixed-width alcove (which would tabular-align the
        // text and make the marker→text gap vary per kind/width).
        // `padding-left` sets the marker column; there is no negative
        // `text-indent`, so content is never pulled to a fixed column.
        // Trade-off: a wrapped line returns to the marker column rather
        // than hanging under the content — fine for short list items.
        const depth = listNestingDepth(node.node);
        const BASE_EM = 0.8;
        // One step is a hair wider than the task checkbox (1em square, see
        // `.cm-atomic-task-checkbox`): enough that a nested item's marker
        // clears its parent's box, without the airy staircase a larger step
        // produces in deep task trees.
        const LEVEL_EM = 1.2;
        // Round: `0.8 + 3 * 1.2` is 4.3999999999999995 in binary floating
        // point, which would land verbatim in the inline style string.
        const padding = Math.round((BASE_EM + depth * LEVEL_EM) * 1000) / 1000;
        ranges.push(
          Decoration.line({
            attributes: {
              style: `padding-left: ${padding}em`,
            },
          }).range(line.from),
        );

        // Include the single trailing space (guaranteed present — see the
        // hasTrailingSpace gate above) so bullet/ordered content flows from
        // padding-left without a spurious leading space. For tasks, taskFrom
        // already covers the `- ` span up to the `[`.
        const markEnd = node.to + 1;

        // The marker region for local reveal: line start through the end of
        // `- [ ]` on a task item, through the marker text otherwise. Shared
        // by the indent hide below and the per-kind branches so the source
        // indent and its marker always reveal together.
        const markerEnd = taskFrom !== undefined ? taskFrom + 3 : node.to;
        const revealMarker = selTouches(line.from, markerEnd);

        // Hide the source indent. `padding-left` above already puts the
        // marker at its nesting column; leaving the raw spaces/tabs as text
        // ADDS to that, so the rendered indent doubled with the author's
        // indent width (and a tab expanded to the browser's 8-column tab
        // stop). Walk back from the marker rather than taking the whole line
        // prefix, so a list inside a blockquote keeps its `> ` for the
        // QuoteMark branch instead of having it swallowed here.
        let indentFrom = node.from;
        while (
          indentFrom > line.from &&
          /[ \t]/.test(doc.sliceString(indentFrom - 1, indentFrom))
        ) {
          indentFrom--;
        }
        if (!revealMarker) pushReplace(ranges, doc, indentFrom, node.from);

        if (taskFrom !== undefined) {
          // Task item: the marker region is `- [ ]` (line start through
          // the 3-char `[ ]`/`[x]`). Reveal it as raw source only when the
          // cursor is on the marker (local reveal); otherwise hide the
          // `- ` (the TaskMarker branch swaps `[ ]` for the checkbox). Both
          // branches use the same region so they agree.
          if (!revealMarker) {
            pushReplace(ranges, doc, node.from, taskFrom);
          }
        } else {
          const markText = doc.sliceString(node.from, node.to);
          if (markText === '-' || markText === '*' || markText === '+') {
            // Bullet: substitute the raw `- ` with the dot widget — but
            // NOT when the cursor is on the marker itself. Local reveal:
            // the `- ` reverts to source only when you're on it (Obsidian-
            // style), while editing the item text keeps the dot. The
            // reveal region stops at the dash (`node.to`), NOT the trailing
            // space (`markEnd`): otherwise a cursor sitting right after
            // `- ` (the content start, where it lands as you finish typing)
            // would count as "on the marker" and show `-` instead of a dot.
            if (!revealMarker) {
              pushReplace(ranges, doc, node.from, markEnd, { widget: BULLET_WIDGET });
            }
          } else {
            // Ordered list (or anything else with a non-standard
            // mark text like `1.`, `42.`): keep the text visible
            // but mark it so CSS gives it the same fixed-width
            // alcove. Hide the trailing space separately so the
            // total marker-plus-space footprint matches ALCOVE.
            ranges.push(
              Decoration.mark({ class: 'cm-atomic-list-marker' }).range(
                node.from,
                node.to,
              ),
            );
            if (hasTrailingSpace) {
              pushReplace(ranges, doc, node.to, markEnd);
            }
          }
        }
      }

      // Tables are rendered by the separate `tables()` block-widget
      // extension (./table-widget.ts) — the whole Table range is
      // replaced with an interactive HTML `<table>`. Any inline
      // decorations on TableHeader/TableRow/TableDelimiter would
      // target ranges that are already hidden behind the replace
      // widget, so they're intentionally absent from this builder.

      if (node.name === 'HorizontalRule') {
        // CommonMark HR: a line of `***`, `---`, or `___` (3+, any
        // spacing between). On inactive lines we hide the characters
        // and render a horizontal rule via CSS `::after`. On active
        // lines we leave the raw characters visible so the user can
        // edit the marker without it vanishing.
        const line = doc.lineAt(node.from);
        if (!activeLines.has(line.number)) {
          ranges.push(Decoration.line({ class: 'cm-atomic-hr' }).range(line.from));
          pushReplace(ranges, doc, line.from, line.to);
        }
      }

      if (node.name === 'Image' && node.from < node.to) {
        const imageLine = doc.lineAt(node.from);
        const lineNum = imageLine.number;
        if (!activeLines.has(lineNum)) {
          // Hide the raw `![alt](url)` on inactive lines so only the
          // rendered image block (emitted by the image-blocks state
          // field below the line) shows. We deliberately keep the
          // now-empty source `.cm-line` at its default line-height
          // rather than collapsing it via `display: none`: on iOS
          // Safari, toggling a line from its text-measured height
          // to zero mid-scroll shifts every subsequent line up by
          // that amount, which the scroll engine reads as an
          // anchor conflict and halts kinetic momentum — visible
          // as "scroll stops right before an image when you scroll
          // back up." The tradeoff is one line of empty space
          // above each rendered image, which actually reads a bit
          // cleaner as visual separation anyway.
          pushReplace(ranges, doc, node.from, node.to);
        }
      }

      if (node.name === 'TaskMarker' && node.from < node.to) {
        const markText = doc.sliceString(node.from, node.to);
        const checked = /\[x\]/i.test(markText);
        const taskLine = doc.lineAt(node.from);
        // Local reveal: when the cursor is on the marker region
        // (`- [ ]`, i.e. line start through the checkbox), show the raw
        // `[ ]` for editing instead of the checkbox widget. Same region as
        // the ListMark branch so the `- ` and `[ ]` reveal together.
        const revealSource = selTouches(taskLine.from, node.to);
        if (!revealSource) {
          // Replace ONLY `[ ]` / `[x]` — deliberately leave the trailing
          // space as real text. The checkbox is a native `<input>`; its
          // marker→text gap can't be padding (that would stretch the square),
          // and a margin sits OUTSIDE the border-box CM measures for the
          // caret, so a swallowed-space + margin left the caret glued to the
          // box. Keeping the space real means the caret after `- [ ] ` lands
          // at the real text boundary (past the space) — the actual input
          // position — while the space + a small checkbox margin form the gap.
          pushReplace(ranges, doc, node.from, node.to, {
            widget: new TaskCheckboxWidget(checked),
          });
        }
        if (checked) {
          ranges.push(
            Decoration.line({ class: 'cm-atomic-task-done' }).range(taskLine.from),
          );
        }
      }
      // Descend into the children (the math skip above is the only
      // early-out); explicit so the callback has a return on every path.
      return true;
    },
  });

  // Supplemental inline marks for the line containing the cursor.
  // CommonMark's flanking rules say that `**foo **` is not emphasis
  // because the closing `**` is preceded by whitespace — lezer
  // agrees and doesn't emit `StrongEmphasis`, so the walk above
  // misses it. Result: while the user types a sentence inside
  // `**...**`, the bold styling flicks on and off every time they
  // hit the spacebar. We patch the UX by scanning the active line
  // for matched delimiter pairs the cursor sits between and
  // emitting the mark ourselves regardless of flanking. Once the
  // cursor leaves, lezer's opinion wins and the visual reverts to
  // what will actually persist when the line is serialized.
  if (view.hasFocus) {
    const head = state.selection.main.head;
    const line = doc.lineAt(head);
    if (activeLines.has(line.number)) {
      supplementMidTypingEmphasis(
        line.text,
        line.from,
        head - line.from,
        ranges,
        (pos) => isMathPosition(state, pos),
      );
    }
  }

  return Decoration.set(ranges, true);
}

// Delimiters we emit supplemental marks for, longest first so `**`
// is matched before `*` and `__` before `_`. Backticks don't need
// this treatment — CommonMark inline code isn't subject to
// flanking rules. Each entry carries both the content class (what
// lezer would style via `t.strong` / `t.emphasis` / `t.strikethrough`)
// and the delimiter class (matches how the EmphasisMark token
// renders when lezer *does* parse: parent tag's weight / style /
// decoration plus `processingInstruction`'s faint color).
const MID_TYPING_DELIMITERS: readonly {
  delim: string;
  contentCls: string;
  delimCls: string;
}[] = [
  { delim: '**', contentCls: 'cm-atomic-strong', delimCls: 'cm-atomic-strong-mark' },
  { delim: '__', contentCls: 'cm-atomic-strong', delimCls: 'cm-atomic-strong-mark' },
  { delim: '~~', contentCls: 'cm-atomic-strike', delimCls: 'cm-atomic-strike-mark' },
  { delim: '*', contentCls: 'cm-atomic-em', delimCls: 'cm-atomic-em-mark' },
  { delim: '_', contentCls: 'cm-atomic-em', delimCls: 'cm-atomic-em-mark' },
];

function supplementMidTypingEmphasis(
  text: string,
  lineFrom: number,
  localCursor: number,
  out: Range<Decoration>[],
  // A `_` or `*` inside a formula is TeX, not a delimiter — pairing one
  // would italicize whatever sits between two formulas on this line.
  isMath: (pos: number) => boolean,
): void {
  // Track which characters of the line are already "owned" by a
  // matched delimiter pair so a single-char delimiter doesn't
  // accidentally pair halves of two different double-delimiter
  // spans.
  const consumed = new Uint8Array(text.length);

  for (const { delim, contentCls, delimCls } of MID_TYPING_DELIMITERS) {
    const dLen = delim.length;
    // Underscore emphasis (`_`, `__`) doesn't open intra-word under
    // CommonMark's flanking rules — `snake_case_var` is not italic.
    // Without this guard the supplement would flash false italic while
    // the cursor sits between two intra-word underscores (exactly the
    // flicker this feature exists to prevent, inverted). Asterisk
    // delimiters have no such restriction, so only gate underscores.
    const isUnderscore = delim === '_' || delim === '__';
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const open = indexOfUnconsumed(text, delim, searchFrom, consumed);
      if (open < 0) break;
      if (isUnderscore && open > 0 && /\w/.test(text[open - 1])) {
        searchFrom = open + dLen;
        continue;
      }
      const close = indexOfUnconsumed(text, delim, open + dLen, consumed);
      if (close < 0) break;

      if (isMath(lineFrom + open) || isMath(lineFrom + close)) {
        // Leave both halves unconsumed: the other one may still pair
        // with a real delimiter further along the line.
        searchFrom = open + dLen;
        continue;
      }

      for (let i = open; i < close + dLen; i++) consumed[i] = 1;

      const contentFrom = open + dLen;
      const contentTo = close;
      if (
        contentFrom < contentTo &&
        localCursor > open &&
        localCursor < close + dLen
      ) {
        out.push(
          Decoration.mark({ class: contentCls }).range(
            lineFrom + contentFrom,
            lineFrom + contentTo,
          ),
        );
        // Style the delimiter characters to match how lezer's
        // `EmphasisMark` tokens render when the pattern parses
        // cleanly. Lezer tags `EmphasisMark` with both its parent
        // (`strong` / `emphasis` / `strikethrough`) and
        // `processingInstruction`, so the `**` characters get
        // faint color AND the parent's weight / style / decoration
        // — we mirror all of that here so the delimiters don't
        // flip style / size / color when the cursor moves or a
        // trailing space triggers / untriggers lezer's parse.
        out.push(
          Decoration.mark({ class: delimCls }).range(
            lineFrom + open,
            lineFrom + contentFrom,
          ),
        );
        out.push(
          Decoration.mark({ class: delimCls }).range(
            lineFrom + contentTo,
            lineFrom + close + dLen,
          ),
        );
      }

      searchFrom = close + dLen;
    }
  }
}

function indexOfUnconsumed(
  text: string,
  needle: string,
  from: number,
  consumed: Uint8Array,
): number {
  let i = from;
  while (i <= text.length - needle.length) {
    const found = text.indexOf(needle, i);
    if (found < 0) return -1;
    let isConsumed = false;
    for (let k = found; k < found + needle.length; k++) {
      if (consumed[k]) {
        isConsumed = true;
        break;
      }
    }
    if (!isConsumed) return found;
    i = found + 1;
  }
  return -1;
}

const inlinePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildInlineDecorations(view);
    }

    update(update: ViewUpdate) {
      const prevFrozen = update.startState.field(previewFrozenField);
      const nextFrozen = update.state.field(previewFrozenField);
      const justUnfroze = prevFrozen && !nextFrozen;

      // A doc change is unambiguous edit intent, so rebuild even while
      // frozen. Returning the stale (pre-edit) decoration set here would
      // hand CM6 ranges whose positions no longer match the document: a
      // hidden `## ` replace can end up spanning the newly-typed text's
      // line break ("Decorations that replace line breaks may not be
      // specified via plugins"), and the stale positions corrupt the
      // heightmap ("No tile at position …" → broken scrollIntoView). The
      // freeze only needs to suppress the *selection*-driven reveal that
      // makes a click jitter; typing should reveal syntax as normal.
      if (nextFrozen && !justUnfroze && !update.docChanged) return;

      // Tree-growth effect: background parser advanced past where
      // we last walked. For docs large enough that the initial
      // parse didn't reach the end, later blocks (headings, lists,
      // etc.) render as raw `##`/`**` until this fires.
      let treeGrew = false;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(treeGrowthEffect)) {
            treeGrew = true;
            break;
          }
        }
        if (treeGrew) break;
      }

      // Note: `update.viewportChanged` is intentionally NOT in this
      // list. Scrolling alone must not rebuild decorations — doing
      // so on iOS halts momentum whenever the rebuild produces new
      // decorations for lines at the top of a scroll-up viewport
      // (CM6 anchor conflict with the scroll animation). Walking
      // the whole parsed tree on the remaining triggers means
      // scroll-time cost is zero; the tree walk itself is
      // single-digit ms for typical atoms.
      if (
        justUnfroze ||
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        treeGrew
      ) {
        this.decorations = buildInlineDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

// Tight-continuation Enter for bullet lists.
//
// Why we override the default: @codemirror/lang-markdown's
// `insertNewlineContinueMarkup` uses the syntax tree to decide whether a
// list is "loose" (blank lines between items) and, if so, inserts a
// blank line as part of the continuation. That inference bleeds in when
// you start a new list adjacent to an existing one — lezer sees both as
// siblings in a loose list, and the new item sprouts a blank line the
// user didn't intend. In our inline-preview mode loose vs tight lists
// look identical anyway, so we always continue tight.
function insertTightListItem(view: EditorView): boolean {
  const { state } = view;
  // When an autocomplete popup is showing options, Enter must accept the
  // completion, not continue the list. This handler runs at Prec.highest
  // (to beat lang-markdown's own Enter), so it would otherwise swallow the
  // key before the lower-precedence completion keymap — bail out and let it
  // fall through.
  if (completionStatus(state) === 'active') return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const from = sel.from;
  const line = state.doc.lineAt(from);

  const tree = syntaxTree(state);
  let cursor = tree.resolveInner(from, -1).cursor();
  let inBulletList = false;
  for (;;) {
    if (cursor.name === 'BulletList') {
      inBulletList = true;
      break;
    }
    if (!cursor.parent()) break;
  }
  if (!inBulletList) return false;

  const lineText = state.doc.sliceString(line.from, line.to);
  const prefix = lineText.match(/^(\s*)([-*+])(\s+)/);
  if (!prefix) return false;

  const [whole, indent, marker] = prefix;
  const rest = lineText.slice(whole.length);

  const taskMatch = rest.match(/^(\[[ xX]\])(\s*)/);
  const taskPrefixLen = taskMatch ? taskMatch[0].length : 0;
  const contentAfterPrefix = rest.slice(taskPrefixLen);

  if (!contentAfterPrefix.trim()) {
    const depth = Math.floor(indent.length / 2);
    if (depth >= 1) {
      const outerIndent = indent.slice(0, indent.length - 2);
      const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
      const replacement = `${outerIndent}${continuation}`;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: replacement },
        selection: EditorSelection.cursor(line.from + replacement.length),
      });
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
      });
    }
    return true;
  }

  const continuation = taskMatch ? `${marker} [ ] ` : `${marker} `;
  const insert = `\n${indent}${continuation}`;
  view.dispatch({
    changes: { from, to: from, insert },
    selection: EditorSelection.cursor(from + insert.length),
  });
  return true;
}

function makeLinkClickHandler(onLinkClick: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (!isPlainClick(event)) return false;
      if (event.button !== 0) return false;
      const linkEl = linkHitTarget(event, view.contentDOM);
      if (!linkEl) return false;

      const pos = view.posAtDOM(linkEl);
      if (pos < 0) return false;

      const tree = syntaxTree(view.state);
      let node: SyntaxNode | null = tree.resolveInner(pos, 1);
      // `[label](url)` → Link (URL is a child); `<url>`/`<a@b.com>` → Autolink
      // (URL child); bare GFM email/URL → a standalone URL node with neither
      // ancestor. Stop at whichever we hit first.
      while (
        node &&
        node.name !== 'Link' &&
        node.name !== 'Autolink' &&
        node.name !== 'URL'
      ) {
        node = node.parent;
      }
      if (!node) return false;
      const urlNode = node.name === 'URL' ? node : node.getChild('URL');
      if (!urlNode) return false;

      const raw = view.state.doc.sliceString(urlNode.from, urlNode.to);
      if (!raw) return false;
      const url = normalizeLinkUrl(raw);

      event.preventDefault();
      event.stopPropagation();
      onLinkClick(url);
      return true;
    },
  });
}

/**
 * Assemble the inline-preview extension set. Call once per editor and
 * include the result in your EditorState `extensions` list. Accepts an
 * `onLinkClick` callback so consumers can route link opens through
 * their platform's external-URL mechanism (Tauri IPC, Capacitor
 * browser, etc.) instead of the default `window.open`.
 */
export function inlinePreview(config: InlinePreviewConfig = {}): Extension {
  const { onLinkClick = defaultOnLinkClick } = config;
  return [
    previewFrozenField,
    inlinePreviewPlugin,
    freezeMousePlugin,
    treeProgressPlugin,
    makeLinkClickHandler(onLinkClick),
    // Prec.highest to beat @codemirror/lang-markdown's own Enter
    // handler, which is registered internally by the `markdown()`
    // extension (not just via the exported markdownKeymap) and
    // otherwise wins precedence.
    Prec.highest(keymap.of([{ key: 'Enter', run: insertTightListItem }])),
  ];
}
