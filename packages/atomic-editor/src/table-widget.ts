import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  Facet,
  Prec,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { normalizeLinkUrl } from './inline-preview';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';
import { findWikiLinksInLine, type ParsedWikiLink, type WikiLinkStatus } from './wiki-links';

// GFM tables as a WYSIWYG block widget.
//
// Strategy: replace the entire Table node in the source with a block
// Decoration.replace widget. The widget renders an HTML `<table>`
// whose `<th>` / `<td>` cells are `contenteditable`. Editing flows
// DOM → source: on every cell `input` event we re-serialize the
// widget's DOM state to markdown and dispatch a single change that
// replaces the table's current source range. Source → DOM is handled
// by the StateField rebuilding a widget from the parsed tree, but
// crucially our widget's `eq` is structure-only: same row/col count
// returns true, so CM6 keeps the existing DOM across keystrokes and
// the caret / focus survive.
//
// Tab / Shift-Tab move focus between cells. Tab past the last cell
// appends a new row and focuses its first cell. Backspace/Delete
// inside a cell uses browser default (per-char). Outside the widget
// (at the table's atomic boundary), CM6's atomic-range handling
// deletes the whole table as one unit — matching Obsidian's "table
// is a unit" feel.
//
// Scope cuts deliberately left out of v1:
//   - Column alignment (`:---`, `---:`, `:---:`) — parsed but dropped;
//     all cells render left-aligned.
//   - Rich content inside cells (markdown marks, links, etc.).
//   - Context-menu operations (add/remove row/column, sort).
//   - Multi-line cell content.
// These are incremental, non-architectural adds; they can land later
// without changing the widget's core shape.

// ---- model / parse / serialize --------------------------------------

interface TableModel {
  header: string[];
  rows: string[][];
}

function collectCells(state: EditorState, rowNode: SyntaxNode): string[] {
  // Split the row's raw line on unescaped `|` rather than collecting
  // lezer `TableCell` nodes. lezer emits NO `TableCell` for an empty
  // cell, so a node-based count silently drops blank columns — which
  // is exactly what "Insert column left/right" creates. Counting cells
  // from the pipe-delimited text keeps blank columns (and their
  // positions) intact through the parse → serialize round-trip.
  return splitRowCells(state.doc.lineAt(rowNode.from).text);
}

export function splitRowCells(line: string): string[] {
  let s = line.trim();
  // Strip the optional outer pipes so they don't yield phantom empty
  // leading/trailing cells.
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A backslash escapes the next char (e.g. `\|` is a literal pipe in
    // a GFM cell) — keep both and don't treat the pipe as a separator.
    if (ch === '\\' && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function parseTable(state: EditorState, tableNode: SyntaxNode): TableModel | null {
  const header: string[] = [];
  const rows: string[][] = [];

  const cursor = tableNode.cursor();
  if (!cursor.firstChild()) return null;

  do {
    if (cursor.name === 'TableHeader') {
      header.push(...collectCells(state, cursor.node));
    } else if (cursor.name === 'TableRow') {
      rows.push(collectCells(state, cursor.node));
    }
    // TableDelimiter (per-row `|` and whole-line `|---|---|`) is ignored.
  } while (cursor.nextSibling());

  if (header.length === 0) return null;
  return { header, rows };
}

// Escape cell content so it can't break the row's GFM structure: an
// unescaped `|` would split the cell into two columns, and a stray
// newline would terminate the table. A pipe that's already escaped
// (`\|` — e.g. round-tripping content the parser handed us) is left
// alone so serialize is idempotent.
function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
}

export function serializeTable(model: TableModel): string {
  const columnCount = model.header.length;
  const lines: string[] = [];
  lines.push('| ' + model.header.map(escapeCell).join(' | ') + ' |');
  lines.push('| ' + model.header.map(() => '---').join(' | ') + ' |');
  for (const row of model.rows) {
    const padded: string[] = [];
    for (let c = 0; c < columnCount; c++) padded.push(escapeCell(row[c] ?? ''));
    lines.push('| ' + padded.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function readModelFromDom(wrap: HTMLElement): TableModel {
  const header = Array.from(wrap.querySelectorAll<HTMLElement>('thead th')).map(
    readCellSource,
  );
  const rows = Array.from(wrap.querySelectorAll<HTMLElement>('tbody tr')).map(
    (tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>('td')).map(readCellSource),
  );
  return { header, rows };
}

// A cell's raw markdown lives in `dataset.raw` — the source of truth
// that `readModelFromDom` reads when serializing the table back to
// markdown. The inner `.cm-atomic-table-cell-source` element displays
// an escape-stripped view of that raw text so RSS-ingested cells
// don't show `\.` / `\(` / `\-` style literal backslashes in the
// reader; the input handler pulls innerText back to dataset.raw on
// every keystroke (any escapes the user types get preserved there,
// but won't round-trip back through stripEscapes on re-render —
// acceptable tradeoff because the escapes are typically ingestion
// artifacts users don't want to preserve anyway).
function readCellSource(cell: HTMLElement): string {
  return (cell.dataset.raw ?? '').trim();
}

function getCellSource(cell: HTMLElement): HTMLElement | null {
  return cell.querySelector<HTMLElement>('.cm-atomic-table-cell-source');
}

// Flatten a model into the same cell order `getAllCells` yields: the
// header cells first, then each body row padded to the column count.
// Used by `updateDOM` to diff the model against the live DOM cell-by-cell.
// Exported for tests.
export function flattenModelCells(model: TableModel): string[] {
  const colCount = model.header.length;
  const cells = [...model.header];
  for (const row of model.rows) {
    for (let c = 0; c < colCount; c++) cells.push(row[c] ?? '');
  }
  return cells;
}

// ---- inline-mark parsing for cell source --------------------------------

// Cells render a subset of inline markdown — bold, italic, strikethrough,
// links, wiki links, and inline code spans. No lists/blocks (cells are
// single-line by construction), no images (handled by the separate
// cell-preview strip).
//
// Recognition is delegated to the SAME lezer GFM grammar the outer editor
// uses (`markdownLanguage.parser`) rather than a private set of regexes.
// This is the whole point: a cell and the surrounding prose now agree on
// what is bold / code / a link, down to CommonMark flanking rules — there
// is no second, subtly-different recognizer to drift. The tree-walk below
// turns lezer's inline nodes into the `CellToken`s the DOM renderer wants;
// only rendering + caret interaction stay cell-specific (a widget's DOM is
// out of reach of CM6 decorations, so it can't reuse the prose renderer).
//
// Two things are NOT in the grammar and stay cell-local, exactly as they
// are in prose (where a separate extension handles them):
//   - Wiki links `[[…]]` — carved out via sentinels before parsing (see
//     `substituteWikiLinks`), because lezer would mangle `[[x]]`.
//   - The GFM table rule that `\|` is a literal pipe even inside a code
//     span — `renderCellToken`/`escapeCell` own that normalization; here
//     a code token just carries the raw content.

type CellToken =
  | { type: 'text'; text: string }
  | { type: 'strong'; delim: '**' | '__'; children: CellToken[] }
  | { type: 'em'; delim: '*' | '_'; children: CellToken[] }
  | { type: 'strike'; children: CellToken[] }
  | { type: 'link'; textChildren: CellToken[]; url: string }
  | { type: 'wikiLink'; target: string; label: string | null }
  | { type: 'code'; fence: string; text: string };

// The editor's GFM parser (tables, strikethrough, autolinks…). Parsing a
// cell string with this exact grammar is what keeps cells and prose in sync.
const CELL_PARSER = markdownLanguage.parser;

// Private-use sentinels wrapping a wiki-link index. A wiki span is replaced
// with `\uE000<index>\uE001` BEFORE lezer parses, so the grammar treats it
// as opaque text (lezer has no wiki concept — it would split `[[x]]` into a
// nested Link). The sentinel is resolved back to a wikiLink token when a
// text run is emitted, so a wiki link nested in emphasis (`**[[x]]**`) still
// works. PUA chars don't collide with real content and read as ordinary
// letters to the grammar's flanking rules.
const WIKI_OPEN = '\uE000';
const WIKI_CLOSE = '\uE001';
const WIKI_SENTINEL_RE = new RegExp(`${WIKI_OPEN}(\\d+)${WIKI_CLOSE}`, 'g');

export function parseCellInline(raw: string): CellToken[] {
  if (!raw) return [];
  // Reuse the prose wiki-link scanner (single source of truth for the
  // `[[…]]` syntax + code-span skipping). Standalone string → lineStart 0;
  // the extra labelFrom/labelTo it returns are unused here.
  const wikis = findWikiLinksInLine(raw, 0);
  const src = substituteWikiLinks(raw, wikis);
  const out: CellToken[] = [];
  walkInline(wikis, out, src, CELL_PARSER.parse(src).topNode, 0, src.length);
  return out;
}

// Walk a node's inline children over [from, to), emitting tokens into `out`
// and filling the text gaps between children. `from`/`to` let callers scope
// to a mark's inner content (excluding its delimiters).
function walkInline(
  wikis: readonly ParsedWikiLink[],
  out: CellToken[],
  s: string,
  node: SyntaxNode,
  from: number,
  to: number,
): void {
  let pos = from;
  let child = node.firstChild;
  while (child) {
    if (child.from >= to) break;
    if (child.to <= from) {
      child = child.nextSibling;
      continue;
    }
    if (child.from > pos) emitText(wikis, out, s.slice(pos, child.from));
    handleInlineNode(wikis, out, s, child);
    pos = child.to;
    child = child.nextSibling;
  }
  if (pos < to) emitText(wikis, out, s.slice(pos, to));
}

function handleInlineNode(
  wikis: readonly ParsedWikiLink[],
  out: CellToken[],
  s: string,
  node: SyntaxNode,
): void {
  switch (node.name) {
    case 'Document':
    case 'Paragraph':
      // Transparent containers — descend and keep emitting into `out`.
      walkInline(wikis, out, s, node, node.from, node.to);
      return;
    case 'Escape':
      // `\x` renders as the escaped char (backslash dropped) — same as
      // prose. In a cell this also turns `\|` into a literal `|`.
      emitText(wikis, out, s.slice(node.from + 1, node.to));
      return;
    case 'Emphasis':
    case 'StrongEmphasis': {
      const strong = node.name === 'StrongEmphasis';
      const mark = firstChildNamed(node, 'EmphasisMark');
      const delim = mark ? s.slice(mark.from, mark.to) : strong ? '**' : '*';
      const [innerFrom, innerTo] = markInnerRange(node, 'EmphasisMark');
      const children: CellToken[] = [];
      walkInline(wikis, children, s, node, innerFrom, innerTo);
      out.push(
        strong
          ? { type: 'strong', delim: delim === '__' ? '__' : '**', children }
          : { type: 'em', delim: delim === '_' ? '_' : '*', children },
      );
      return;
    }
    case 'Strikethrough': {
      const [innerFrom, innerTo] = markInnerRange(node, 'StrikethroughMark');
      const children: CellToken[] = [];
      walkInline(wikis, children, s, node, innerFrom, innerTo);
      out.push({ type: 'strike', children });
      return;
    }
    case 'InlineCode': {
      const marks = childrenNamed(node, 'CodeMark');
      const open = marks[0];
      const close = marks[marks.length - 1];
      const fence = open ? s.slice(open.from, open.to) : '`';
      const text =
        marks.length >= 2 ? s.slice(open.to, close.from) : s.slice(node.from, node.to);
      // Store the raw content (may hold `\|`); renderCellToken unescapes it
      // for display and escapeCell re-adds it on serialize.
      out.push({ type: 'code', fence, text });
      return;
    }
    case 'Link': {
      const url = firstChildNamed(node, 'URL');
      const marks = childrenNamed(node, 'LinkMark');
      if (url && marks.length >= 2) {
        const children: CellToken[] = [];
        walkInline(wikis, children, s, node, marks[0].to, marks[1].from);
        const urlText = s.slice(url.from, url.to);
        // Only accept a link whose decorated form round-trips to the exact
        // source (a simple `[text](url)`). Titles, reference/auto links, and
        // escaped brackets fail this check and fall through to raw text — so
        // editing a cell can never silently drop link syntax it can't rebuild.
        if (`[${cellTokenText(children)}](${urlText})` === s.slice(node.from, node.to)) {
          out.push({ type: 'link', textChildren: children, url: urlText });
          return;
        }
      }
      emitText(wikis, out, s.slice(node.from, node.to));
      return;
    }
    default:
      // Anything we don't model (images, HTML, reference links…) is emitted
      // as its raw source, so `textContent` still round-trips.
      emitText(wikis, out, s.slice(node.from, node.to));
      return;
  }
}

// Emit a text slice, resolving any wiki sentinels back to wikiLink tokens
// and coalescing adjacent plain text into one token.
function emitText(wikis: readonly ParsedWikiLink[], out: CellToken[], text: string): void {
  if (!text) return;
  WIKI_SENTINEL_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_SENTINEL_RE.exec(text))) {
    if (m.index > last) pushText(out, text.slice(last, m.index));
    const w = wikis[Number(m[1])];
    if (w) out.push({ type: 'wikiLink', target: w.target, label: w.label });
    last = WIKI_SENTINEL_RE.lastIndex;
  }
  if (last < text.length) pushText(out, text.slice(last));
}

function pushText(out: CellToken[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

// The text a token tree renders to (its eventual `textContent`, including
// hidden delimiter marks). Mirrors renderCellToken's `\|`→`|` unescape for
// code so it is a faithful model. Used to gate links on exact round-trip.
export function cellTokenText(tokens: readonly CellToken[]): string {
  let s = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        s += t.text;
        break;
      case 'strong':
      case 'em':
        s += t.delim + cellTokenText(t.children) + t.delim;
        break;
      case 'strike':
        s += `~~${cellTokenText(t.children)}~~`;
        break;
      case 'code':
        s += t.fence + t.text.replace(/\\\|/g, '|') + t.fence;
        break;
      case 'link':
        s += `[${cellTokenText(t.textChildren)}](${t.url})`;
        break;
      case 'wikiLink':
        s += t.label === null ? `[[${t.target}]]` : `[[${t.target}|${t.label}]]`;
        break;
    }
  }
  return s;
}

// ---- lezer node helpers ----

function childrenNamed(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) out.push(c);
  }
  return out;
}

function firstChildNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) return c;
  }
  return null;
}

// The content range of a delimited mark: between its first and last
// delimiter child. Falls back to the whole node if delimiters are absent.
function markInnerRange(node: SyntaxNode, markName: string): [number, number] {
  const marks = childrenNamed(node, markName);
  return marks.length
    ? [marks[0].to, marks[marks.length - 1].from]
    : [node.from, node.to];
}

// ---- wiki-link pre-scan (not part of the markdown grammar) ----

// Replace each wiki span with a `\uE000<index>\uE001` sentinel so lezer
// parses around it. Non-wiki text (including code spans and their inner
// `[[…]]`) is left untouched.
function substituteWikiLinks(raw: string, wikis: readonly ParsedWikiLink[]): string {
  if (!wikis.length) return raw;
  let out = '';
  let pos = 0;
  wikis.forEach((w, idx) => {
    out += raw.slice(pos, w.from) + WIKI_OPEN + idx + WIKI_CLOSE;
    pos = w.to;
  });
  return out + raw.slice(pos);
}


// Build the decorated DOM for a cell's source. The parser strips
// CommonMark backslash escapes inline (so `\*` emits a literal `*`
// text node); the fragment's `textContent` equals the escape-stripped
// raw. The cell's input handler reads `textContent` to update
// `dataset.raw` — round-trip is one-way for escapes (same as the
// pre-markdown-in-cells behavior), but fully preserves every inline
// mark delimiter because those live in `display: none` spans inside
// the DOM rather than being derived on serialize.
function buildCellSourceDom(raw: string, wiki?: TableWikiLinkConfig): DocumentFragment {
  const frag = document.createDocumentFragment();
  const tokens = parseCellInline(raw);
  for (const tok of tokens) frag.appendChild(renderCellToken(tok, wiki));
  return frag;
}

function renderCellToken(tok: CellToken, wiki?: TableWikiLinkConfig): Node {
  if (tok.type === 'text') {
    return document.createTextNode(tok.text);
  }

  // Inline code. The fence backticks live in `display: none`
  // `.cm-atomic-mark` spans (so `textContent` round-trips to the raw
  // `` `…` ``), while `.cm-atomic-inline-code` shows the content. The
  // structural `\|` escape a cell pipe carries is unescaped for display
  // only — `escapeCell` re-adds it on serialize. Wrapped in a registered
  // mark wrap so the caret entering it reveals the fences for editing.
  if (tok.type === 'code') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-code-wrap';
    wrap.appendChild(makeCellMark(tok.fence));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-inline-code';
    inner.textContent = tok.text.replace(/\\\|/g, '|');
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.fence));
    return wrap;
  }

  // Wiki link `[[target|label]]`. Shape mirrors the outer editor's
  // hidden-syntax rendering: `[[`, the target (when a separate label is
  // present), and `]]` live in `display: none` `.cm-atomic-mark` spans
  // (so `textContent` still round-trips to the raw `[[…]]`), while the
  // visible `.cm-atomic-wiki-link` carries the label/target and the
  // `data-wiki-link-target` the click handler reads to open it. Wrapping
  // in `.cm-atomic-wiki-wrap` (a registered mark wrap) means the caret
  // entering it reveals the delimiters for editing, same as bold/link.
  if (tok.type === 'wikiLink') {
    // Only decorate when wiki links are actually wired up (an opener is
    // provided). Without support, render the raw `[[…]]` as plain text so
    // tables in editors that don't enable wiki links don't show a dead
    // styled link — matching how the outer editor leaves `[[…]]` raw.
    if (!wiki?.onOpen) {
      const raw = tok.label === null ? `[[${tok.target}]]` : `[[${tok.target}|${tok.label}]]`;
      return document.createTextNode(raw);
    }
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-wiki-wrap';
    wrap.appendChild(makeCellMark('[['));
    if (tok.label !== null) {
      wrap.appendChild(makeCellMark(tok.target));
      wrap.appendChild(makeCellMark('|'));
    }
    const link = document.createElement('span');
    const status = wiki?.resolveStatus?.(tok.target);
    link.className = `cm-atomic-wiki-link${status ? ` cm-atomic-wiki-link-${status}` : ''}`;
    link.dataset.wikiLinkTarget = tok.target;
    // Label-less links may show a shortened form of the target (via
    // `displayTarget`); the trimmed tail goes into a `display: none` mark so
    // `textContent` still round-trips to the raw `[[target]]`. Only a strict
    // prefix can be shortened this way — anything else shows the full target.
    let visible = tok.target;
    let hiddenTail = '';
    if (tok.label === null && wiki?.displayTarget) {
      const display = wiki.displayTarget(tok.target);
      if (display && display !== tok.target && tok.target.startsWith(display)) {
        visible = display;
        hiddenTail = tok.target.slice(display.length);
      }
    }
    link.textContent = tok.label ?? visible;
    wrap.appendChild(link);
    if (hiddenTail) wrap.appendChild(makeCellMark(hiddenTail));
    wrap.appendChild(makeCellMark(']]'));
    return wrap;
  }

  if (tok.type === 'strong') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strong-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strong';
    inner.appendChild(renderTokensTo(tok.children, wiki));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'em') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-em-wrap';
    wrap.appendChild(makeCellMark(tok.delim));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-em';
    inner.appendChild(renderTokensTo(tok.children, wiki));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark(tok.delim));
    return wrap;
  }

  if (tok.type === 'strike') {
    const wrap = document.createElement('span');
    wrap.className = 'cm-atomic-strike-wrap';
    wrap.appendChild(makeCellMark('~~'));
    const inner = document.createElement('span');
    inner.className = 'cm-atomic-strike';
    inner.appendChild(renderTokensTo(tok.children, wiki));
    wrap.appendChild(inner);
    wrap.appendChild(makeCellMark('~~'));
    return wrap;
  }

  // Link. Shape mirrors the outer-editor markup: `.cm-atomic-link` on
  // the visible text (picks up link color; the whole text is the
  // click-to-open affordance, like a wiki link — no trailing icon),
  // faint marks for `[`, `]`, `(`, URL, `)`. `data-url` lets the
  // cell-source click handler open the right URL without re-parsing.
  const wrap = document.createElement('span');
  wrap.className = 'cm-atomic-link-wrap';
  wrap.dataset.url = tok.url;
  wrap.appendChild(makeCellMark('['));
  const inner = document.createElement('span');
  inner.className = 'cm-atomic-link';
  inner.appendChild(renderTokensTo(tok.textChildren, wiki));
  wrap.appendChild(inner);
  wrap.appendChild(makeCellMark(']'));
  wrap.appendChild(makeCellMark('('));
  const urlMark = makeCellMark(tok.url);
  urlMark.classList.add('cm-atomic-link-url');
  wrap.appendChild(urlMark);
  wrap.appendChild(makeCellMark(')'));
  return wrap;
}

function renderTokensTo(tokens: CellToken[], wiki?: TableWikiLinkConfig): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const tok of tokens) frag.appendChild(renderCellToken(tok, wiki));
  return frag;
}

function makeCellMark(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cm-atomic-mark';
  el.textContent = text;
  return el;
}

// Render a cell source element in its decorated form. Safe to call
// multiple times — overwrites whatever was there.
//
// Marks start collapsed: all `.cm-atomic-mark` descendants (delimiters
// like `**`, `_`, `~~`, `[`, `]`, `(`, `)`, and URL text) are hidden
// via CSS by default. When the caret enters a mark wrap, JS adds an
// `active` class that reveals that wrap's delimiters — mirroring the
// outer editor's cursor-inside-link unfold for every inline mark.
function renderCellSourceDecorated(source: HTMLElement, wiki?: TableWikiLinkConfig): void {
  const raw = source.parentElement?.dataset.raw ?? '';
  source.replaceChildren(buildCellSourceDom(raw, wiki));
}

// Caret utilities — encode positions as character offsets within the
// element's textContent so we can survive the full-DOM re-render that
// follows every keystroke (new marks need to decorate immediately;
// the whole tree rebuilds from scratch).

function getCaretCharOffset(container: HTMLElement): number | null {
  const selection = container.ownerDocument?.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretCharOffset(container: HTMLElement, offset: number): void {
  const doc = container.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    // Offset past the end — place caret at the container's end.
    range.selectNodeContents(container);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

const MARK_WRAP_CLASSES = [
  'cm-atomic-strong-wrap',
  'cm-atomic-em-wrap',
  'cm-atomic-strike-wrap',
  'cm-atomic-link-wrap',
  'cm-atomic-wiki-wrap',
  'cm-atomic-code-wrap',
];

function isMarkWrap(el: Element): boolean {
  for (const c of MARK_WRAP_CLASSES) if (el.classList.contains(c)) return true;
  return false;
}

// Reveal the delimiters of whatever mark wrap(s) contain the caret,
// and collapse every other wrap in this cell. Walks from the caret
// anchor up to the source element, flagging every ancestor mark wrap
// so nested marks (bold-containing-italic) all reveal together — the
// user sees the full structure around their caret.
function updateActiveMarkForSource(source: HTMLElement): void {
  // Clear existing `active` classes within this cell only — other
  // cells track their own state via their own focus lifecycle.
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }

  const doc = source.ownerDocument;
  if (!doc) return;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const anchor = selection.anchorNode;
  if (!anchor || !source.contains(anchor)) return;

  let node: Node | null = anchor;
  while (node && node !== source) {
    if (node instanceof Element && isMarkWrap(node)) {
      node.classList.add('active');
    }
    node = node.parentNode;
  }
}

function clearActiveMarksInSource(source: HTMLElement): void {
  for (const el of source.querySelectorAll('.active')) {
    el.classList.remove('active');
  }
}

interface CellImage {
  src: string;
  alt: string;
}

// Scan raw markdown for `![alt](url)` occurrences. The regex bans `]`
// inside the alt and whitespace inside the URL so we fail closed on
// malformed sources rather than embedding a broken preview.
function extractCellImages(text: string): CellImage[] {
  const imgs: CellImage[] = [];
  const re = /!\[([^\]]*)\]\(([^\s)"']+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of text.matchAll(re)) {
    imgs.push({ alt: match[1] || '', src: match[2] });
  }
  return imgs;
}

// Refresh (or remove) the image-preview strip that sits below the
// source line. Mirrors how images render outside tables: the
// `![alt](url)` markdown is the source of truth, but on an inactive
// cell (no focus inside) the raw source hides and only the rendered
// image remains visible. `data-has-image` flips on for that CSS hook.
function refreshCellPreview(cell: HTMLElement): void {
  const existing = cell.querySelector<HTMLElement>('.cm-atomic-table-cell-preview');
  if (existing) existing.remove();

  const text = cell.dataset.raw ?? '';
  const imgs = extractCellImages(text);
  if (imgs.length === 0) {
    delete cell.dataset.hasImage;
    return;
  }
  cell.dataset.hasImage = 'true';

  const preview = document.createElement('div');
  preview.className = 'cm-atomic-table-cell-preview';
  // Preview is visual only — no caret, no contenteditable scope.
  // Keeping it out of contenteditable also means clicking the image
  // won't create a phantom caret position at the preview boundary.
  preview.contentEditable = 'false';

  for (const { src, alt } of imgs) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.loading = 'lazy';
    img.className = 'cm-atomic-table-cell-image';
    // Clicking the image puts the caret in the source text so the
    // user can edit the underlying markdown — same affordance as
    // clicking a block-level image outside a table.
    img.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = getCellSource(cell);
      if (!source) return;
      source.focus();
      placeCaretAtEnd(source);
    });
    preview.appendChild(img);
  }

  cell.appendChild(preview);
}

// ---- position resolution --------------------------------------------

// posAtDOM on a block-replace widget returns the start of the replaced
// range. Walk the tree from there to find the enclosing Table node so
// our dispatch targets the current range (positions shift as the user
// types — we can't rely on the from/to captured at widget creation).
function findCurrentTableRange(
  view: EditorView,
  dom: HTMLElement,
): { from: number; to: number } | null {
  const pos = view.posAtDOM(dom);
  if (pos < 0) return null;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (node) return { from: node.from, to: node.to };

  // Fallback: scan for the nearest Table node containing or starting
  // at pos. Rare — resolveInner + parent walk handles almost every
  // case — but guards against parser edge cases.
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'Table') return undefined;
      if (n.from <= pos && n.to >= pos) {
        found = n.node;
        return false;
      }
      return undefined;
    },
  });
  if (found) return { from: (found as SyntaxNode).from, to: (found as SyntaxNode).to };
  return null;
}

// ---- DOM helpers ----------------------------------------------------

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function getAllCells(wrap: HTMLElement): HTMLElement[] {
  return Array.from(wrap.querySelectorAll<HTMLElement>('th, td'));
}

// ---- widget ---------------------------------------------------------

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  // Content-aware equality. Two widgets are equal only when they
  // serialize to the same markdown — i.e. identical dimensions AND cell
  // contents. Returning true means CM6 leaves the DOM untouched; false
  // routes through `updateDOM` (in-place reconcile) or, if that bails,
  // `toDOM` (full rebuild). Structure-only equality used to hide content
  // changes from CM6, which meant undo/redo of a cell edit reverted the
  // document but never refreshed the visible table.
  eq(other: TableWidget): boolean {
    return serializeTable(this.model) === serializeTable(other.model);
  }

  // In-place reconcile. Called when `eq` is false but the widget can be
  // patched rather than rebuilt (same dimensions). Update only the cells
  // whose content actually changed; a dimension change returns false so
  // CM6 does a full `toDOM` rebuild instead.
  //
  // Crucially this must refresh EVERY changed cell — including the one the
  // caret is in. During typing the focused cell's content already equals
  // the model (our own `commit` synced the DOM before dispatching), so the
  // equality check below skips it and the caret is never disturbed. During
  // undo/redo the focused cell's content differs from the reverted model,
  // so it must re-render — with the caret preserved. An earlier version
  // blanket-skipped the focused cell, which meant undoing a cell edit
  // reverted the document but never updated the visible cell: undo looked
  // dead until focus moved, then jumped to a stale state.
  //
  // Comparison is normalised through `escapeCell` so a cell the user typed
  // a literal `|` into (`x|y` in `dataset.raw`) matches the parsed model's
  // escaped form (`x\|y`) and isn't re-rendered on every keystroke.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const headerCount = dom.querySelectorAll('thead th').length;
    const bodyRowCount = dom.querySelectorAll('tbody tr').length;
    if (headerCount !== this.model.header.length) return false;
    if (bodyRowCount !== this.model.rows.length) return false;

    const wiki = view.state.facet(tableWikiLinkFacet);
    const wanted = flattenModelCells(this.model);
    const cells = getAllCells(dom);
    if (cells.length !== wanted.length) return false;

    const active = dom.ownerDocument?.activeElement ?? null;
    cells.forEach((cell, i) => {
      const source = getCellSource(cell);
      if (!source) return;
      if (escapeCell((cell.dataset.raw ?? '').trim()) === escapeCell(wanted[i])) return;
      // Preserve the caret when re-rendering the cell the user is in
      // (matters for undo/redo landing on the focused cell).
      const focused = !!active && source.contains(active);
      const caret = focused ? getCaretCharOffset(source) : null;
      cell.dataset.raw = wanted[i];
      renderCellSourceDecorated(source, wiki);
      refreshCellPreview(cell);
      if (caret != null) {
        setCaretCharOffset(source, Math.min(caret, (source.textContent ?? '').length));
      }
    });
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-table';

    const table = document.createElement('table');
    wrap.appendChild(table);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const text of this.model.header) {
      headerRow.appendChild(makeCell('th', text, view));
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const colCount = this.model.header.length;
    for (const row of this.model.rows) {
      const tr = document.createElement('tr');
      for (let c = 0; c < colCount; c++) {
        tr.appendChild(makeCell('td', row[c] ?? '', view));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return wrap;
  }

  // All cell interactions are handled by the listeners we attach in
  // `makeCell`; tell CM6 to stay out of events within the widget so
  // its own selection/click logic doesn't compete with contenteditable.
  ignoreEvent(): boolean {
    return true;
  }
}

function makeCell(
  tag: 'th' | 'td',
  text: string,
  view: EditorView,
): HTMLElement {
  const cell = document.createElement(tag);
  cell.dataset.raw = text;

  // Wiki-link config for this view (opener + status coloring). Read once
  // here; `renderCellSourceDecorated` needs it to decorate `[[…]]` and
  // the click handler below to open targets.
  const wiki = view.state.facet(tableWikiLinkFacet);

  // The cell itself is not contenteditable — only the inner source
  // element is. This keeps the image preview strictly visual (no
  // phantom caret positions around images) while the source text
  // stays in a dedicated editable box above it.
  const source = document.createElement('div');
  source.className = 'cm-atomic-table-cell-source';
  // Read-only viewer: render the cell but keep it non-editable. The outer
  // editor's `editable=false` doesn't reach this widget's own DOM, so the
  // cell would otherwise stay a live contenteditable box.
  const readOnly = view.state.readOnly;
  source.contentEditable = readOnly ? 'false' : 'true';
  source.spellcheck = !readOnly;
  // Decorated DOM on mount. Delimiters (`.cm-atomic-mark`) are
  // `display: none` by default — the caret can't navigate into them,
  // the reader sees a clean rendered view. When the caret enters a
  // mark wrap, JS adds `.active` to reveal that wrap's delimiters —
  // matching the outer-editor cursor-inside-link unfold, applied
  // uniformly to every inline mark inside cells.
  cell.appendChild(source);
  renderCellSourceDecorated(source, wiki);

  // Read-only: the decorated cell is fully rendered above; skip every
  // editing affordance (input/paste/IME commit, caret routing, context
  // menu) so nothing can mutate the document via a direct dispatch.
  if (readOnly) {
    refreshCellPreview(cell);
    // Wiki links stay clickable even in a read-only preview — mirrors the
    // outer editor, whose wiki-link click handler is active regardless of
    // editability. No caret to guard here, so a plain `click` suffices.
    if (wiki.onOpen) {
      source.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const el = event.target;
        const wikiTarget =
          el instanceof Element
            ? el.closest<HTMLElement>('.cm-atomic-wiki-link[data-wiki-link-target]')?.dataset
                .wikiLinkTarget
            : undefined;
        if (!wikiTarget) return;
        event.preventDefault();
        event.stopPropagation();
        wiki.onOpen?.(wikiTarget);
      });
    }
    return cell;
  }

  // Commit the cell's current DOM text to `dataset.raw`, re-render its
  // decorated form (so marks the user just typed — e.g. a new `**` pair
  // — decorate immediately), restore the caret across that rebuild, and
  // push the change into the document.
  const commit = () => {
    // textContent (not innerText) so `display: none` delimiters inside
    // mark wraps are still captured — otherwise a cell containing
    // `**bold**` would serialize to just `bold` on every keystroke.
    const raw = (source.textContent ?? '').replace(/\s+/g, ' ').trim();
    cell.dataset.raw = raw;
    const offset = getCaretCharOffset(source);
    renderCellSourceDecorated(source, wiki);
    if (offset != null) setCaretCharOffset(source, offset);
    updateActiveMarkForSource(source);
    refreshCellPreview(cell);
    dispatchModelFromDom(view, cell);
  };

  // IME / dead-key composition. `commit` rebuilds the contenteditable
  // DOM, and doing that mid-composition cancels the composition session
  // — dropping CJK input, accented characters, and dictation. Suppress
  // every update while composing and run one commit when it ends.
  let composing = false;
  source.addEventListener('compositionstart', () => {
    composing = true;
  });
  source.addEventListener('compositionend', () => {
    composing = false;
    commit();
  });

  source.addEventListener('input', (event) => {
    if (composing || (event as InputEvent).isComposing) return;
    commit();
  });

  // Paste: drop clipboard content in as a single line of plain text.
  // Without this, pasted rich HTML, newlines, or pipes land in the cell
  // verbatim; newlines and `|` corrupt the row. We flatten whitespace
  // and strip markup here, and `escapeCell` neutralizes any literal `|`
  // on serialize.
  source.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const sel = source.ownerDocument.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    commit();
  });

  // Caret-position listeners. `focus` / `mouseup` / `keyup` cover the
  // three ways the caret can land in a new mark without firing an
  // input event (click-to-place, arrow-key nav, tab-into-cell). The
  // update is idempotent — redundant calls cost nothing.
  source.addEventListener('focus', () => updateActiveMarkForSource(source));
  source.addEventListener('mouseup', () => updateActiveMarkForSource(source));
  source.addEventListener('keyup', () => updateActiveMarkForSource(source));

  // Blur: collapse every active wrap so the reader-resting state
  // hides all delimiters.
  source.addEventListener('blur', () => clearActiveMarksInSource(source));

  source.addEventListener('keydown', (event) => {
    // Enter mirrors Tab — advance to the next cell (appending a row past
    // the last one) instead of inserting a line break a single-line cell
    // can't represent. Shift reverses direction for both.
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      moveCellFocus(view, cell, event.shiftKey ? -1 : 1);
      return;
    }

    // Undo / redo. The cell is its own `contenteditable`, so the browser
    // would otherwise run its NATIVE per-element undo — which only shuffles
    // the caret/selection and never touches CM's document (the text never
    // reverts). Intercept the shortcut, block the native undo, and drive
    // CM's history instead so undo reverts document content as expected.
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const isUndo = key === 'z' && !event.shiftKey;
      const isRedo = (key === 'z' && event.shiftKey) || key === 'y';
      if (isUndo || isRedo) {
        event.preventDefault();
        event.stopPropagation();
        (isRedo ? redo : undo)(view);
      }
    }
  });

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(view, cell, event.clientX, event.clientY);
  });

  // Link open. The whole rendered link text is the click-to-open
  // affordance (like a wiki link — no trailing icon). We open on `click`
  // (a proper popup-activation gesture, so `window.open` isn't blocked)
  // and block the caret on `pointerdown` for plain clicks; the
  // `.cm-atomic-link-wrap` carries `data-url`.
  const linkWrapFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const text = target.closest<HTMLElement>('.cm-atomic-link');
    return text?.closest<HTMLElement>('.cm-atomic-link-wrap') ?? null;
  };

  // A plain click on a rendered wiki link opens it (matching the outer
  // editor's `openOnClick`) rather than placing a caret. The visible
  // `.cm-atomic-wiki-link` carries `data-wiki-link-target`.
  const wikiLinkFromEvent = (event: Event): HTMLElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('.cm-atomic-wiki-link[data-wiki-link-target]');
  };
  const hasModifier = (event: MouseEvent): boolean =>
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

  source.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // Block focus / caret placement when pressing a rendered link; the
    // open happens on the following `click`. Modifier-clicks fall through
    // to native caret placement (lets the user select/edit the source).
    if (linkWrapFromEvent(event) && !hasModifier(event)) {
      event.preventDefault();
      return;
    }
    // Same for a wiki link — suppress caret placement so the click opens
    // instead of dropping the cursor into the target.
    if (wikiLinkFromEvent(event) && !hasModifier(event)) event.preventDefault();
  });

  source.addEventListener('click', (event) => {
    const linkWrap = linkWrapFromEvent(event);
    if (linkWrap) {
      if (hasModifier(event)) return;
      const raw = linkWrap.dataset.url;
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      // Normalize the same way the prose path does — a scheme-less
      // destination like `www.baidu.com` would otherwise reach the host's
      // opener as an invalid URL. `normalizeLinkUrl` adds `https://` /
      // `mailto:` as needed and passes explicit schemes through.
      view.state.facet(tableLinkClickFacet)(normalizeLinkUrl(raw));
      return;
    }
    const wiki = wikiLinkFromEvent(event);
    const wikiTarget = wiki?.dataset.wikiLinkTarget;
    if (wikiTarget && !hasModifier(event)) {
      event.preventDefault();
      event.stopPropagation();
      view.state.facet(tableWikiLinkFacet).onOpen?.(wikiTarget);
    }
  });

  // When the cell has an image and the source is visually hidden,
  // clicks land on the cell/image/empty space but not on the source
  // itself. Route every pointerdown inside the cell to a focus on
  // the source so the user can edit regardless of where they tapped.
  // The image's own pointerdown handler already does this, but
  // covers only image hits — this covers empty padding and the
  // space between/around images.
  cell.addEventListener('pointerdown', (event) => {
    // A click on the editable source — including its inner mark spans
    // and text — must keep the browser's native caret placement. Forcing
    // focus-at-end here would yank the caret to the end of the cell
    // whenever the user clicks a styled run (bold/italic/link). Only
    // intercept clicks that land OUTSIDE the source (cell padding, the
    // image preview, the cell box itself) to route focus into it.
    const target = event.target;
    if (target instanceof Node && source.contains(target)) return;
    event.preventDefault();
    source.focus();
    placeCaretAtEnd(source);
  });

  refreshCellPreview(cell);

  return cell;
}

// ---- context menu -------------------------------------------------

function cellRowIndex(cell: HTMLElement): number {
  // Rows are indexed within tbody (header isn't a "row" we can
  // insert-above; header context items are column-only).
  const tr = cell.closest<HTMLElement>('tr');
  const tbody = tr?.closest<HTMLElement>('tbody');
  if (!tr || !tbody) return -1;
  return Array.from(tbody.querySelectorAll<HTMLElement>('tr')).indexOf(tr);
}

function cellColIndex(cell: HTMLElement): number {
  const tr = cell.closest<HTMLElement>('tr');
  if (!tr) return -1;
  return Array.from(tr.querySelectorAll<HTMLElement>('th, td')).indexOf(cell);
}

function dispatchModel(
  view: EditorView,
  wrap: HTMLElement,
  nextModel: TableModel,
): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const next = serializeTable(nextModel);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    // Structural ops (insert/delete row/column) are discrete user
    // actions: isolate them as their own undo step so a "delete row"
    // never merges into adjacent cell typing (and vice-versa). Without
    // this, the annotation-less transaction is join-eligible and CM6
    // silently folds it into a neighbouring edit group.
    annotations: isolateHistory.of('full'),
  });
}

function openCellMenu(
  view: EditorView,
  cell: HTMLElement,
  x: number,
  y: number,
): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const isHeader = cell.tagName === 'TH';
  const row = cellRowIndex(cell);
  const col = cellColIndex(cell);

  const menu = document.createElement('div');
  menu.className = 'cm-atomic-table-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Entries carry a stable `id` + `group` so consumers supplying a custom
  // `renderMenu` (see TablesConfig) can localize labels and lay out their
  // own (e.g. native) menu without matching against the English text.
  type MenuEntry =
    | { kind: 'item'; id: TableMenuItemId; group: 'row' | 'column'; label: string; action: () => void }
    | { kind: 'separator' };
  const entries: MenuEntry[] = [];

  if (!isHeader) {
    entries.push({
      kind: 'item',
      id: 'insertRowAbove',
      group: 'row',
      label: 'Insert row above',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    entries.push({
      kind: 'item',
      id: 'insertRowBelow',
      group: 'row',
      label: 'Insert row below',
      action: () => {
        const m = readModelFromDom(wrap);
        m.rows.splice(row + 1, 0, m.header.map(() => ''));
        dispatchModel(view, wrap, m);
      },
    });
    entries.push({
      kind: 'item',
      id: 'deleteRow',
      group: 'row',
      label: 'Delete row',
      action: () => {
        const m = readModelFromDom(wrap);
        if (row >= 0 && row < m.rows.length) m.rows.splice(row, 1);
        dispatchModel(view, wrap, m);
      },
    });
    entries.push({ kind: 'separator' });
  }

  entries.push({
    kind: 'item',
    id: 'insertColumnLeft',
    group: 'column',
    label: 'Insert column left',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col, 0, '');
      for (const r of m.rows) r.splice(col, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  entries.push({
    kind: 'item',
    id: 'insertColumnRight',
    group: 'column',
    label: 'Insert column right',
    action: () => {
      const m = readModelFromDom(wrap);
      m.header.splice(col + 1, 0, '');
      for (const r of m.rows) r.splice(col + 1, 0, '');
      dispatchModel(view, wrap, m);
    },
  });
  entries.push({
    kind: 'item',
    id: 'deleteColumn',
    group: 'column',
    label: 'Delete column',
    action: () => {
      const m = readModelFromDom(wrap);
      // Guard: don't leave the table with zero columns — lezer
      // wouldn't re-parse that as a Table and the widget would
      // vanish mid-edit. Keeping the last column as the floor.
      if (m.header.length <= 1 || col < 0) return;
      m.header.splice(col, 1);
      for (const r of m.rows) r.splice(col, 1);
      dispatchModel(view, wrap, m);
    },
  });

  // Consumer-supplied renderer (e.g. a native OS menu) takes over presentation.
  // We still own the actions; the consumer just decides how to show them and
  // calls the chosen item's `run()`. Falls through to the default DOM menu when
  // no renderer is configured.
  const renderMenu = view.state.facet(tableRenderMenuFacet);
  if (renderMenu) {
    const items: TableMenuItem[] = entries
      .filter((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item')
      .map(({ id, group, label, action }) => ({ id, group, label, run: action }));
    renderMenu(items, { x, y });
    return;
  }

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  };
  const onDocDown = (event: MouseEvent) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    dismiss();
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') dismiss();
  };

  for (const entry of entries) {
    if (entry.kind === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'cm-atomic-table-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-atomic-table-menu-item';
    btn.textContent = entry.label;
    btn.addEventListener('click', () => {
      entry.action();
      dismiss();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Clip the menu inside the viewport if it overflows.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
  }

  // Deferred listener attach so the current contextmenu→document
  // mousedown cycle doesn't immediately dismiss us.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }, 0);
}

function dispatchModelFromDom(view: EditorView, cell: HTMLElement): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;

  const model = readModelFromDom(wrap);
  const next = serializeTable(model);
  const prev = view.state.sliceDoc(range.from, range.to);
  // Guard against no-op dispatches.
  if (prev === next) return;

  // Minimal-diff dispatch: replace only the changed span so a single
  // keystroke maps to a single localised change (usually a one-char
  // insert) instead of rewriting the whole table range every time.
  // This lets CM6's native typing coalescing work the way it does for
  // ordinary text — undo granularity no longer depends on 500ms timing
  // or on stray selection transactions breaking a whole-range group.
  // (A change that shifts column-alignment padding still produces one
  // larger contiguous edit; that's fine — it's one transaction and far
  // rarer than per-keystroke.)
  const d = diffRange(prev, next);
  view.dispatch({
    changes: { from: range.from + d.from, to: range.from + d.to, insert: d.insert },
    // Tag as typing so CM6's history coalesces consecutive cell edits
    // into one undo group.
    annotations: Transaction.userEvent.of('input.type'),
  });
}

// Smallest single-span replacement turning `prev` into `next`: trim the
// common prefix and suffix and return the differing middle. Returns a
// `{ from, to, insert }` in `prev`-relative coordinates (`to === from`
// with empty `insert` when the strings are equal). Exported for tests.
export function diffRange(
  prev: string,
  next: string,
): { from: number; to: number; insert: string } {
  let s = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (s < maxPrefix && prev[s] === next[s]) s++;
  let ep = prev.length;
  let en = next.length;
  while (ep > s && en > s && prev[ep - 1] === next[en - 1]) {
    ep--;
    en--;
  }
  return { from: s, to: ep, insert: next.slice(s, en) };
}

function moveCellFocus(view: EditorView, cell: HTMLElement, dir: 1 | -1): void {
  const wrap = cell.closest<HTMLElement>('.cm-atomic-table');
  if (!wrap) return;
  const cells = getAllCells(wrap);
  const idx = cells.indexOf(cell);
  if (idx < 0) return;

  const next = idx + dir;
  if (next < 0) {
    // Shift-Tab from the first cell — blur the source; let the
    // browser decide where focus goes next (probably the previous
    // focusable element on the page). CM6 keeps its own selection
    // where it was.
    getCellSource(cell)?.blur();
    return;
  }
  if (next >= cells.length) {
    // Tab past the last cell — append a new empty row and focus its
    // first cell. We dispatch through the same path as a cell edit,
    // then grab the new first cell after the DOM reconciles.
    appendRow(view, wrap);
    return;
  }
  const source = getCellSource(cells[next]);
  if (!source) return;
  source.focus();
  placeCaretAtEnd(source);
}

function appendRow(view: EditorView, wrap: HTMLElement): void {
  const range = findCurrentTableRange(view, wrap);
  if (!range) return;
  const model = readModelFromDom(wrap);
  model.rows.push(model.header.map(() => ''));
  const next = serializeTable(model);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: next },
    // Appending a row (Tab past the last cell) is a discrete structural
    // action — isolate it as its own undo step, matching dispatchModel.
    annotations: isolateHistory.of('full'),
  });

  // Adding a row changes the widget's row count, so `eq` returns
  // false and CM6 rebuilds the widget DOM. The old `wrap` reference
  // is now detached. Wait for the paint that attaches the new DOM,
  // then look up the fresh widget by position and focus its new
  // last-row cell. Double-rAF because the first rAF only guarantees
  // CM6 has processed the dispatch; the second ensures the layout
  // has painted so focus commands don't get lost.
  const { from } = range;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tables = Array.from(
        view.dom.querySelectorAll<HTMLElement>('.cm-atomic-table'),
      );
      let target: HTMLElement | null = null;
      for (const el of tables) {
        try {
          if (view.posAtDOM(el) === from) {
            target = el;
            break;
          }
        } catch {
          // posAtDOM can throw on detached/transitional DOM nodes
          // — skip and keep looking.
        }
      }
      if (!target) return;
      const rows = target.querySelectorAll<HTMLElement>('tbody tr');
      const newRow = rows[rows.length - 1];
      const firstCell = newRow?.querySelector<HTMLElement>('td');
      const firstSource = firstCell ? getCellSource(firstCell) : null;
      if (!firstSource) return;
      firstSource.focus();
      placeCaretAtEnd(firstSource);
    });
  });
}

// Backspace at the line immediately after a table normally deletes
// the `\n` separator and merges the line-below into the table's last
// source line. Lezer then re-parses the merged content as part of
// the table (or mangles it), producing the "swallow" behavior where
// content below the table looks like it's been absorbed as new rows.
//
// Instead, when the caret sits right after a Table and the user hits
// backspace, select the whole Table range — same pattern Obsidian
// uses for treating the table as an atomic unit for deletion. The
// caller can press backspace again to actually delete the selected
// table.
function backspaceAtTableBoundary(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const pos = sel.head;
  if (pos === 0) return false;

  const tree = syntaxTree(state);
  let tableBefore: SyntaxNode | null = null;

  // Scan a few positions back for a Table whose end is adjacent to
  // the caret. `table.to` is the position just after the table's
  // last character — if the caret sits on the next line, `pos` will
  // be one past `table.to` (the \n separator at `table.to` + start
  // of the line after). Accept both.
  tree.iterate({
    from: Math.max(0, pos - 2),
    to: pos,
    enter: (n) => {
      if (n.name !== 'Table') return;
      if (n.to === pos || n.to + 1 === pos) {
        tableBefore = n.node;
      }
    },
  });

  if (!tableBefore) return false;

  const range: SyntaxNode = tableBefore;
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
  });
  return true;
}

// ---- state field ----------------------------------------------------

function buildTableWidgets(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // Force full-doc parse so tables past the initial parsed region
  // also get the widget treatment. This StateField only rebuilds on
  // doc change; CM6's background parser advancing the tree later
  // doesn't retrigger it, so a partial tree at mount means orphaned
  // `| col |` raw lines for the rest of the session. 200ms budget
  // bounds the worst case on very long atoms.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const model = parseTable(state, node.node);
      if (!model) return;

      // Block-replace needs whole-line coverage.
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(model),
          block: true,
        }).range(startLine.from, endLine.to),
      );
      return false; // don't descend
    },
  });

  return Decoration.set(ranges, true);
}

// Detect whether a doc change could have added, removed, or modified
// a Table node. Two cheap signals:
//
//   1. Any existing table decoration overlaps the changed range
//      (edit to / deletion of an existing table).
//   2. Any line touched by the change contains a pipe `|`. GFM
//      tables are pipe-delimited, so every table line has one and
//      editing one without touching a pipe character is impossible.
//      Prose rarely contains pipes; the occasional false positive
//      is fine because `buildTableWidgets` fails cleanly when
//      lezer didn't emit a Table.
//
// If neither fires, skip the full-doc walk and just map existing
// decorations through the change.
function changeAffectsTables(tr: Transaction, existing: DecorationSet): boolean {
  let affected = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (affected) return;
    existing.between(fromA, toA, () => {
      affected = true;
      return false;
    });
  });
  if (affected) return true;

  const state = tr.state;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (affected) return;
    const startLine = state.doc.lineAt(fromB);
    const endLine = toB > startLine.to ? state.doc.lineAt(toB) : startLine;
    for (let n = startLine.number; n <= endLine.number; n++) {
      if (state.doc.line(n).text.includes('|')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableWidgets(state),
  update(deco, tr) {
    // Tree-growth effect: lezer's background parser caught up to a
    // region that wasn't parsed when we last built. Rebuild so any
    // newly-visible Table nodes get their widget.
    for (const effect of tr.effects) {
      if (effect.is(treeGrowthEffect)) return buildTableWidgets(tr.state);
    }
    if (!tr.docChanged) return deco;
    const mapped = deco.map(tr.changes);
    if (!changeAffectsTables(tr, deco)) return mapped;
    return buildTableWidgets(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Stable identifier for a table cell context-menu action. */
export type TableMenuItemId =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteColumn';

/**
 * A single table context-menu action handed to a custom `renderMenu`.
 * `id`/`group` are stable (localize / group by these, not by `label`);
 * `label` is the default English text; `run()` applies the edit.
 */
export interface TableMenuItem {
  id: TableMenuItemId;
  group: 'row' | 'column';
  label: string;
  run: () => void;
}

/**
 * Renders the table cell context menu. When provided (via `tables({ renderMenu })`
 * or the `tableContextMenu()` extension), it fully replaces the built-in DOM menu —
 * the consumer decides presentation (e.g. a native OS menu) and calls the chosen
 * item's `run()`. `pos` is the viewport-relative click position.
 */
export type TableMenuRenderer = (
  items: TableMenuItem[],
  pos: { x: number; y: number },
) => void;

export interface TablesConfig {
  /**
   * Called when the user clicks the external-link icon on a link
   * rendered inside a table cell. Defaults to `window.open(url,
   * '_blank', 'noopener,noreferrer')`.
   */
  onLinkClick?: (url: string) => void;
  /**
   * Replace the built-in cell context menu with a custom renderer (e.g. a
   * native OS menu, or one with localized labels). See {@link TableMenuRenderer}.
   */
  renderMenu?: TableMenuRenderer;
}

// Per-view facet so `openCellMenu` can look up the active custom menu renderer
// without threading config through the widget. Mirrors `tableLinkClickFacet`.
export const tableRenderMenuFacet = Facet.define<
  TableMenuRenderer | null,
  TableMenuRenderer | null
>({
  combine: (values) => values[0] ?? null,
});

/**
 * Standalone extension to supply a custom table menu renderer when you can't
 * call `tables()` directly (e.g. the editor already installs `tables()` and you
 * only append extra extensions). Equivalent to `tables({ renderMenu })`.
 */
export function tableContextMenu(renderMenu: TableMenuRenderer): Extension {
  return tableRenderMenuFacet.of(renderMenu);
}

const defaultLinkOpener = (url: string): void => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // window.open can throw in sandboxed iframes etc.
  }
};

// Per-view facet so `makeCell`'s pointerdown handler can look up the
// current link-click callback. Avoids threading the config through the
// widget constructor and toDOM args.
export const tableLinkClickFacet = Facet.define<
  (url: string) => void,
  (url: string) => void
>({
  combine: (values) => values[0] ?? defaultLinkOpener,
});

/**
 * Wiki links inside table cells. Cells render `[[target]]` /
 * `[[target|label]]` as a clickable `.cm-atomic-wiki-link`; supply
 * `onOpen` to handle activation (defaults to a no-op) and, optionally,
 * a synchronous `resolveStatus` to color resolved vs. missing targets.
 *
 * Separate from the outer-editor {@link wikiLinks} extension: that one's
 * decorations never reach a cell because the whole table is a
 * block-replace widget, so cell wiki links are rendered/opened here.
 */
export interface TableWikiLinkConfig {
  /** Open a wiki-link target (e.g. reveal the file). No-op if omitted. */
  onOpen?: (target: string) => void;
  /**
   * Synchronous status for a target, used only for coloring (resolved vs.
   * `missing`/`unresolved`). Must be synchronous — it runs during cell
   * render. Return `undefined` to leave the link in the default
   * (resolved-looking) style.
   */
  resolveStatus?: (target: string) => WikiLinkStatus | undefined;
  /**
   * Display form for a label-less `[[target]]` (e.g. hide a `.md`
   * extension). Only honored when the result is a strict prefix of the
   * target — the trimmed tail must stay in the DOM as hidden syntax so the
   * cell still serializes back to the raw `[[target]]`.
   */
  displayTarget?: (target: string) => string;
}

// Per-view facet so `makeCell`'s handlers and `renderCellToken` can read
// the wiki-link config without threading it through the widget. Mirrors
// `tableLinkClickFacet`.
export const tableWikiLinkFacet = Facet.define<TableWikiLinkConfig, TableWikiLinkConfig>({
  combine: (values) => values[0] ?? {},
});

/**
 * Standalone extension enabling wiki links inside table cells. Append
 * alongside `tables()` (or the built-in editor's tables) — same pattern
 * as {@link tableContextMenu}.
 */
export function tableWikiLinks(config: TableWikiLinkConfig): Extension {
  return tableWikiLinkFacet.of(config);
}

export function tables(config: TablesConfig = {}): Extension {
  return [
    tableField,
    treeProgressPlugin,
    ...(config.onLinkClick ? [tableLinkClickFacet.of(config.onLinkClick)] : []),
    ...(config.renderMenu ? [tableRenderMenuFacet.of(config.renderMenu)] : []),
    // Prec.high so we run before the default Backspace binding.
    Prec.high(keymap.of([{ key: 'Backspace', run: backspaceAtTableBoundary }])),
  ];
}
