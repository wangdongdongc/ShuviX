import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { wikiLinks } from '../wiki-links';

// Obsidian-style LOCAL reveal: a formatting span shows its raw source only
// while the cursor is on THAT span (not merely its line). We assert this via
// the rendered `.cm-content` text — hidden delimiters are `Decoration.replace`d
// out of the DOM, so they disappear from `textContent`; revealed ones stay.

const hosts: HTMLElement[] = [];

function render(src: string, anchor: number, extensions?: readonly Extension[]): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() =>
    createRoot(host).render(
      <AtomicCodeMirrorEditor markdownSource={src} extensions={extensions} />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor } });
  });
  return (host.querySelector('.cm-content') as HTMLElement).textContent ?? '';
}

// The `padding-left` inline style the list-indent decoration puts on each
// `.cm-line` — `''` for lines not treated as a list item.
function listIndents(src: string, anchor = src.length): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() => createRoot(host).render(<AtomicCodeMirrorEditor markdownSource={src} />));
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor } });
  });
  return Array.from(host.querySelectorAll('.cm-line')).map(
    (line) => (line as HTMLElement).style.paddingLeft,
  );
}

function listIndent(src: string, anchor = src.length): string {
  return listIndents(src, anchor)[0];
}

// Rendered text per `.cm-line` (hidden source is replaced out of the DOM,
// so it never shows up here).
function lineTexts(src: string, anchor: number): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() => createRoot(host).render(<AtomicCodeMirrorEditor markdownSource={src} />));
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor } });
  });
  return Array.from(host.querySelectorAll('.cm-line')).map(
    (line) => (line as HTMLElement).textContent ?? '',
  );
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

describe('local (per-span) source reveal', () => {
  it('reveals only the bold span the cursor is inside, not others on the line', () => {
    const doc = '**a** and **b**';
    // Cursor inside the first bold → only its `**` reveal.
    expect(render(doc, 2)).toBe('**a** and b');
    // Cursor inside the second bold → only its `**` reveal.
    expect(render(doc, 12)).toBe('a and **b**');
    // Cursor on neither → both stay hidden.
    expect(render(doc, 7)).toBe('a and b');
  });

  it('reveals italic / inline-code / strikethrough locally', () => {
    expect(render('_a_ x `b` y ~~c~~', 1)).toContain('_a_'); // in italic
    expect(render('_a_ x `b` y ~~c~~', 1)).not.toContain('`b`');
    expect(render('_a_ x `b` y ~~c~~', 7)).toContain('`b`'); // in code
    expect(render('_a_ x `b` y ~~c~~', 14)).toContain('~~c~~'); // in strike
  });

  it('bullet marker reverts to `-` only when the cursor is on the marker', () => {
    // Cursor on the dash → raw `- ` (no dot glyph).
    expect(render('- item', 0)).toBe('- item');
    // Cursor at the content start (right after `- `, where it lands when you
    // finish typing) → the dot shows, not the raw dash.
    expect(render('- item', 2)).toBe('•item');
    // Cursor in the item text → the dot widget replaces `- `.
    expect(render('- item', 4)).toBe('•item');
  });

  it('task marker reverts to `[ ]` only when the cursor is on the marker', () => {
    // Cursor on the marker → raw `- [ ] ` shown for editing.
    expect(render('- [ ] todo', 2)).toBe('- [ ] todo');
    // Cursor in the item text → `[ ]` replaced by the checkbox widget; the
    // `- ` is hidden but the space after `[ ]` stays REAL (kept for caret
    // positioning), so it survives in the text as a leading space.
    expect(render('- [ ] todo', 8)).toBe(' todo');
  });

  it('treats a marker as a list item only once a space follows it (Obsidian-style)', () => {
    // Bare `-` / `1.` while still typing → NOT a list: no indent.
    expect(listIndent('-')).toBe('');
    expect(listIndent('1.')).toBe('');
    // Space typed → becomes a list item → indent applied.
    expect(listIndent('- ')).toBe('0.8em');
    expect(listIndent('1. ')).toBe('0.8em');
    expect(listIndent('- x', 0)).toBe('0.8em');
  });

  it('indents by list NESTING, not by the marker source column', () => {
    // Markdown has no fixed indent step — a nested list only has to start
    // past its parent's content column — so the same three-level list is
    // written with 2 spaces, 4 spaces or a tab per level. All three must
    // render at ONE step per level (column math gave the 4-space doc double
    // indent and the tab doc none).
    const levels = ['0.8em', '2em', '3.2em'];
    expect(listIndents('- [ ] a\n  - [ ] b\n    - [ ] c')).toEqual(levels);
    expect(listIndents('- [ ] a\n    - [ ] b\n        - [ ] c')).toEqual(levels);
    expect(listIndents('- [ ] a\n\t- [ ] b\n\t\t- [ ] c')).toEqual(levels);
    // Ordered lists nest through the same counter.
    expect(listIndents('1. a\n    1. b')).toEqual(levels.slice(0, 2));
    // Depth 3 is where `0.8 + 3 * 1.2` goes float-fuzzy — the style value
    // must stay a clean `4.4em`, not `4.3999999999999995em`.
    expect(listIndents('- a\n  - b\n    - c\n      - d')[3]).toBe('4.4em');
  });

  it('hides the source indent so padding-left is the ONLY indent', () => {
    // The raw spaces/tabs before a nested marker used to render as text ON
    // TOP of padding-left, so the visual indent doubled with the author's
    // indent width (and a tab ate a full 8-column tab stop). Nested lines
    // now render only the real space kept after the checkbox for the caret.
    expect(lineTexts('- [ ] a\n    - [ ] b', 0)[1]).toBe(' b');
    expect(lineTexts('- [ ] a\n\t- [ ] b', 0)[1]).toBe(' b');
    expect(lineTexts('- a\n    - b', 0)[1]).toBe('•b');
    expect(lineTexts('1. a\n    1. b', 0)[1]).toBe('1.b');
    // Local reveal still returns the WHOLE raw marker — indent included —
    // when the cursor is on it, so the indentation stays editable.
    const nested = '- [ ] a\n    - [ ] b';
    expect(lineTexts(nested, nested.indexOf('\n') + 1)[1]).toBe('    - [ ] b');
  });

  it('reveals BOTH bracket layers of a `[[wiki]]` link — inline-preview must not fight it', () => {
    const wiki = [
      wikiLinks({
        resolve: async (t: string) => ({ target: t, label: t, status: 'resolved' as const }),
        openOnClick: true,
      }),
    ];
    // lezer parses the inner `[page]` of `[[page]]` as its own Link node. When
    // the wiki-link reveals, inline-preview must leave that inner Link alone,
    // or only the OUTER `[ ]` reveals and the inner brackets stay hidden.
    const doc = 'xx [[page]] yy';
    const wikiStart = doc.indexOf('[[');
    // Cursor inside the link → the FULL `[[page]]` reveals (both layers).
    expect(render(doc, wikiStart + 3, wiki)).toBe('xx [[page]] yy');
    // Cursor right after `]]` (aggressive boundary) → still fully revealed.
    expect(render(doc, wikiStart + '[[page]]'.length, wiki)).toBe('xx [[page]] yy');
    // Cursor away → the link renders as a widget, no raw brackets shown.
    expect(render(doc, 0, wiki)).not.toContain('[[');
  });
});
