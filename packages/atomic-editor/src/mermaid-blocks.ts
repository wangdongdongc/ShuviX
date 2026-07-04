import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { treeGrowthEffect, treeProgressPlugin } from './tree-progress';

// Mermaid blocks.
//
// Obsidian-style live preview for ```mermaid fenced code: when the
// cursor is OUTSIDE the fence we replace the whole block with the
// rendered diagram; when it moves INSIDE (any of the fence lines is in
// the selection) the replace is dropped and the raw code shows for
// editing. On blur the whole doc renders (no line is "active" unless
// the editor is focused — mirrors inline-preview's reveal rule).
//
// Block-replace decorations can't originate from a ViewPlugin (CM6
// only accepts them from a StateField or mandatory facet), so this is
// a StateField. Because the reveal depends on selection AND focus —
// neither of which a StateField can read from a ViewPlugin's
// `view.hasFocus` — we mirror focus into editor state via a tiny
// companion field fed by a focus-watching ViewPlugin.

// ---------------------------------------------------------------------
// Async mermaid rendering
//
// `mermaid` is heavy, so it's loaded lazily on first diagram and the
// SVG is cached by source. The widget owns its async lifecycle: it
// paints a placeholder, renders, then mutates its own DOM in place —
// no decoration rebuild needed for completion (and `eq` keeps the DOM
// across cursor moves, so a cached diagram never re-renders).

type MermaidResult = { svg?: string; error?: string };

const mermaidCache = new Map<string, MermaidResult>();
const mermaidPending = new Map<string, Promise<MermaidResult>>();
let mermaidModule: Promise<typeof import('mermaid')> | null = null;
let mermaidIdCounter = 0;

function loadMermaid(): Promise<typeof import('mermaid')> {
  if (!mermaidModule) {
    mermaidModule = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      });
      return m;
    });
  }
  return mermaidModule;
}

function renderMermaid(code: string): Promise<MermaidResult> {
  const cached = mermaidCache.get(code);
  if (cached) return Promise.resolve(cached);
  const inFlight = mermaidPending.get(code);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<MermaidResult> => {
    const id = `atomic-mermaid-${mermaidIdCounter++}`;
    try {
      const m = await loadMermaid();
      const { svg } = await m.default.render(id, code);
      const result: MermaidResult = { svg };
      mermaidCache.set(code, result);
      return result;
    } catch (e) {
      const result: MermaidResult = {
        error: e instanceof Error ? e.message : String(e),
      };
      mermaidCache.set(code, result);
      return result;
    } finally {
      mermaidPending.delete(code);
      // mermaid leaves its measurement node behind on parse error.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  })();
  mermaidPending.set(code, promise);
  return promise;
}

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  // Identity is the source only — a cursor move that leaves this block
  // untouched rebuilds the decoration set, but `eq` lets CM6 keep the
  // existing DOM (and its already-rendered SVG) instead of re-rendering.
  eq(other: MermaidWidget): boolean {
    return other.code === this.code;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-mermaid';
    wrap.setAttribute('contenteditable', 'false');

    const diagram = document.createElement('div');
    diagram.className = 'cm-atomic-mermaid-diagram';
    wrap.appendChild(diagram);

    const cached = mermaidCache.get(this.code);
    if (cached?.svg) {
      diagram.innerHTML = cached.svg;
    } else if (cached?.error) {
      paintError(diagram, this.code, cached.error);
    } else {
      diagram.classList.add('cm-atomic-mermaid-loading');
      diagram.textContent = 'Rendering diagram…';
      void renderMermaid(this.code).then((res) => {
        diagram.classList.remove('cm-atomic-mermaid-loading');
        if (res.svg) {
          diagram.innerHTML = res.svg;
        } else {
          paintError(diagram, this.code, res.error ?? 'Unknown error');
        }
        // The SVG changed the widget's height — ask CM6 to re-measure
        // so the block heightmap and scroll stay correct.
        view.requestMeasure();
      });
    }

    // Click the diagram to drop the caret onto the fence (revealing the
    // source for editing) — same affordance images use. Inert when the
    // editor is read-only: the preview stays a diagram, never reveals.
    const onPointer = (event: MouseEvent): void => {
      if (view.state.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      const pos = view.posAtDOM(wrap);
      if (pos < 0) return;
      view.focus();
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
    };
    wrap.addEventListener('mousedown', onPointer);
    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function paintError(el: HTMLElement, code: string, message: string): void {
  el.classList.add('cm-atomic-mermaid-error');
  const label = document.createElement('div');
  label.className = 'cm-atomic-mermaid-error-label';
  label.textContent = 'Mermaid diagram failed to render';
  const detail = document.createElement('pre');
  detail.className = 'cm-atomic-mermaid-error-detail';
  detail.textContent = `${message}\n\n${code}`;
  el.replaceChildren(label, detail);
}

// ---------------------------------------------------------------------
// Focus mirror
//
// inline-preview reveals on `view.hasFocus`; a StateField can't read
// that, so this companion field mirrors focus into editor state. The
// dispatch is deferred to a microtask — dispatching synchronously from
// a ViewPlugin's `update` is illegal (re-entrant update).

const setEditorFocused = StateEffect.define<boolean>();

const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocused)) return effect.value;
    }
    return value;
  },
});

const focusWatcher = ViewPlugin.fromClass(
  class {
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
    }
    update(update: ViewUpdate): void {
      if (!update.focusChanged) return;
      const view = this.view;
      queueMicrotask(() => {
        try {
          view.dispatch({ effects: setEditorFocused.of(view.hasFocus) });
        } catch {
          // View destroyed between the event and the microtask.
        }
      });
    }
  },
);

// ---------------------------------------------------------------------
// Decoration builder

function fenceCode(state: EditorState, node: SyntaxNode): string | null {
  const infoNode = node.getChild('CodeInfo');
  const info = infoNode ? state.doc.sliceString(infoNode.from, infoNode.to).trim() : '';
  if (info.toLowerCase() !== 'mermaid') return null;
  const textNode = node.getChild('CodeText');
  const code = textNode ? state.doc.sliceString(textNode.from, textNode.to) : '';
  return code.trim() ? code : null;
}

function buildMermaidBlocks(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state);

  // Lines covered by the selection — only when focused, so a freshly
  // loaded (or blurred) doc renders every diagram.
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
      const code = fenceCode(state, node.node);
      if (code == null) return;

      const firstLine = doc.lineAt(node.from);
      const lastLine = doc.lineAt(node.to);
      for (let n = firstLine.number; n <= lastLine.number; n++) {
        // Cursor inside the fence → leave the raw source for editing.
        if (activeLines.has(n)) return false;
      }

      ranges.push(
        Decoration.replace({
          widget: new MermaidWidget(code),
          block: true,
        }).range(firstLine.from, lastLine.to),
      );
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

// Cheap pre-filter for doc edits: rebuild only when the change overlaps
// an existing diagram or touches a line with a code fence. Selection /
// focus / tree-growth are handled separately in `update`.
function changeAffectsMermaid(tr: Transaction, existing: DecorationSet): boolean {
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

const mermaidField = StateField.define<DecorationSet>({
  create: (state) => buildMermaidBlocks(state),
  update(deco, tr) {
    // Focus mirror or background parse advance → reveal state may flip.
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocused) || effect.is(treeGrowthEffect)) {
        return buildMermaidBlocks(tr.state);
      }
    }
    // Selection moved → a diagram may need to reveal or re-render.
    if (!tr.startState.selection.eq(tr.state.selection)) {
      return buildMermaidBlocks(tr.state);
    }
    if (!tr.docChanged) return deco;
    const mapped = deco.map(tr.changes);
    if (!changeAffectsMermaid(tr, deco)) return mapped;
    return buildMermaidBlocks(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Obsidian-style live preview for ```mermaid fenced code blocks: the
 * rendered diagram replaces the source when the cursor is outside the
 * fence, and the raw code returns when the cursor moves inside.
 */
export function mermaidBlocks(): Extension {
  return [focusedField, mermaidField, focusWatcher, treeProgressPlugin];
}
