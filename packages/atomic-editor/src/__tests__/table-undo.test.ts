// @vitest-environment node
//
// Undo behaviour for the table widget. These exercise the pure pieces
// (`diffRange`, `flattenModelCells`) and the CM6 history grouping that
// results from the dispatch shapes table-widget.ts produces:
//   - cell edit  -> minimal `diffRange` change, userEvent 'input.type'
//   - structural -> whole-table replace, isolateHistory('full')
import { describe, expect, it } from 'vitest';
import { EditorState, type Transaction } from '@codemirror/state';
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { diffRange, flattenModelCells, serializeTable } from '../table-widget';

describe('diffRange', () => {
  const cases: Array<[string, string]> = [
    ['abc', 'abc'], // equal
    ['abc', 'abXc'], // insert
    ['abc', 'ac'], // delete
    ['abc', 'aZc'], // replace
    ['', 'hello'], // from empty
    ['hello', ''], // to empty
    ['| a | b |', '| aa | b |'], // widen a cell
    ['xxay', 'xxbay'], // insert with shared suffix
  ];
  for (const [prev, next] of cases) {
    it(`applying the diff turns ${JSON.stringify(prev)} into ${JSON.stringify(next)}`, () => {
      const d = diffRange(prev, next);
      expect(prev.slice(0, d.from) + d.insert + prev.slice(d.to)).toBe(next);
    });
  }

  it('is minimal: a one-char cell edit is a one-char change', () => {
    const d = diffRange('| a | b |', '| aX | b |');
    expect(d.insert).toBe('X');
    expect(d.to - d.from).toBe(0); // pure insertion
  });

  it('reports an empty change for equal strings', () => {
    const d = diffRange('same', 'same');
    expect(d.insert).toBe('');
    expect(d.from).toBe(d.to);
  });
});

describe('flattenModelCells', () => {
  it('yields header cells then row cells, padded to column count', () => {
    expect(
      flattenModelCells({ header: ['A', 'B'], rows: [['1', '2'], ['3']] }),
    ).toEqual(['A', 'B', '1', '2', '3', '']); // short row padded with ''
  });
});

// ---- history integration --------------------------------------------

const MODEL0 = { header: ['A', 'B'], rows: [['1', '2'], ['3', '4']] };
const T0 = serializeTable(MODEL0);

function makeState(): EditorState {
  return EditorState.create({ doc: T0, extensions: [history()] });
}

// Emulate a cell edit: reserialize the whole table, but dispatch only the
// minimal diff, tagged 'input.type' — exactly what dispatchModelFromDom does.
function cellEdit(state: EditorState, nextModel: typeof MODEL0): EditorState {
  const prev = state.doc.toString();
  const next = serializeTable(nextModel);
  const d = diffRange(prev, next);
  return state.update({
    changes: { from: d.from, to: d.to, insert: d.insert },
    userEvent: 'input.type',
  }).state;
}

// Emulate a structural op: whole-table replace, isolated as its own step.
function structural(state: EditorState, nextModel: typeof MODEL0): EditorState {
  return state.update({
    changes: { from: 0, to: state.doc.length, insert: serializeTable(nextModel) },
    annotations: isolateHistory.of('full'),
  }).state;
}

function undoOnce(state: EditorState): EditorState {
  let out = state;
  undo({ state, dispatch: (tr: Transaction) => { out = tr.state; } });
  return out;
}

describe('history grouping', () => {
  it('three fast keystrokes in a cell = one undo step, one undo restores', () => {
    let s = makeState();
    s = cellEdit(s, { ...MODEL0, rows: [['1a', '2'], ['3', '4']] });
    s = cellEdit(s, { ...MODEL0, rows: [['1ab', '2'], ['3', '4']] });
    s = cellEdit(s, { ...MODEL0, rows: [['1abc', '2'], ['3', '4']] });
    expect(undoDepth(s)).toBe(1);
    s = undoOnce(s);
    expect(s.doc.toString()).toBe(T0);
  });

  it('deleting a row is its own undo step and one undo restores it', () => {
    let s = makeState();
    s = structural(s, { header: ['A', 'B'], rows: [['1', '2']] }); // drop row 2
    expect(undoDepth(s)).toBe(1);
    expect(s.doc.toString()).not.toBe(T0);
    s = undoOnce(s);
    expect(s.doc.toString()).toBe(T0);
  });

  it('a structural delete does NOT merge into adjacent cell typing', () => {
    let s = makeState();
    // type in a cell, then immediately delete a row
    s = cellEdit(s, { ...MODEL0, rows: [['1x', '2'], ['3', '4']] });
    const afterTyping = s.doc.toString();
    s = structural(s, { header: ['A', 'B'], rows: [['1x', '2']] }); // drop last row
    // two distinct steps: typing, then the isolated delete
    expect(undoDepth(s)).toBe(2);
    // first undo reverts ONLY the delete — the typed 'x' survives
    s = undoOnce(s);
    expect(s.doc.toString()).toBe(afterTyping);
    // second undo reverts the typing back to the original
    s = undoOnce(s);
    expect(s.doc.toString()).toBe(T0);
  });
});
