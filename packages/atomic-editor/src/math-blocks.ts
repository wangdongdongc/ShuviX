import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';
import {
  focusedField,
  focusWatcher,
  nextFrozen,
  setEditorFocused,
} from './editor-interaction';

// TeX math — the Obsidian "Live Preview" model for `$…$` / `$$…$$`.
//
// Math is NOT part of CommonMark or GFM: `$` is an ordinary character
// there. `$…$` is a de-facto convention (Pandoc, Jupyter, GitHub,
// Obsidian) that every implementation spells slightly differently, so
// the delimiter rules below are ours — deliberately conservative, since
// a false positive silently swallows prose (`价格 $5 到 $10`) while a
// false negative merely leaves the source visible.
//
// Rendering is KaTeX. The scan is a hand-written line scanner rather
// than a lezer extension: `$` isn't in the markdown grammar, and the
// delimiter rules need lookaround the tokenizer can't express. The scan
// depends ONLY on the document, so it is memoized in the state field and
// re-run on doc changes — never on a cursor move.
//
// Decorations must come from a StateField (block-replace ranges may not
// originate from a ViewPlugin), and the reveal rule needs focus, which a
// StateField cannot read from the view — hence the shared focus mirror,
// same as mermaid-blocks.

export interface MathSpan {
  /** Start of the opening delimiter. */
  from: number;
  /** End of the closing delimiter. */
  to: number;
  /** TeX source between the delimiters. */
  tex: string;
  /** `$$` → KaTeX display mode; `$` → inline mode. */
  display: boolean;
  /** The span owns its lines whole → renders as a centered block. */
  block: boolean;
}

export type MathResult = { html?: string; error?: string };

// ---------------------------------------------------------------------
// KaTeX rendering
//
// KaTeX is synchronous but ~270KB, so the module is imported lazily and
// results are cached by source. Once loaded, `renderMathSync` serves
// every later widget without a repaint — only the first formula in a
// session ever shows the pending state.

const MAX_CACHE_ENTRIES = 800;
const mathCache = new Map<string, MathResult>();
let katexModule: Promise<typeof import('katex')> | null = null;
let katexApi: (typeof import('katex'))['default'] | null = null;

const cacheKey = (tex: string, display: boolean): string =>
  `${display ? 'display' : 'inline'} ${tex}`;

function remember(key: string, result: MathResult): MathResult {
  mathCache.set(key, result);
  // Evict oldest insertions (Map preserves insertion order) — editing
  // inside a formula churns a new cache entry per keystroke.
  if (mathCache.size > MAX_CACHE_ENTRIES) {
    let overflow = mathCache.size - MAX_CACHE_ENTRIES;
    for (const k of mathCache.keys()) {
      if (overflow-- <= 0) break;
      mathCache.delete(k);
    }
  }
  return result;
}

function renderWithKatex(
  katex: (typeof import('katex'))['default'],
  tex: string,
  display: boolean,
): MathResult {
  try {
    // `trust: false` (the default) is what makes the output safe to
    // inject as innerHTML: it disables the only commands that can emit
    // arbitrary markup or URLs (\href, \url, \includegraphics,
    // \htmlClass…). Everything else KaTeX emits is escaped text inside
    // its own span tree — no sanitizer pass needed, unlike mermaid SVG.
    // `throwOnError: false` renders a malformed formula as red source
    // instead of failing the widget, which is what you want mid-typing.
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      errorColor: '#e06c75',
      strict: false,
      trust: false,
    });
    return { html };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Cached render, or `null` when KaTeX hasn't finished loading. */
export function renderMathSync(tex: string, display: boolean): MathResult | null {
  const key = cacheKey(tex, display);
  const hit = mathCache.get(key);
  if (hit) return hit;
  if (!katexApi) return null;
  return remember(key, renderWithKatex(katexApi, tex, display));
}

/**
 * Render TeX to KaTeX HTML (lazy module load + cache by source+mode).
 * Exported so other surfaces (previews, exports) share one cache.
 */
export function renderMath(
  tex: string,
  opts: { display?: boolean } = {},
): Promise<MathResult> {
  const display = opts.display ?? false;
  const sync = renderMathSync(tex, display);
  if (sync) return Promise.resolve(sync);
  if (!katexModule) katexModule = import('katex');
  return katexModule.then(
    (m) => {
      katexApi = m.default;
      return renderMathSync(tex, display) ?? { error: 'KaTeX unavailable' };
    },
    (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  );
}

// ---------------------------------------------------------------------
// Scanner

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const FRONTMATTER_OPEN_RE = /^---\s*$/;
const FRONTMATTER_CLOSE_RE = /^(?:---|\.\.\.)\s*$/;

const isBlank = (text: string): boolean => text.trim().length === 0;

/** Is `pos` preceded by an odd number of backslashes (i.e. escaped)? */
function isEscaped(text: string, pos: number): boolean {
  let slashes = 0;
  for (let i = pos - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/** Inline-code spans of one line — a `$` inside them is code, not math. */
function inlineCodeSpans(text: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('`', pos);
    if (start === -1) break;
    let ticks = 1;
    while (text[start + ticks] === '`') ticks++;
    const needle = '`'.repeat(ticks);
    const end = text.indexOf(needle, start + ticks);
    if (end === -1) break;
    spans.push({ from: start, to: end + ticks });
    pos = end + ticks;
  }
  return spans;
}

const isInsideAny = (
  pos: number,
  spans: readonly { from: number; to: number }[],
): boolean => spans.some((span) => pos >= span.from && pos < span.to);

/**
 * Closing `$` for an inline formula opened at `open`, or -1.
 *
 * Pandoc's rule, which is what keeps prices out: the character after the
 * opening `$` may not be whitespace, the one before the closing `$` may
 * not be whitespace, and a digit may not follow the closing `$`. So
 * `$x$` matches while `付了 $5，找零 $2` does not.
 */
function inlineMathClose(
  text: string,
  open: number,
  codeSpans: readonly { from: number; to: number }[],
): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let j = open + 2; j < text.length; j++) {
    if (text[j] !== '$') continue;
    if (isEscaped(text, j)) continue;
    // A closing delimiter inside inline code means the two constructs
    // interleave — treat the whole thing as not-math.
    if (isInsideAny(j, codeSpans)) return -1;
    if (/\s/.test(text[j - 1])) continue;
    const after = text[j + 1];
    if (after !== undefined && /[0-9]/.test(after)) continue;
    return j;
  }
  return -1;
}

/** Next unescaped `$$` at or after `from`, or -1. */
function findDisplayClose(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '$') continue;
    if (isEscaped(text, i)) continue;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------
// Markdown parser extension
//
// Decorations alone can't keep markdown out of a formula: the SYNTAX
// HIGHLIGHTER styles whatever lezer parsed, and lezer happily pairs the
// `_` of `$\mathfrak{T}_\Gamma$` with the one in a later
// `$\mathfrak{E}_\Gamma$` — italicizing the prose between the two
// formulas, with no decoration of ours involved. The only real fix is to
// stop the parser from looking inside math at all, so `$…$` is consumed
// here as one opaque inline node before Emphasis gets a chance.

const DOLLAR = 36; // '$'

/** Length of the math run starting at `text[0] === '$'`, or -1. */
function mathRunLength(text: string): number {
  if (text.charCodeAt(1) === DOLLAR) {
    const close = findDisplayClose(text, 2);
    // `$$$$` is empty, not a formula.
    if (close === -1 || close === 2) return -1;
    return close + 2;
  }
  const close = inlineMathClose(text, 0, []);
  return close === -1 ? -1 : close + 1;
}

/**
 * Markdown parser extension pairing with `mathBlocks()`: `$…$` / `$$…$$`
 * parse as one opaque `InlineMath` node, so no markdown construct can
 * start, end, or pair inside a formula.
 *
 * Delimiter rules are shared with the scanner, so the two agree. They can
 * still diverge at the margins (the scanner also skips fenced code and
 * frontmatter, which the block parser has already excluded here; a `$$`
 * block containing a blank line is one formula to the scanner but two
 * paragraphs to markdown) — harmless in both directions: the widget
 * covers whatever the highlighter did, and a skipped node just renders
 * as ordinary text.
 */
export const mathMarkdownSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }],
  parseInline: [
    {
      name: 'InlineMath',
      // After InlineCode (so `` `$x$` `` stays code), before Emphasis.
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        const length = mathRunLength(cx.slice(pos, cx.end));
        if (length < 0) return -1;
        return cx.addElement(cx.elt('InlineMath', pos, pos + length));
      },
    },
  ],
};

/**
 * All math spans in the document, in document order.
 *
 * Skipped regions: fenced code, YAML frontmatter, inline code. An
 * unterminated `$$` is dropped entirely — otherwise the rest of the note
 * would flash as one giant formula while the opening delimiter is typed.
 */
export function scanMathSpans(doc: Text): MathSpan[] {
  const spans: MathSpan[] = [];
  let fenceMarker: string | null = null;
  let fenceLength = 0;
  let inFrontmatter = false;
  // Open `$$` carried across lines.
  let open: { from: number; texFrom: number; prefixBlank: boolean } | null = null;

  let lineNumber = 0;
  let lineFrom = 0;
  for (const text of doc.iterLines()) {
    lineNumber++;
    const from = lineFrom;
    lineFrom += text.length + 1;

    if (!open) {
      if (lineNumber === 1 && FRONTMATTER_OPEN_RE.test(text)) {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (FRONTMATTER_CLOSE_RE.test(text)) inFrontmatter = false;
        continue;
      }
      const fence = FENCE_RE.exec(text);
      if (fenceMarker) {
        if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength) {
          fenceMarker = null;
          fenceLength = 0;
        }
        continue;
      }
      if (fence) {
        fenceMarker = fence[1][0];
        fenceLength = fence[1].length;
        continue;
      }
    }

    let col = 0;
    let codeSpans: { from: number; to: number }[] | null = null;

    while (col < text.length) {
      if (open) {
        const close = findDisplayClose(text, col);
        if (close === -1) break; // the whole line is formula body
        spans.push({
          from: open.from,
          to: from + close + 2,
          tex: doc.sliceString(open.texFrom, from + close),
          display: true,
          block: open.prefixBlank && isBlank(text.slice(close + 2)),
        });
        open = null;
        col = close + 2;
        continue;
      }

      if (codeSpans === null) codeSpans = inlineCodeSpans(text);

      const dollar = text.indexOf('$', col);
      if (dollar === -1) break;
      if (isEscaped(text, dollar) || isInsideAny(dollar, codeSpans)) {
        col = dollar + 1;
        continue;
      }

      if (text[dollar + 1] === '$') {
        const close = findDisplayClose(text, dollar + 2);
        if (close === dollar + 2) {
          // `$$$$` — empty, not math.
          col = close + 2;
          continue;
        }
        if (close !== -1) {
          spans.push({
            from: from + dollar,
            to: from + close + 2,
            tex: text.slice(dollar + 2, close),
            display: true,
            block: isBlank(text.slice(0, dollar)) && isBlank(text.slice(close + 2)),
          });
          col = close + 2;
          continue;
        }
        open = {
          from: from + dollar,
          texFrom: from + dollar + 2,
          prefixBlank: isBlank(text.slice(0, dollar)),
        };
        break;
      }

      const close = inlineMathClose(text, dollar, codeSpans);
      if (close === -1) {
        col = dollar + 1;
        continue;
      }
      spans.push({
        from: from + dollar,
        to: from + close + 1,
        tex: text.slice(dollar + 1, close),
        display: false,
        block: false,
      });
      col = close + 1;
    }
  }

  return spans;
}

// ---------------------------------------------------------------------
// Widget

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly block: boolean,
  ) {
    super();
  }

  // Identity is the source only, so a cursor move elsewhere rebuilds the
  // decoration set while CM6 keeps this widget's already-rendered DOM.
  eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.display === this.display &&
      other.block === this.block
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement(this.block ? 'div' : 'span');
    wrap.className = this.block
      ? 'cm-atomic-math cm-atomic-math-block'
      : 'cm-atomic-math cm-atomic-math-inline';
    wrap.setAttribute('contenteditable', 'false');

    const paint = (result: MathResult): void => {
      wrap.classList.remove('cm-atomic-math-pending');
      if (result.html) {
        // Safe by construction — see `trust: false` in renderWithKatex.
        wrap.innerHTML = result.html;
        return;
      }
      wrap.classList.add('cm-atomic-math-error');
      wrap.textContent = this.tex;
      wrap.title = result.error ?? 'KaTeX failed';
    };

    const cached = renderMathSync(this.tex, this.display);
    if (cached) {
      paint(cached);
    } else {
      // First formula of the session: hold the raw source (dimmed) so
      // the line doesn't collapse to nothing while KaTeX loads.
      wrap.classList.add('cm-atomic-math-pending');
      wrap.textContent = this.tex;
      void renderMath(this.tex, { display: this.display }).then((result) => {
        paint(result);
        // Height changed — keep the block heightmap and scroll honest.
        view.requestMeasure();
      });
    }

    if (this.block) {
      // Click the formula to drop the caret onto its source — the same
      // affordance mermaid diagrams and images use. Inert in read-only
      // mode: the preview stays rendered, never reveals.
      wrap.addEventListener('mousedown', (event) => {
        if (view.state.readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        const pos = view.posAtDOM(wrap);
        if (pos < 0) return;
        view.focus();
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
      });
    }

    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    // Inline widgets keep default handling so a click lands the caret at
    // the near edge (CM6 maps it to `from`/`to`) and reveals the source.
    if (!this.block) return false;
    return event.type === 'mousedown' || event.type === 'click';
  }
}

// ---------------------------------------------------------------------
// Decorations

interface MathState {
  /** Doc-order spans; recomputed only when the document changes. */
  spans: MathSpan[];
  decorations: DecorationSet;
  /**
   * Pointer-down freeze, mirrored from inline-preview's mouse plugin.
   * Tracked here rather than read off `previewFrozenField` so this field
   * never depends on StateField initialization order.
   */
  frozen: boolean;
}

function buildMathDecorations(state: EditorState, spans: MathSpan[]): DecorationSet {
  if (spans.length === 0) return Decoration.none;

  const { doc } = state;
  const ranges: Range<Decoration>[] = [];
  const focused = state.field(focusedField);

  // Inclusive on both ends: a cursor sitting exactly on a delimiter
  // already reveals the source, since the next keystroke edits it.
  const selTouches = (from: number, to: number): boolean =>
    focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

  for (const span of spans) {
    const widget = new MathWidget(span.tex, span.display, span.block);
    if (span.block) {
      // Block decorations must cover whole lines, and a block reveals
      // when the cursor is anywhere on those lines (mermaid's rule).
      const firstLine = doc.lineAt(span.from);
      const lastLine = doc.lineAt(span.to);
      if (selTouches(firstLine.from, lastLine.to)) continue;
      ranges.push(
        Decoration.replace({ widget, block: true }).range(firstLine.from, lastLine.to),
      );
    } else {
      if (selTouches(span.from, span.to)) continue;
      ranges.push(Decoration.replace({ widget }).range(span.from, span.to));
    }
  }

  return Decoration.set(ranges, true);
}

export const mathField = StateField.define<MathState>({
  create(state) {
    const spans = scanMathSpans(state.doc);
    return {
      spans,
      decorations: buildMathDecorations(state, spans),
      frozen: false,
    };
  },
  update(value, tr) {
    const frozen = nextFrozen(value.frozen, tr.effects);
    const justUnfroze = value.frozen && !frozen;

    // A doc change is unambiguous edit intent — rebuild even while frozen,
    // since stale ranges would no longer match the document.
    if (tr.docChanged) {
      const spans = scanMathSpans(tr.state.doc);
      return {
        spans,
        decorations: buildMathDecorations(tr.state, spans),
        frozen,
      };
    }
    // Pointer is down: hold the decorations exactly as they are. Collapsing
    // a revealed block here would shift the content under the mouse mid-
    // click, and CM6 would resolve the press into a drag-selection running
    // to wherever the text moved (see editor-interaction's freeze note).
    if (frozen && !justUnfroze) {
      return frozen === value.frozen ? value : { ...value, frozen };
    }
    // Focus flip, cursor move, or the freeze lifting → the reveal state may
    // change; the spans themselves are doc-derived and stay valid.
    if (
      justUnfroze ||
      !tr.startState.selection.eq(tr.state.selection) ||
      tr.effects.some((effect) => effect.is(setEditorFocused))
    ) {
      return {
        spans: value.spans,
        decorations: buildMathDecorations(tr.state, value.spans),
        frozen,
      };
    }
    return frozen === value.frozen ? value : { ...value, frozen };
  },
  provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
});

/**
 * Does `[from, to)` cross a formula boundary, or sit inside one?
 *
 * Used by inline-preview to leave markdown syntax around formulas
 * alone. Two cases matter, and the second is the one that bites:
 *
 *   - A node INSIDE a formula: `\\`, `_` and `*` are TeX there, and
 *     hiding them would corrupt the source the user sees on reveal.
 *   - A node STRADDLING a boundary: the `_` in `$\mathfrak{T}_\Gamma$`
 *     pairs with the one in `$\mathfrak{E}_\Gamma$` further along the
 *     line, and lezer duly reports one Emphasis spanning both — which
 *     italicizes the prose BETWEEN the two formulas.
 *
 * A node that fully CONTAINS a formula (the paragraph, or a `**bold**`
 * run wrapping it) is neither — the walk descends into it as usual.
 */
export function overlapsMathSyntax(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const spans = state.field(mathField, false)?.spans;
  if (!spans || spans.length === 0) return false;
  // Binary search for the first span that can reach `from`; spans are
  // doc-ordered and non-overlapping.
  let lo = 0;
  let hi = spans.length - 1;
  let first = spans.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].to > from) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  for (let i = first; i < spans.length && spans[i].from < to; i++) {
    if (from <= spans[i].from && to >= spans[i].to) continue;
    return true;
  }
  return false;
}

/** Is `pos` inside a formula (delimiters included)? */
export function isMathPosition(state: EditorState, pos: number): boolean {
  const spans = state.field(mathField, false)?.spans;
  if (!spans) return false;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (pos < span.from) hi = mid - 1;
    else if (pos >= span.to) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Obsidian-style live preview for TeX math: `$$…$$` renders as a
 * centered block, `$…$` inline; the raw source returns when the cursor
 * touches the formula (or, for a block, any of its lines).
 */
export function mathBlocks(): Extension {
  return [focusedField, mathField, focusWatcher];
}
