import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// HTML comments (`<!-- ... -->`).
//
// Markdown's convention for render-invisible annotations is the HTML
// comment — GitHub, static-site generators, and Obsidian's reading mode
// all drop it from rendered output. The live-preview model needs two
// behaviors:
//
//   - Read-only viewer (`EditorState.readOnly`): the document is a
//     rendered page, so comments disappear entirely. Block comments are
//     removed line-and-all (block replace), leaving no blank gap.
//   - Editable document: hiding text the caret can still enter would
//     make edits land "inside nothing" (deleted characters the user
//     cannot see), so instead of hiding we dim — comments stay visible
//     as de-emphasized source, matching how Obsidian's live preview
//     treats its `%%` comments.
//
// Block-replace decorations can't originate from a ViewPlugin (CM6 only
// accepts them from a StateField or mandatory facet), so this is a
// StateField. It needs no focus/selection plumbing: the read-only flag
// is the only mode switch, and it never changes within a mounted editor.

const dimMark = Decoration.mark({ class: 'cm-atomic-comment' });

// Lezer's markdown parser emits block-level comments as `CommentBlock`
// and comments inside a paragraph as inline `Comment` nodes.
const COMMENT_NODES = new Set(['CommentBlock', 'Comment']);

function buildCommentDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (!COMMENT_NODES.has(node.name)) return;
      if (node.from >= node.to) return false;

      if (!state.readOnly) {
        // Editable: dim, never hide (marks may cross line breaks freely).
        ranges.push(dimMark.range(node.from, node.to));
        return false;
      }

      const firstLine = doc.lineAt(node.from);
      const lastLine = doc.lineAt(node.to);
      const wholeLines =
        node.from === firstLine.from && doc.sliceString(node.to, lastLine.to).trim() === '';
      if (wholeLines) {
        // The comment owns its lines → remove them entirely (no blank gap).
        ranges.push(
          Decoration.replace({ block: true }).range(firstLine.from, lastLine.to),
        );
        return false;
      }

      // Inline comment sharing a line with visible text: hide just the
      // comment span. Replace ranges may not cross line breaks, so a
      // multi-line inline comment is hidden per line segment (the
      // newline between segments stays — same compromise inline-preview
      // makes for multi-line link titles).
      let cursor = node.from;
      while (cursor < node.to) {
        const line = doc.lineAt(cursor);
        const segEnd = Math.min(node.to, line.to);
        if (segEnd > cursor) ranges.push(Decoration.replace({}).range(cursor, segEnd));
        cursor = line.to + 1;
      }
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

// Cheap pre-filter for doc edits: rebuild only when the change overlaps
// an existing comment decoration or a touched line contains a comment
// delimiter. Tree growth is handled separately in `update`.
function changeAffectsComments(tr: Transaction, existing: DecorationSet): boolean {
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
      const text = state.doc.line(n).text;
      if (text.includes('<!--') || text.includes('-->')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

const commentField = StateField.define<DecorationSet>({
  create: (state) => buildCommentDecorations(state),
  update(deco, tr) {
    // Background parse advance → comments past the old tree tail appear.
    for (const effect of tr.effects) {
      if (effect.is(treeGrowthEffect)) return buildCommentDecorations(tr.state);
    }
    if (!tr.docChanged) return deco;
    const mapped = deco.map(tr.changes);
    if (!changeAffectsComments(tr, deco)) return mapped;
    return buildCommentDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * HTML comment handling for the live preview: removed entirely in the
 * read-only viewer (rendered output shows no trace, block comments leave
 * no blank lines), dimmed but visible while editing.
 */
export function commentBlocks(): Extension {
  return [commentField, treeProgressPlugin];
}
