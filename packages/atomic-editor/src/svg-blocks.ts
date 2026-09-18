import { EditorView, WidgetType } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  authoredSvgFrame,
  isSvgComplete,
} from '@shuvix/chat-protocol/utils/svgFence';
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize';
import { fencedPreviewField, revealOnClick } from './fenced-preview';

// ```svg blocks — hand-written SVG rendered in place, the same carrier the
// chat renderer draws figures from (chat-ui's CodeBlock). Sharing the
// carrier is the point: an agent that learned to draw a figure draws it the
// same way whether the figure lands in a reply or in a note.
//
// Three things are deliberately NOT like the mermaid widget next door:
//
//  1. **Rendering is synchronous.** Sanitizing is a pure function over the
//     source, so there is no loading state and no render queue. There *is* a
//     memo, for a different reason than mermaid's: the answer is needed twice
//     per rebuild — once to decide whether to decorate at all, once to paint —
//     and `buildBlocks` asks on every selection change. Keys are fence sources
//     that have actually been rendered, and a fence being typed into is not
//     decorated at all (the cursor is inside it), so this does not accumulate
//     a key per keystroke.
//  2. **No white card.** Mermaid renders its own light-themed product, so it
//     needs a light surface under it; an authored figure takes every color
//     from --viz-* / --theme-* tokens (see themes.css and the visual-guide
//     prompt fragment) and belongs directly on the editor surface. A white
//     card would turn a dark-theme figure into pale ink in a white box.
//  3. **`sanitizeAuthoredSvg`, not the rendered tier.** The author controls
//     every tag here rather than writing mermaid source, so <style>,
//     <foreignObject> and anything that would fetch are all refused — see the
//     header of svgSanitize.ts for why each one.
//
// 来源比聊天那边更宽：聊天里那段 SVG 一定是模型刚写的，而笔记本打开的可能是任何一个 md
// —— 从网上拷进知识库的笔记、仓库里的某个文件。净化档位（authored）恰好就是为这种情况
// 写的那一档，而且失败关闭，所以来源变宽不改变结论；但值得写下来，别让下一个人以为这里
// 的输入和聊天同源。

/**
 * 净化一次、两处用：工厂据此决定**画不画**，widget 据此决定**画什么**。
 * 两处各算一遍会在每次光标移动时多跑一次 DOMParser（上限 256KB 的文档解析）。
 */
const sanitizedCache = new Map<string, string>();

function figureHtml(code: string): string {
  const cached = sanitizedCache.get(code);
  if (cached !== undefined) return cached;
  const frame = authoredSvgFrame(code);
  const clean = frame ? sanitizeAuthoredSvg(frame) : '';
  sanitizedCache.set(code, clean);
  return clean;
}

class AuthoredSvgWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }

  // Identity is the source only — a cursor move that leaves this block
  // untouched rebuilds the decoration set, but `eq` lets CM6 keep the
  // existing DOM instead of re-sanitizing.
  eq(other: AuthoredSvgWidget): boolean {
    return other.code === this.code;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-atomic-svg';
    wrap.setAttribute('contenteditable', 'false');

    const figure = document.createElement('div');
    figure.className = 'cm-atomic-svg-figure';
    wrap.appendChild(figure);

    // 画不出东西的那一帧根本到不了这里（工厂已经拦掉），所以这里只有两种结局。
    const clean = figureHtml(this.code);
    if (clean) {
      // 失败关闭：净化返回空串（找不到 <svg> 根，或整段被剥空）绝不注入未经检查的标记。
      figure.innerHTML = clean;
    } else {
      paintError(figure, this.code);
    }

    revealOnClick(view, wrap);
    return wrap;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

/** 判死时保留源码可见 —— 与 mermaid 的错误卡同形，作者得看得见自己写了什么 */
function paintError(el: HTMLElement, code: string): void {
  el.classList.add('cm-atomic-svg-error');
  const label = document.createElement('div');
  label.className = 'cm-atomic-svg-error-label';
  label.textContent = 'SVG figure was rejected';
  const detail = document.createElement('pre');
  detail.className = 'cm-atomic-svg-error-detail';
  detail.textContent = code;
  el.replaceChildren(label, detail);
}

/**
 * Obsidian-style live preview for ```svg fenced code blocks: the figure
 * replaces the source when the cursor is outside the fence, and the raw
 * markup returns when the cursor moves inside.
 */
export function svgBlocks(): Extension {
  return fencedPreviewField({
    lang: 'svg',
    widget: (code) => {
      // 开标签都没闭合 → 不渲染，源码原样留着（手打到一半时看到的是自己正在敲的那行字）。
      if (authoredSvgFrame(code) === null) return null;
      // **「写坏了」与「还没写完」是两回事，只有前者该出错误卡** —— 与聊天同一条闸
      // （CodeBlock 的 `!svgHtml && settled`）。只有开标签的那一帧净化后恰好是空串
      // （authored 档「剥空即判死」），而那不是失败：磁盘上截断在开标签处的文件、半成品
      // 笔记失焦的那一刻都落在这里，给它一张红卡等于把「你还没写完」说成「你写错了」。
      // 这一判必须在工厂里而不是 toDOM 里 —— widget 建出来就一定占一块地方，在那里
      // 什么都不画得到的是一个空框，比源码更没用。
      if (!figureHtml(code) && !isSvgComplete(code)) return null;
      // 剩下的两种都进 widget：画得出来就画（含截断源码里能画的那部分），
      // 写完了却被判死就出错误卡。
      return new AuthoredSvgWidget(code);
    },
  });
}
