import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { undo } from '@codemirror/commands';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';

// DOM-level behaviour of the table widget's `eq` / `updateDOM` reconcile.
// These are the parts the pure-function tests (table-undo.test.ts) can't
// reach: whether a document change actually refreshes the rendered table,
// and whether the cell being edited is left alone.
//
// Regression guard: the widget's `eq` used to compare dimensions only, so a
// same-shape document change (a cell edit, or the undo of one) reverted the
// text but never re-rendered the table — the visible cells went stale.

const TABLE = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

const hosts: HTMLElement[] = [];

function mount(doc: string): { host: HTMLElement; view: EditorView } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() => createRoot(host).render(<AtomicCodeMirrorEditor markdownSource={doc} />));
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  return { host, view };
}

function cellTexts(host: HTMLElement): string[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source'),
  ).map((e) => e.textContent ?? '');
}

// Replace the first occurrence of `find` in the doc, as a cell edit would.
function editDoc(view: EditorView, find: string, replace: string): void {
  const at = view.state.doc.toString().indexOf(find);
  act(() =>
    view.dispatch({
      changes: { from: at, to: at + find.length, insert: replace },
      annotations: Transaction.userEvent.of('input.type'),
    }),
  );
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

describe('table widget DOM reconcile', () => {
  it('renders each cell', () => {
    const { host } = mount(TABLE);
    expect(cellTexts(host)).toEqual(['A', 'B', '1', '2', '3', '4']);
  });

  it('a same-shape cell edit refreshes the rendered cell (not stale)', () => {
    const { host, view } = mount(TABLE);
    editDoc(view, '| 1 |', '| 1X |');
    // With dimension-only `eq` this stayed '1'; the reconcile must show '1X'.
    expect(cellTexts(host)).toEqual(['A', 'B', '1X', '2', '3', '4']);
  });

  it('undo of a cell edit refreshes the table back (the core regression)', () => {
    const { host, view } = mount(TABLE);
    editDoc(view, '| 1 |', '| 1X |');
    expect(cellTexts(host)[2]).toBe('1X');
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(TABLE);
    // The visible table must follow the document back, not stay on '1X'.
    expect(cellTexts(host)).toEqual(['A', 'B', '1', '2', '3', '4']);
  });

  it('reconciling other cells does not steal focus from the edited cell', () => {
    const { host, view } = mount(TABLE);
    const sources = host.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source');
    const cell1 = sources[2]; // the '1' cell
    act(() => cell1.focus());
    expect(host.ownerDocument.activeElement).toBe(cell1);
    // Edit a DIFFERENT cell ('3'); the reconcile should update it but leave
    // the focused cell (and the caret it holds) untouched.
    editDoc(view, '| 3 |', '| 3Y |');
    expect(cellTexts(host)[4]).toBe('3Y');
    expect(host.ownerDocument.activeElement).toBe(cell1);
  });

  it('undo/redo landing on the FOCUSED cell still refreshes it', () => {
    // The reported regression: while the caret sits in a cell, undo reverts
    // the document but the visible cell used to stay stale (focused cells
    // were skipped), so Ctrl+Z looked dead and effects arrived out of order.
    const { host, view } = mount(TABLE);
    const cell1 = host.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source')[2];
    act(() => cell1.focus());
    editDoc(view, '| 1 |', '| 1Q |'); // external edit to the focused cell
    expect(cellTexts(host)[2]).toBe('1Q'); // forward refresh reaches the caret cell
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(cellTexts(host)[2]).toBe('1'); // undo refreshes the focused cell too
  });

  it('a same-shape edit whose result matches the DOM leaves the cell untouched (typing keeps caret)', () => {
    // Emulates the typing path: `commit` has already synced the cell DOM to
    // the new text BEFORE dispatching, so the incoming reconcile is a no-op
    // for that cell and must not re-render it (which would drop the caret).
    const { host, view } = mount(TABLE);
    const cell1 = host.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source')[2];
    act(() => cell1.focus());
    // Sync the DOM the way `commit` does, then tag the live node so we can
    // detect an unwanted re-render (a re-render replaces the node's children).
    cell1.parentElement!.dataset.raw = '1x';
    cell1.textContent = '1x';
    const marker = cell1.firstChild;
    editDoc(view, '| 1 |', '| 1x |'); // dispatch matching the already-synced DOM
    expect(cell1.textContent).toBe('1x');
    expect(cell1.firstChild).toBe(marker); // not re-rendered
    expect(host.ownerDocument.activeElement).toBe(cell1); // caret cell intact
  });

  it('deleting a row rebuilds the widget; one undo restores it', () => {
    const { host, view } = mount(TABLE);
    // Drop the last body row — a dimension change (full rebuild path).
    const at = view.state.doc.toString().indexOf('\n| 3 | 4 |');
    act(() =>
      view.dispatch({
        changes: { from: at, to: at + '\n| 3 | 4 |'.length, insert: '' },
      }),
    );
    expect(cellTexts(host)).toEqual(['A', 'B', '1', '2']);
    act(() => {
      undo(view);
    });
    expect(cellTexts(host)).toEqual(['A', 'B', '1', '2', '3', '4']);
  });

  it('Ctrl/Cmd+Z inside a cell drives CM undo (not the browser native undo)', () => {
    // Cells are their own contenteditable; without this the browser runs its
    // native per-element undo, which only moves the caret and never reverts
    // CM's document. The keydown handler must route undo to CM so the text
    // actually reverts.
    const { host, view } = mount(TABLE);
    const src = host.querySelectorAll<HTMLElement>('.cm-atomic-table-cell-source')[2]; // '1'
    // Real typing path: focus, set text, fire input → commit → dispatch.
    act(() => {
      src.focus();
      src.textContent = '1z';
      src.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(view.state.doc.toString()).toContain('| 1z |');

    // Ctrl+Z on the cell must revert the document via CM.
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      src.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true); // native undo suppressed
    expect(view.state.doc.toString()).toBe(TABLE); // text actually reverted
  });
});
