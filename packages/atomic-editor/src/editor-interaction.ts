import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// Interaction state shared by the live-preview features (inline-preview,
// mermaid, math): whether the editor is focused, and whether the pointer
// is currently down.

// ---- focus mirror --------------------------------------------------------
//
// Focus mirror.
//
// inline-preview reveals raw source on `view.hasFocus`, which a
// ViewPlugin can read directly. Block-replace decorations, however, may
// only come from a StateField — and a StateField sees only editor state,
// never the view. This mirrors focus into state so field-based features
// (mermaid diagrams, math) share inline-preview's rule: nothing is
// "active" unless the editor is focused, so a blurred or freshly loaded
// document renders in full.
//
// The dispatch is deferred to a microtask — dispatching synchronously
// from a ViewPlugin's `update` is illegal (re-entrant update).

export const setEditorFocused = StateEffect.define<boolean>();

export const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocused)) return effect.value;
    }
    return value;
  },
});

export const focusWatcher = ViewPlugin.fromClass(
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

// ---- pointer freeze ------------------------------------------------------
//
// True from pointerdown until shortly after pointerup. Every feature whose
// decorations change with the selection must hold them still while this is
// set, or a click turns into a drag-selection: CM6 resolves the pointer
// against the layout, and a block that collapses (revealed `$$` source →
// one-line widget, a mermaid fence → its diagram) between down and up
// shifts the content under the mouse by exactly the height it gave up.
// The selection CM6 then computes runs from the press position to whatever
// moved under the pointer — a stray selection whose length tracks the
// collapsed block's height.
//
// The flag is driven by inline-preview's mouse plugin (it owns the
// pointer-event wiring, including the link-click guard); the state lives
// here so mermaid-blocks and math-blocks can read it without importing
// inline-preview and forming a cycle.

export const setFrozen = StateEffect.define<boolean>();

export const previewFrozenField = StateField.define<boolean>({
  create: () => false,
  update(prev, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFrozen)) return effect.value;
    }
    return prev;
  },
});

/**
 * Current value of the freeze flag for a field that tracks it in its own
 * state (avoids depending on StateField initialization order).
 */
export function nextFrozen(prev: boolean, effects: readonly StateEffect<unknown>[]): boolean {
  let frozen = prev;
  for (const effect of effects) {
    if (effect.is(setFrozen)) frozen = effect.value;
  }
  return frozen;
}
