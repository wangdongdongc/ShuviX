import { describe, it, expect, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { refreshImageBlocks } from '../image-blocks';

// DOM-level behaviour of the image block's host-injected `resolveSrc`:
// the raw markdown URL (`![alt](url)`) is passed through the resolver,
// a non-empty result becomes the <img> src, and null/'' keeps the raw
// src. `refreshImageBlocks` rebuilds the decorations so an async
// resolution that became ready gets picked up.

const DOC = '![an example](./images/example.png)';

const hosts: HTMLElement[] = [];

function mount(
  doc: string,
  imageSrcResolver?: (src: string) => string | null,
): { host: HTMLElement; view: EditorView } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() =>
    createRoot(host).render(
      <AtomicCodeMirrorEditor markdownSource={doc} imageSrcResolver={imageSrcResolver} />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  return { host, view };
}

function imgSrc(host: HTMLElement): string | null {
  return host.querySelector('.cm-atomic-image img')?.getAttribute('src') ?? null;
}

afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

describe('image blocks resolveSrc', () => {
  it('uses the raw markdown URL when no resolver is given', () => {
    const { host } = mount(DOC);
    expect(imgSrc(host)).toBe('./images/example.png');
  });

  it('a non-empty resolver result becomes the <img> src', () => {
    const { host } = mount(
      DOC,
      (src) => `resolved://load?path=${encodeURIComponent(src)}`,
    );
    expect(imgSrc(host)).toBe(
      `resolved://load?path=${encodeURIComponent('./images/example.png')}`,
    );
  });

  it('null from the resolver keeps the raw src (pending async resolution)', () => {
    const { host } = mount(DOC, () => null);
    expect(imgSrc(host)).toBe('./images/example.png');
  });

  it('refreshImageBlocks rebuilds widgets with the now-resolved src', () => {
    // Simulates the async (blob:) flow: first build can't resolve yet,
    // then the resolution lands in a cache and the host dispatches the
    // refresh effect.
    const cache = new Map<string, string>();
    const { host, view } = mount(DOC, (src) => cache.get(src) ?? null);
    expect(imgSrc(host)).toBe('./images/example.png');

    cache.set('./images/example.png', 'blob:fake-object-url');
    act(() => {
      view.dispatch({ effects: refreshImageBlocks.of(null) });
    });
    expect(imgSrc(host)).toBe('blob:fake-object-url');
  });
});
