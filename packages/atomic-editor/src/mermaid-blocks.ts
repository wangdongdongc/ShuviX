import { EditorView, WidgetType } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { sanitizeRenderedSvg } from '@shuvix/chat-protocol/utils/svgSanitize';
import { fencedPreviewField, revealOnClick } from './fenced-preview';

// Mermaid blocks.
//
// Obsidian-style live preview for ```mermaid fenced code. The reveal
// machinery (cursor in → source, cursor out → diagram) lives in
// `fenced-preview.ts` and is shared with ```svg; this file is mermaid's
// half: the async render, its cache, and the widget.

// ---------------------------------------------------------------------
// Async mermaid rendering
//
// `mermaid` is heavy, so it's loaded lazily on first diagram and the
// SVG is cached by source. The widget owns its async lifecycle: it
// paints a placeholder, renders, then mutates its own DOM in place —
// no decoration rebuild needed for completion (and `eq` keeps the DOM
// across cursor moves, so a cached diagram never re-renders).

export type MermaidResult = { svg?: string; error?: string };
export type MermaidTheme = 'default' | 'dark';

const mermaidCache = new Map<string, MermaidResult>();
const mermaidPending = new Map<string, Promise<MermaidResult>>();
let mermaidModule: Promise<typeof import('mermaid')> | null = null;
let mermaidIdCounter = 0;
/** 当前全局 initialize 过的主题（mermaid 配置是全局的，切主题须重新 initialize） */
let initializedTheme: MermaidTheme | null = null;
/** 渲染串行链 —— initialize 是全局副作用，不同主题的并发渲染必须排队防串味 */
let renderChain: Promise<unknown> = Promise.resolve();

/** 缓存键：主题参与分键（同一份源码亮/暗两份 SVG 各自缓存） */
const cacheKey = (theme: MermaidTheme, code: string): string => `${theme}\u0000${code}`;

function loadMermaid(): Promise<typeof import('mermaid')> {
  if (!mermaidModule) {
    mermaidModule = import('mermaid');
  }
  return mermaidModule;
}

/**
 * 渲染 mermaid 源码为 SVG（懒加载模块 + 按 主题+源码 缓存）。
 * 编辑器内嵌 widget 固定 'default'（白底卡片）；对话里的 mermaid 块按宿主明暗传入主题。
 */
export function renderMermaid(
  code: string,
  opts: { theme?: MermaidTheme } = {},
): Promise<MermaidResult> {
  const theme = opts.theme ?? 'default';
  const key = cacheKey(theme, code);
  const cached = mermaidCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = mermaidPending.get(key);
  if (inFlight) return inFlight;

  const promise = (renderChain = renderChain.then(
    async (): Promise<MermaidResult> => {
      const id = `atomic-mermaid-${mermaidIdCounter++}`;
      try {
        const m = await loadMermaid();
        if (initializedTheme !== theme) {
          m.default.initialize({
            startOnLoad: false,
            theme,
            securityLevel: 'loose',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          });
          initializedTheme = theme;
        }
        const { svg } = await m.default.render(id, code);
        // 净化后再出厂：调用方（笔记本 widget / 对话 mermaid 块）都是 innerHTML 直接注入特权渲染进程，
        // 而 mermaid 的 `click X href "javascript:..."` 指令会把 javascript: 锚点原样带进 SVG。
        // 在这里做而不是在各注入点做 —— 缓存里存的就是净化后的结果，新增消费方不会漏。
        const clean = sanitizeRenderedSvg(svg);
        // 失败关闭：净化器解析不了就当渲染失败，让问题可见而不是静默出一张空图
        const result: MermaidResult = clean
          ? { svg: clean }
          : { error: 'SVG sanitization failed' };
        mermaidCache.set(key, result);
        return result;
      } catch (e) {
        const result: MermaidResult = {
          error: e instanceof Error ? e.message : String(e),
        };
        mermaidCache.set(key, result);
        return result;
      } finally {
        mermaidPending.delete(key);
        // mermaid leaves its measurement node behind on parse error.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    },
  )) as Promise<MermaidResult>;
  mermaidPending.set(key, promise);
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

    const cached = mermaidCache.get(cacheKey('default', this.code));
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
export function mermaidBlocks(): Extension {
  return fencedPreviewField({
    lang: 'mermaid',
    // 渲染失败不在这里判：mermaid 是异步的，此刻还不知道结果，widget 自己会画错误卡
    widget: (code) => new MermaidWidget(code),
  });
}
