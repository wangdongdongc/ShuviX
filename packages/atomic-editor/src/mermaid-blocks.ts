import { EditorView, WidgetType } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  detectType,
  load,
  registered,
  render as peleRender,
  type DiagramType,
} from 'pele/lazy';
import {
  renderMermaidFigure,
  type MermaidEngine,
  type MermaidRenderResult,
} from '@shuvix/chat-protocol/utils/mermaidFence';
import { fencedPreviewField, revealOnClick } from './fenced-preview';
import { attachFigureExport, type FigureExportConfig } from './figure-export';

// Mermaid blocks.
//
// Obsidian-style live preview for ```mermaid fenced code. The reveal
// machinery (cursor in → source, cursor out → diagram) lives in
// `fenced-preview.ts` and is shared with ```svg; this file is mermaid's
// half: the render, its cache, and the widget.
//
// The renderer is pele (Obsidian's own Mermaid → SVG renderer, which
// replaced mermaid.js here and in chat on 2026-10-17). What that changed:
//
//  1. **Synchronous.** Rendering is a sub-millisecond pure call, so a
//     diagram paints in the same frame as the widget — no render queue.
//     The one async step left is loading a diagram type the first time it
//     is used (`pele/lazy` ships one chunk per type).
//  2. **No white card.** pele colors everything with `var(--pele-*)`, which
//     ShuviX's themes.css maps onto the theme tokens (the `.pele` block), so
//     a diagram sits on the editor surface and follows the theme exactly
//     like an ```svg figure. mermaid.js's `default` theme was light-only,
//     which is what the white card used to be for.
//  3. **The authored sanitizer tier.** pele's output carries no <style> or
//     <foreignObject> (the latter only with a `math` resolver returning HTML,
//     which we don't pass), and its only url() are fragment references (the
//     sankey link gradients), so it passes the strictest tier — the shared
//     render-and-sanitize step lives in chat-protocol's `mermaidFence.ts`,
//     the same one the chat renderer calls.
//
// No streaming here: the widget only exists while the cursor is outside the
// fence, so the source it sees is final — a broken fence is an error card.

const engine: MermaidEngine = { render: peleRender };

/**
 * Results by font + source. Widgets compare by source (`eq`), so a cursor
 * move keeps the DOM; this cache is for a fence that scrolls out of the
 * viewport and back, or the same diagram in two notes.
 */
const mermaidCache = new Map<string, MermaidRenderResult>();
const MERMAID_CACHE_MAX = 64;

function detectMermaidType(code: string): DiagramType | null {
  try {
    return detectType(code);
  } catch {
    return null;
  }
}

/** The fallback stack inline-preview.css gives inline code when `--atomic-editor-font-mono` is unset. */
const EDITOR_MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

interface EditorFont {
  family: string;
  /** Inline code's font, for `<code>` / `<kbd>` in labels. */
  mono: string;
  size: number;
}

/** Fonts of the editor's text — pele measures labels with them, so they must be the fonts that draw them. */
function editorFont(view: EditorView): EditorFont {
  const style = getComputedStyle(view.contentDOM);
  const size = Math.round(parseFloat(style.fontSize));
  return {
    family: style.fontFamily,
    mono: style.getPropertyValue('--atomic-editor-font-mono').trim() || EDITOR_MONO_FALLBACK,
    size: Number.isFinite(size) && size > 0 ? size : 14,
  };
}

function renderMermaid(code: string, font: EditorFont): MermaidRenderResult {
  const key = `${font.family}\u0000${font.mono}\u0000${font.size}\u0000${code}`;
  const hit = mermaidCache.get(key);
  if (hit) return hit;
  const result = renderMermaidFigure(engine, code, {
    closed: true,
    fontFamily: font.family,
    fontFamilyMono: font.mono,
    fontSize: font.size,
  }) ?? { error: 'Mermaid render failed' };
  mermaidCache.set(key, result);
  if (mermaidCache.size > MERMAID_CACHE_MAX) {
    mermaidCache.delete(mermaidCache.keys().next().value as string);
  }
  return result;
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly exportConfig?: FigureExportConfig,
  ) {
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

    const paint = (): void => {
      diagram.classList.remove('cm-atomic-mermaid-loading');
      const result = renderMermaid(this.code, editorFont(view));
      if ('figure' in result) {
        // 失败关闭：figure.svg 已过手写档净化（renderMermaidFigure 里），空串不会走到这里
        diagram.innerHTML = result.figure.svg;
        // 按钮等图出来再挂：失败的卡片没有可导出的东西
        attachFigureExport(this.exportConfig, 'mermaid', this.code, wrap, diagram);
      } else {
        paintError(diagram, this.code, result.error);
      }
    };

    const type = detectMermaidType(this.code);
    if (type === null || registered(type)) {
      if (view.contentDOM.classList.contains('cm-content')) {
        paint();
      } else {
        // CM6 draws the first widgets inside the EditorView constructor,
        // before the content DOM gets its `cm-content` class and theme —
        // the font read then is the inherited one, not the editor body's,
        // and pele would measure (and draw) the labels at the wrong size.
        // The constructor finishes synchronously, so a microtask later the
        // editor is styled.
        queueMicrotask(() => {
          paint();
          if (wrap.isConnected) view.requestMeasure();
        });
      }
    } else {
      // First diagram of this type in this run: fetch its chunk, then paint.
      // A failed load paints too — the render then reports the type as
      // unsupported instead of leaving a placeholder up forever.
      diagram.classList.add('cm-atomic-mermaid-loading');
      diagram.textContent = 'Rendering diagram…';
      const done = (): void => {
        paint();
        // The SVG changed the widget's height — ask CM6 to re-measure
        // so the block heightmap and scroll stay correct. A widget that was
        // already dropped (document switched, editor destroyed) has nothing
        // left to measure.
        if (wrap.isConnected) view.requestMeasure();
      };
      load(type).then(done, done);
    }

    revealOnClick(view, wrap);
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

/**
 * Obsidian-style live preview for ```mermaid fenced code blocks: the
 * rendered diagram replaces the source when the cursor is outside the
 * fence, and the raw code returns when the cursor moves inside.
 */
export function mermaidBlocks(exportConfig?: FigureExportConfig): Extension {
  return fencedPreviewField({
    lang: 'mermaid',
    // 渲染失败不在这里判：widget 自己画错误卡（写完了还画不出来就是写坏了，源码要看得见）
    widget: (code) => new MermaidWidget(code, exportConfig),
  });
}
