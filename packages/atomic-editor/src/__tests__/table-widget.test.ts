import { describe, expect, it } from 'vitest';
import {
  parseCellInline,
  serializeTable,
  splitRowCells,
} from '../table-widget';

// Reconstruct a model from serialized markdown the same way the widget
// does: split the header (line 0) and body rows (line 2+), skipping the
// delimiter line (line 1). Exercises serializeTable + splitRowCells
// together — the two functions that own the markdown round-trip.
function roundTrip(md: string): { header: string[]; rows: string[][] } {
  const lines = md.split('\n');
  return {
    header: splitRowCells(lines[0]),
    rows: lines.slice(2).map(splitRowCells),
  };
}

describe('splitRowCells', () => {
  it('strips the outer pipes and trims each cell', () => {
    expect(splitRowCells('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('preserves empty cells (lezer emits no TableCell node for them)', () => {
    // The empty-column regression: a node-based count drops the blank.
    expect(splitRowCells('| a |  | b |')).toEqual(['a', '', 'b']);
    expect(splitRowCells('|  |  |  |')).toEqual(['', '', '']);
  });

  it('does not split on an escaped pipe', () => {
    expect(splitRowCells('| x\\|y | z |')).toEqual(['x\\|y', 'z']);
  });

  it('tolerates missing outer pipes', () => {
    expect(splitRowCells('a | b')).toEqual(['a', 'b']);
  });
});

describe('serializeTable', () => {
  it('emits a header, delimiter, and one line per row, padded to width', () => {
    const md = serializeTable({
      header: ['Name', 'Age'],
      rows: [['Alice', '30'], ['Bob']], // short row → padded
    });
    expect(md.split('\n')).toEqual([
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '| Bob |  |',
    ]);
  });

  it('escapes a literal pipe so it cannot split the row', () => {
    const md = serializeTable({ header: ['a', 'b'], rows: [['x|y', 'z']] });
    const rowLine = md.split('\n')[2];
    expect(rowLine).toBe('| x\\|y | z |');
    // The escaped pipe must round-trip back into a single cell.
    expect(splitRowCells(rowLine)).toHaveLength(2);
  });

  it('does not double-escape an already-escaped pipe', () => {
    const md = serializeTable({ header: ['a'], rows: [['x\\|y']] });
    expect(md.split('\n')[2]).toBe('| x\\|y |');
  });

  it('flattens newlines (cells are single-line)', () => {
    const md = serializeTable({ header: ['a'], rows: [['one\ntwo']] });
    expect(md.split('\n')[2]).toBe('| one two |');
  });
});

describe('serialize → split round-trip', () => {
  it('preserves plain content exactly', () => {
    const model = { header: ['Name', 'Age'], rows: [['Alice', '30'], ['Bob', '']] };
    expect(roundTrip(serializeTable(model))).toEqual(model);
  });

  it('preserves blank columns through the round-trip', () => {
    const model = { header: ['a', '', 'b'], rows: [['1', '', '2']] };
    expect(roundTrip(serializeTable(model))).toEqual(model);
  });

  it('keeps a piped cell intact (no column corruption)', () => {
    const model = { header: ['a', 'b'], rows: [['x|y', 'z']] };
    const back = roundTrip(serializeTable(model));
    expect(back.header).toEqual(['a', 'b']);
    expect(back.rows[0]).toHaveLength(2); // not split into 3
    expect(back.rows[0][0]).toContain('|');
  });
});

describe('parseCellInline', () => {
  it('returns nothing for an empty cell', () => {
    expect(parseCellInline('')).toEqual([]);
  });

  it('parses plain text as a single text token', () => {
    expect(parseCellInline('plain words')).toEqual([
      { type: 'text', text: 'plain words' },
    ]);
  });

  it('parses bold, italic, and strikethrough', () => {
    expect(parseCellInline('**b**')).toEqual([
      { type: 'strong', delim: '**', children: [{ type: 'text', text: 'b' }] },
    ]);
    expect(parseCellInline('*i*')).toEqual([
      { type: 'em', delim: '*', children: [{ type: 'text', text: 'i' }] },
    ]);
    expect(parseCellInline('~~s~~')).toEqual([
      { type: 'strike', children: [{ type: 'text', text: 's' }] },
    ]);
  });

  it('parses a link with its url', () => {
    expect(parseCellInline('[text](https://example.org)')).toEqual([
      {
        type: 'link',
        url: 'https://example.org',
        textChildren: [{ type: 'text', text: 'text' }],
      },
    ]);
  });

  it('strips backslash escapes so the delimiter renders literally', () => {
    expect(parseCellInline('\\*not bold\\*')).toEqual([
      { type: 'text', text: '*not bold*' },
    ]);
  });

  it('does not treat an in-word underscore as emphasis', () => {
    expect(parseCellInline('snake_case_var')).toEqual([
      { type: 'text', text: 'snake_case_var' },
    ]);
  });
});
