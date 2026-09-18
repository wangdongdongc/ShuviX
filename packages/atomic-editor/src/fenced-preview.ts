import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import {
  focusedField,
  focusWatcher,
  nextFrozen,
  setEditorFocused,
} from './editor-interaction';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// Obsidian-style live preview for a fenced code language.
//
// When the cursor is OUTSIDE the fence the whole block is replaced by a
// rendered widget; when it moves INSIDE (any of the fence lines is in the
// selection) the replace is dropped and the raw code shows for editing. On
// blur the whole doc renders (no line is "active" unless the editor is
// focused — mirrors inline-preview's reveal rule).
//
// This file is the machinery only; what a block renders *into* is the
// caller's widget. Two languages use it (```mermaid and ```svg), and the
// plumbing below is where all the non-obvious parts live — the freeze on
// pointer-down, the focus mirror, the tree-growth re-run, the change
// pre-filter. Those were worth extracting precisely because they are the
// parts a second copy would get subtly wrong and nobody would notice.
//
// Block-replace decorations can't originate from a ViewPlugin (CM6 only
// accepts them from a StateField or mandatory facet), so this is a
// StateField. Because the reveal depends on selection AND focus — neither
// of which a StateField can read from a ViewPlugin's `view.hasFocus` — we
// mirror focus into editor state via a tiny companion field fed by a
// focus-watching ViewPlugin.

export interface FencedPreviewSpec {
  /**
   * 围栏 info 串。比较前 trim + 转小写，所以 ` ```SVG ` 在这里也出图 —— **与聊天那侧刻意
   * 不同**：`svgFenceIsRenderable` 是严格 `===`。分歧是从 mermaid 继承来的（编辑器一直
   * 这么宽、聊天一直这么严），这次没有跟着改：收紧会让某人笔记里既有的 ```Mermaid 突然
   * 不再出图，而那是一个没人能预料的回归。提示词两边教的都是小写，所以模型写出来的东西
   * 落在两者的交集里；踩到差异的只有手敲大写的人，代价是「笔记里出图、聊天里出代码块」。
   */
  lang: string;
  /**
   * 源码 → widget。返回 null = 这一块**不渲染**，源码原样留着 —— 用来表达
   * 「这段还不成形」（例如 SVG 的开标签还没闭合），而不是「渲染失败」。
   * 渲染失败要出错误卡，那是 widget 自己的事。
   */
  widget: (code: string) => WidgetType | null;
}

function fenceCode(
  state: EditorState,
  node: SyntaxNode,
  lang: string,
): string | null {
  const infoNode = node.getChild('CodeInfo');
  const info = infoNode
    ? state.doc.sliceString(infoNode.from, infoNode.to).trim()
    : '';
  if (info.toLowerCase() !== lang) return null;
  const textNode = node.getChild('CodeText');
  const code = textNode ? state.doc.sliceString(textNode.from, textNode.to) : '';
  return code.trim() ? code : null;
}

function buildBlocks(state: EditorState, spec: FencedPreviewSpec): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);

  // Lines covered by the selection — only when focused, so a freshly
  // loaded (or blurred) doc renders every block.
  const activeLines = new Set<number>();
  if (state.field(focusedField)) {
    for (const r of state.selection.ranges) {
      const first = doc.lineAt(r.from).number;
      const last = doc.lineAt(r.to).number;
      for (let n = first; n <= last; n++) activeLines.add(n);
    }
  }

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const code = fenceCode(state, node.node, spec.lang);
      if (code == null) return;

      const firstLine = doc.lineAt(node.from);
      const lastLine = doc.lineAt(node.to);
      for (let n = firstLine.number; n <= lastLine.number; n++) {
        // Cursor inside the fence → leave the raw source for editing.
        if (activeLines.has(n)) return false;
      }

      const widget = spec.widget(code);
      if (!widget) return false;
      ranges.push(
        Decoration.replace({ widget, block: true }).range(
          firstLine.from,
          lastLine.to,
        ),
      );
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

// Cheap pre-filter for doc edits: rebuild only when the change overlaps an
// existing block or touches a line with a code fence. Selection / focus /
// tree-growth are handled separately in `update`.
//
// 第二段（扫改动行里有没有 ```）看着像死代码：任何**用户输入**都会移动光标，于是
// `update` 里的选区分支先一步触发重建。它唯一承重的是「改动落在光标之后、光标没动」的
// 程序化写入 —— 也就是智能体 `edit` 这篇笔记的那条路。删掉它只坏那一条，而那一条没人会
// 手动去点。
function changeAffectsBlocks(
  tr: Transaction,
  existing: DecorationSet,
): boolean {
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
      if (state.doc.line(n).text.includes('```')) {
        affected = true;
        break;
      }
    }
  });
  return affected;
}

interface FencedPreviewState {
  deco: DecorationSet;
  /**
   * Pointer-down freeze, mirrored from inline-preview's mouse plugin.
   * Tracked here rather than read off `previewFrozenField` so this field
   * never depends on StateField initialization order.
   */
  frozen: boolean;
}

/**
 * The StateField + its companions for one fenced language. Callers combine
 * it into the editor's extension list; two languages each get their own
 * field (they decorate disjoint blocks, so there is nothing to share at
 * runtime — only this code).
 */
export function fencedPreviewField(spec: FencedPreviewSpec): Extension {
  const field = StateField.define<FencedPreviewState>({
    create: (state) => ({ deco: buildBlocks(state, spec), frozen: false }),
    update(value, tr) {
      const frozen = nextFrozen(value.frozen, tr.effects);
      const justUnfroze = value.frozen && !frozen;
      const next = (deco: DecorationSet): FencedPreviewState =>
        deco === value.deco && frozen === value.frozen
          ? value
          : { deco, frozen };

      // The freeze lifted → apply whatever reveal the click ended up asking for.
      if (justUnfroze) return next(buildBlocks(tr.state, spec));
      // Focus mirror or background parse advance → reveal state may flip.
      for (const effect of tr.effects) {
        if (effect.is(setEditorFocused) || effect.is(treeGrowthEffect)) {
          return next(buildBlocks(tr.state, spec));
        }
      }
      // Selection moved → a block may need to reveal or re-render, UNLESS the
      // pointer is down: collapsing a revealed fence mid-click shifts the
      // content under the mouse and CM6 turns the press into a drag-selection
      // (see the freeze note in editor-interaction).
      if (!frozen && !tr.startState.selection.eq(tr.state.selection)) {
        return next(buildBlocks(tr.state, spec));
      }
      // Doc changes are mapped/rebuilt even while frozen — stale ranges would
      // no longer match the document.
      if (!tr.docChanged) return next(value.deco);
      const mapped = value.deco.map(tr.changes);
      if (!changeAffectsBlocks(tr, value.deco)) return next(mapped);
      return next(buildBlocks(tr.state, spec));
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.deco),
  });

  // 每种围栏各返回一份这四项，CM6 **按值**去重 —— 成立的前提是后三项是模块级单例常量。
  // 哪天有人把 `focusWatcher` 改成工厂函数，两份插件会各自 queueMicrotask 派发
  // setEditorFocused：每次聚焦两条事务、两次全量重建，而没有任何东西会报错。
  return [focusedField, field, focusWatcher, treeProgressPlugin];
}

/**
 * Click a rendered block to drop the caret onto the fence (revealing the
 * source for editing) — the same affordance images use. Inert when the
 * editor is read-only: the preview stays rendered, never reveals.
 */
export function revealOnClick(view: EditorView, wrap: HTMLElement): void {
  wrap.addEventListener('mousedown', (event: MouseEvent) => {
    if (view.state.readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const pos = view.posAtDOM(wrap);
    if (pos < 0) return;
    view.focus();
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
  });
}
