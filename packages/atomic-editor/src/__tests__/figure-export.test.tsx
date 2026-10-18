import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import {
  attachFigureExport,
  type FigureExportHandler,
  type FigureExportRequest,
} from '../figure-export';
import { load } from 'pele/lazy';

// ```svg / ```mermaid 预览上的「导出」按钮（figure-export.ts + 两个 widget 的接线）。
//
// 编辑器自己没有导出界面：按钮只是把 {kind, code, anchor, figure} 交给宿主（ShuviX 的
// LivePreviewEditor 再开 chat-ui 的面板）。所以这里钉的是**交接**：
//
//  - 有没有按钮（AE-1/2/5/6/9/11）：宿主没给 `figureExport` 就一颗都不画；只有画出来、而且
//    写完了的图才有（错误卡、渲染中、截断源码画出来的半张图都没有）；只读文档也有；
//  - 交出去的是什么（AE-3）：围栏源码原样、按钮本身、放 <svg> 的那一格；
//  - 按钮不揭示源码（AE-4）：widget 在 mousedown 上揭示源码，按钮把自己的 mousedown 吞掉；
//  - 宿主换了处理函数不必重挂编辑器（AE-7/8/12）：点击与标签都在那一刻重读。
//
// mermaid 由 pele 真渲（2026-10-17 起，同步）。`pele/lazy` 的图类型注册是本文件的模块级状态：
// AE-6 依赖 flowchart 在本文件里**第一次**被用到（先出「渲染中」，加载完才出图 + 按钮）。
// 渲染本身的细节（字体、净化、缓存、加载失败）在 mermaid-blocks.test.tsx。
//
// 焦点 / selectionchange 的两条注意事项与 fenced-svg.test.tsx 文件头一致，助手照抄过来。

// 理由同 fenced-svg.test.tsx：happy-dom 同步派发 selectionchange，CM6 会在 update 中途重入。
const nativeAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, ...rest: unknown[]) => {
  if (type === 'selectionchange') return;
  return (nativeAddEventListener as unknown as (...args: unknown[]) => void)(type, ...rest);
}) as typeof document.addEventListener;

// ---- 夹具 ---------------------------------------------------------------

const FIGURE = [
  '<svg viewBox="0 0 120 60" aria-label="AE figure">',
  '  <rect width="120" height="60" fill="var(--viz-1)"/>',
  '</svg>',
].join('\n');

/** 行号：1 intro / 2 空 / 3 ```svg / 4-6 图 / 7 ``` / 8 空 / 9 outro */
const DOC = ['intro', '', '```svg', FIGURE, '```', '', 'outro'].join('\n');

const mermaidDoc = (code: string): string =>
  ['intro', '', '```mermaid', code, '```', '', 'outro'].join('\n');

// ---- 挂载 ---------------------------------------------------------------

type Mounted = {
  host: HTMLElement;
  root: Root;
  view: EditorView;
  doc: string;
  rerender(props: { figureExport?: FigureExportHandler; readOnly?: boolean }): void;
};
const mounts: Mounted[] = [];

function mount(
  doc: string,
  opts: { readOnly?: boolean; figureExport?: FigureExportHandler } = {},
): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const renderWith = (props: { figureExport?: FigureExportHandler; readOnly?: boolean }) =>
    act(() =>
      root.render(
        <AtomicCodeMirrorEditor
          markdownSource={doc}
          readOnly={props.readOnly ?? false}
          figureExport={props.figureExport}
        />,
      ),
    );
  renderWith(opts);
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  const m: Mounted = { host, root, view, doc, rerender: renderWith };
  mounts.push(m);
  return m;
}

const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  // pele 量字宽：没有画布就退回自己的字宽表（尺寸确定）
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

async function flushFocus(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** 让图类型分包加载之后的那次补画落定 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 一个记录调用的处理函数 */
function handler(label = 'Export'): FigureExportHandler & {
  onExport: ReturnType<typeof vi.fn<(r: FigureExportRequest) => void>>;
} {
  return { label, onExport: vi.fn<(r: FigureExportRequest) => void>() };
}

const buttons = (m: Mounted): HTMLButtonElement[] =>
  Array.from(m.host.querySelectorAll<HTMLButtonElement>('.cm-atomic-figure-export'));
const figures = (m: Mounted): number => m.host.querySelectorAll('.cm-atomic-svg').length;

function clickButton(btn: HTMLElement): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => {
    btn.dispatchEvent(event);
  });
  return event;
}

// ========================================================================

describe('```svg 图上的导出按钮', () => {
  it('AE-1 宿主没给 figureExport：一颗按钮都不画', () => {
    const m = mount(DOC);
    expect(figures(m)).toBe(1);
    expect(buttons(m)).toHaveLength(0);
  });

  it('AE-2 给了：恰好一颗，type=button，aria-label = title = 宿主给的标签；挂在外层 wrap 上，不在放图那一格里', () => {
    const m = mount(DOC, { figureExport: handler('Export figure') });
    const all = buttons(m);
    expect(all).toHaveLength(1);
    const btn = all[0];
    expect(btn.getAttribute('data-figure-export')).toBe('svg');
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Export figure');
    expect(btn.title).toBe('Export figure');
    expect(btn.closest('.cm-atomic-svg')).not.toBeNull();
    expect(btn.closest('.cm-atomic-svg-figure')).toBeNull();
  });

  it('AE-3 点击：onExport 恰好一次，带 kind / 围栏源码原样 / 按钮本身 / 放净化后 <svg> 的那一格', () => {
    const h = handler();
    const m = mount(DOC, { figureExport: h });
    const btn = buttons(m)[0];
    const event = clickButton(btn);
    expect(event.defaultPrevented).toBe(true);
    expect(h.onExport).toHaveBeenCalledTimes(1);
    const req = h.onExport.mock.calls[0][0];
    expect(req.kind).toBe('svg');
    expect(req.code).toBe(FIGURE);
    expect(req.anchor).toBe(btn);
    expect(req.figure.classList.contains('cm-atomic-svg-figure')).toBe(true);
    const svg = req.figure.querySelector('svg');
    expect(svg?.getAttribute('aria-label')).toBe('AE figure');
    expect(svg?.querySelector('rect')).not.toBeNull();
    expect(req.figure.contains(btn)).toBe(false);
  });

  it('AE-4 在按钮上按下：吞掉（defaultPrevented），不揭示源码、选区不动；对照：在图上按下就揭示', async () => {
    const m = mount(DOC, { figureExport: handler() });
    const before = m.view.state.selection.main.anchor;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      buttons(m)[0].dispatchEvent(down);
    });
    await flushFocus();
    expect(down.defaultPrevented).toBe(true);
    expect(figures(m)).toBe(1);
    expect(m.view.state.selection.main.anchor).toBe(before);
    expect(m.host.querySelector('.cm-atomic-svg-figure svg')).not.toBeNull();

    const wrap = m.host.querySelector('.cm-atomic-svg') as HTMLElement;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushFocus();
    expect(figures(m)).toBe(0);
  });

  it('AE-5 净化判死的错误卡：没有按钮', () => {
    const m = mount(
      ['```svg', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', '```'].join('\n'),
      { figureExport: handler() },
    );
    expect(m.host.querySelectorAll('.cm-atomic-svg-error')).toHaveLength(1);
    expect(buttons(m)).toHaveLength(0);
  });

  it('AE-11 截断源码画得出前半张：图在，但没有按钮（半张图不导出）', () => {
    const m = mount(
      [
        '```svg',
        '<svg viewBox="0 0 10 10"><rect width="10" height="10"/><circle cx=',
        '```',
      ].join('\n'),
      { figureExport: handler() },
    );
    expect(figures(m)).toBe(1);
    expect(m.host.querySelector('.cm-atomic-svg-figure svg rect')).not.toBeNull();
    expect(buttons(m)).toHaveLength(0);
  });

  it('AE-9 只读文档：照样有按钮', () => {
    const m = mount(DOC, { readOnly: true, figureExport: handler() });
    expect(buttons(m)).toHaveLength(1);
  });

  it('AE-7 宿主换了处理函数（不重挂编辑器）：点同一颗按钮，调的是新的', () => {
    const first = handler();
    const m = mount(DOC, { figureExport: first });
    const btn = buttons(m)[0];
    const second = handler();
    m.rerender({ figureExport: second });
    // 同一颗按钮（编辑器没重挂、widget 没重画）
    expect(buttons(m)[0]).toBe(btn);
    clickButton(btn);
    expect(second.onExport).toHaveBeenCalledTimes(1);
    expect(first.onExport).not.toHaveBeenCalled();
  });

  it('AE-8 画好之后宿主撤掉了 figureExport：点按钮什么都不做、不抛', () => {
    const h = handler();
    const m = mount(DOC, { figureExport: h });
    const btn = buttons(m)[0];
    m.rerender({ figureExport: undefined });
    expect(() => clickButton(btn)).not.toThrow();
    expect(h.onExport).not.toHaveBeenCalled();
  });

  it('AE-12 宿主的标签变了（换语言）：鼠标移上图 / 按钮获得焦点时刷新', () => {
    const m = mount(DOC, { figureExport: handler('Export') });
    const btn = buttons(m)[0];
    m.rerender({ figureExport: handler('导出') });
    expect(btn.title).toBe('Export'); // 画的时候读的
    const wrap = m.host.querySelector('.cm-atomic-svg') as HTMLElement;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(btn.title).toBe('导出');
    expect(btn.getAttribute('aria-label')).toBe('导出');

    m.rerender({ figureExport: handler('エクスポート') });
    act(() => {
      btn.dispatchEvent(new FocusEvent('focus'));
    });
    expect(btn.getAttribute('aria-label')).toBe('エクスポート');
  });
});

describe('```mermaid 图上的导出按钮', () => {
  it('AE-6 第一次用到流程图：加载中没有按钮；出图后有（data-figure-export="mermaid"），交出去的是源码 / 放图那一格 / 按钮本身；同一段源码再挂第一帧就有', async () => {
    const code = 'graph TD\n  ae6a --> ae6b';
    const h = handler();
    const m = mount(mermaidDoc(code), { figureExport: h });
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).not.toBeNull();
    expect(buttons(m)).toHaveLength(0);

    await load('flowchart');
    await settle();
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).toBeNull();
    expect(m.host.querySelector('.cm-atomic-mermaid-diagram > svg.pele')).not.toBeNull();
    const [btn] = buttons(m);
    expect(btn?.getAttribute('data-figure-export')).toBe('mermaid');
    clickButton(btn);
    expect(h.onExport).toHaveBeenCalledTimes(1);
    const req = h.onExport.mock.calls[0][0];
    expect(req.kind).toBe('mermaid');
    expect(req.code).toBe(code);
    expect(req.anchor).toBe(btn);
    expect(req.figure.classList.contains('cm-atomic-mermaid-diagram')).toBe(true);
    expect(req.figure.querySelector('svg.pele')).not.toBeNull();
    expect(req.figure.contains(btn)).toBe(false);

    // 类型已注册（且结果在缓存里）：不经过「渲染中」—— 挂载那一刻的 widget 等编辑器挂上正文样式
    // 再画（推迟一个微任务，见 mermaid-blocks），冲掉微任务就是图 + 按钮
    const again = mount(mermaidDoc(code), { figureExport: handler() });
    await act(async () => {});
    expect(again.host.querySelector('.cm-atomic-mermaid-loading')).toBeNull();
    expect(again.host.querySelector('.cm-atomic-mermaid-diagram > svg.pele')).not.toBeNull();
    expect(buttons(again)).toHaveLength(1);
  });

  it('AE-6b 写坏了的流程图：错误卡，没有按钮', async () => {
    await load('flowchart');
    const m = mount(mermaidDoc('graph TD\n  ae6c -->'), { figureExport: handler() });
    await act(async () => {});
    expect(m.host.querySelector('.cm-atomic-mermaid-error')).not.toBeNull();
    expect(m.host.querySelector('.cm-atomic-mermaid-diagram svg')).toBeNull();
    expect(buttons(m)).toHaveLength(0);
  });
});

describe('attachFigureExport 直调', () => {
  it('AE-10 没有配置 / 处理函数回 null：什么都不挂', () => {
    const wrap = document.createElement('div');
    const figure = document.createElement('div');
    wrap.appendChild(figure);
    attachFigureExport(undefined, 'svg', '<svg/>', wrap, figure);
    attachFigureExport({ handler: () => null }, 'mermaid', 'graph TD', wrap, figure);
    expect(wrap.children).toHaveLength(1);
    expect(wrap.querySelector('button')).toBeNull();
  });
});
