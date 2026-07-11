import { describe, expect, it } from 'vitest';
import { markdownLanguage } from '@codemirror/lang-markdown';
import {
  cellTokenText,
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

  it('parses a bare wiki link', () => {
    expect(parseCellInline('[[Note]]')).toEqual([
      { type: 'wikiLink', target: 'Note', label: null },
    ]);
  });

  it('parses a wiki link with a display label', () => {
    expect(parseCellInline('[[Note|see this]]')).toEqual([
      { type: 'wikiLink', target: 'Note', label: 'see this' },
    ]);
  });

  it('trims whitespace around wiki target and label', () => {
    expect(parseCellInline('[[ Note | see this ]]')).toEqual([
      { type: 'wikiLink', target: 'Note', label: 'see this' },
    ]);
  });

  it('reads a wiki link before the surrounding text', () => {
    expect(parseCellInline('go [[Note]] now')).toEqual([
      { type: 'text', text: 'go ' },
      { type: 'wikiLink', target: 'Note', label: null },
      { type: 'text', text: ' now' },
    ]);
  });

  it('treats an empty wiki target as plain text', () => {
    expect(parseCellInline('[[]]')).toEqual([{ type: 'text', text: '[[]]' }]);
  });

  it('parses an inline code span', () => {
    expect(parseCellInline('`code`')).toEqual([
      { type: 'code', fence: '`', text: 'code' },
    ]);
  });

  it('does not decorate marks inside a code span', () => {
    expect(parseCellInline('`*not bold*`')).toEqual([
      { type: 'code', fence: '`', text: '*not bold*' },
    ]);
  });

  it('keeps a multi-backtick fence so a backtick can appear inside', () => {
    expect(parseCellInline('``a`b``')).toEqual([
      { type: 'code', fence: '``', text: 'a`b' },
    ]);
  });

  it('keeps an escaped cell pipe inside a code span (unescaped at render)', () => {
    expect(parseCellInline('`a\\|b`')).toEqual([
      { type: 'code', fence: '`', text: 'a\\|b' },
    ]);
  });

  it('parses code alongside surrounding text', () => {
    expect(parseCellInline('run `npm test` now')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', fence: '`', text: 'npm test' },
      { type: 'text', text: ' now' },
    ]);
  });

  // Now driven by the same lezer GFM grammar as prose, so cells obey
  // CommonMark flanking rules instead of the old "any pair decorates".
  it('obeys CommonMark flanking (no emphasis on a trailing-space run)', () => {
    expect(parseCellInline('*x *')).toEqual([{ type: 'text', text: '*x *' }]);
  });

  it('nests bold-italic like prose (***a***)', () => {
    expect(parseCellInline('***a***')).toEqual([
      {
        type: 'em',
        delim: '*',
        children: [
          { type: 'strong', delim: '**', children: [{ type: 'text', text: 'a' }] },
        ],
      },
    ]);
  });

  it('resolves a wiki link nested inside emphasis', () => {
    expect(parseCellInline('**[[x]]**')).toEqual([
      {
        type: 'strong',
        delim: '**',
        children: [{ type: 'wikiLink', target: 'x', label: null }],
      },
    ]);
  });

  it('leaves a wiki link inside a code span as literal code', () => {
    expect(parseCellInline('`[[x]]`')).toEqual([
      { type: 'code', fence: '`', text: '[[x]]' },
    ]);
  });

  it('falls back to raw text for a link it cannot round-trip (title)', () => {
    expect(parseCellInline('[t](u "title")')).toEqual([
      { type: 'text', text: '[t](u "title")' },
    ]);
  });
});

// Every token tree must reproduce exactly what the DOM shows, and — modulo
// the intended normalizations (escape-stripping, `\|`→`|`, delimiter
// normalization) — round-trip stably. `cellTokenText` models that
// textContent; re-parsing it must be a fixed point.
describe('parseCellInline round-trip (cellTokenText)', () => {
  for (const src of [
    'plain',
    '**b** and *i* and ~~s~~',
    '`code` and ``a`b``',
    '[t](https://ex.org)',
    '[[Note|alias]] mid [[Other]]',
    '**[[x]]** `y`',
    '***a***',
  ]) {
    it(`is a fixed point for ${JSON.stringify(src)}`, () => {
      const once = cellTokenText(parseCellInline(src));
      const twice = cellTokenText(parseCellInline(once));
      expect(twice).toBe(once);
    });
  }
});

// Anti-divergence guard: cell recognition is the SAME grammar as prose, so
// a cell must surface a construct iff lezer's own tree contains its node.
// If someone reintroduces a bespoke recognizer, these break.
describe('parseCellInline matches the lezer grammar', () => {
  const hasNode = (src: string, name: string): boolean => {
    let found = false;
    markdownLanguage.parser.parse(src).iterate({
      enter: (n) => {
        if (n.name === name) found = true;
      },
    });
    return found;
  };
  const hasToken = (src: string, type: string): boolean => {
    const walk = (toks: ReturnType<typeof parseCellInline>): boolean =>
      toks.some(
        (t) =>
          t.type === type ||
          ('children' in t && walk(t.children)) ||
          ('textChildren' in t && walk(t.textChildren)),
      );
    return walk(parseCellInline(src));
  };

  for (const [src, node, type] of [
    ['**b**', 'StrongEmphasis', 'strong'],
    ['*i*', 'Emphasis', 'em'],
    ['~~s~~', 'Strikethrough', 'strike'],
    ['`c`', 'InlineCode', 'code'],
    ['*x *', 'Emphasis', 'em'], // neither: flanking rejects it
    ['a*b', 'Emphasis', 'em'], // neither: unpaired
  ] as const) {
    it(`${JSON.stringify(src)}: grammar ${node} ⇔ cell ${type}`, () => {
      expect(hasToken(src, type)).toBe(hasNode(src, node));
    });
  }
});
