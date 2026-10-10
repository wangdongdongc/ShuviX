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
import { renderMermaid } from '../mermaid-blocks';

// ```svg / ```mermaid 预览上的「导出」按钮（figure-export.ts + 两个 widget 的接线）。
//
// 编辑器自己没有导出界面：按钮只是把 {kind, code, anchor, figure} 交给宿主（ShuviX 的
// LivePreviewEditor 再开 chat-ui 的面板）。所以这里钉的是**交接**：
//
//  - 有没有按钮（AE-1/2/5/6/9/11）：宿主没给 `figureExport` 就一颗都不画；只有画出来、而且
//    写完了的图才有（错误卡、渲染中、截断源码画出来的半张图都没有）；只读文档也有；
//  - 交出去的是什么（AE-3）：围栏源码原样、按钮本身、放 <svg> 的那一格；
//  - 按钮不揭示源码（AE-4）：widget 在 mousedown 上揭示源码，按钮把自己的 mousedown 吞掉；
//  - 宿主换了处理函数不必重挂编辑器（AE-7/8/12）：点击与标签都在那一刻重读；
//  - mermaid 每次渲染前都按请求的主题重新 initialize（AE-13，配置是整页共用的）。
//
// 焦点 / selectionchange 的两条注意事项与 fenced-svg.test.tsx 文件头一致，助手照抄过来。

// 理由同 fenced-svg.test.tsx：happy-dom 同步派发 selectionchange，CM6 会在 update 中途重入。
const nativeAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, ...rest: unknown[]) => {
  if (type === 'selectionchange') return;
  return (nativeAddEventListener as unknown as (...args: unknown[]) => void)(type, ...rest);
}) as typeof document.addEventListener;

// mermaid：initialize / render 记进同一条日志；render 返回测试手里的 deferred（或立即成功）
const mm = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    pending: [] as Array<{
      code: string;
      resolve: (v: { svg: string }) => void;
      reject: (e: Error) => void;
    }>,
    /** 这些源码一调用就成功 */
    instant: new Set<string>(),
  };
  return state;
});

vi.mock('mermaid', () => ({
  default: {
    initialize: (config: { theme?: string }) => {
      mm.log.push(`init:${config.theme}`);
    },
    render: (id: string, code: string) =>
      new Promise<{ svg: string }>((resolve, reject) => {
        mm.log.push(`render:${code}`);
        if (mm.instant.has(code)) {
          resolve({ svg: `<svg data-mermaid="${id}" viewBox="0 0 10 10"><rect/></svg>` });
          return;
        }
        mm.pending.push({ code, resolve, reject });
      }),
  },
}));

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

beforeEach(() => {
  mm.log.length = 0;
});

afterEach(async () => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
  // 挂着的 mermaid 渲染会堵住模块级串行链：收掉
  for (const p of mm.pending.splice(0)) p.reject(new Error('left over by the test'));
  await settle();
});

async function flushFocus(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** 让 mermaid 的异步渲染（懒加载 + 串行链）落定 */
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
  it('AE-6 渲染中没有；出图后有（data-figure-export="mermaid"）；同一段源码再挂（缓存命中）第一帧就有', async () => {
    const code = 'graph TD\n  ae6a --> ae6b';
    const h = handler();
    const m = mount(mermaidDoc(code), { figureExport: h });
    await settle();
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).not.toBeNull();
    expect(buttons(m)).toHaveLength(0);

    const p = mm.pending.find((x) => x.code === code);
    expect(p, 'mermaid.render 没被调到').toBeDefined();
    p!.resolve({ svg: '<svg data-ae6="1" viewBox="0 0 10 10"><rect/></svg>' });
    mm.pending.splice(mm.pending.indexOf(p!), 1);
    await settle();
    const [btn] = buttons(m);
    expect(btn?.getAttribute('data-figure-export')).toBe('mermaid');
    clickButton(btn);
    const req = h.onExport.mock.calls[0][0];
    expect(req.kind).toBe('mermaid');
    expect(req.code).toBe(code);
    expect(req.figure.classList.contains('cm-atomic-mermaid-diagram')).toBe(true);
    expect(req.figure.querySelector('svg[data-ae6]')).not.toBeNull();

    // 缓存命中：第一帧就是图 + 按钮
    const again = mount(mermaidDoc(code), { figureExport: handler() });
    expect(again.host.querySelector('.cm-atomic-mermaid-diagram svg')).not.toBeNull();
    expect(buttons(again)).toHaveLength(1);
  });

  it('AE-6 渲染失败：错误卡，没有按钮', async () => {
    const code = 'graph TD\n  ae6c -->';
    const m = mount(mermaidDoc(code), { figureExport: handler() });
    await settle();
    const p = mm.pending.find((x) => x.code === code);
    expect(p).toBeDefined();
    p!.reject(new Error('Parse error'));
    mm.pending.splice(mm.pending.indexOf(p!), 1);
    await settle();
    expect(m.host.querySelector('.cm-atomic-mermaid-error')).not.toBeNull();
    expect(buttons(m)).toHaveLength(0);
  });

  it('AE-13 每次渲染前都按请求的主题 initialize —— 连着两次 dark 也不省（中间可能被对话那边改过）', async () => {
    const codes = ['ae13-a', 'ae13-b', 'ae13-c', 'ae13-d'].map((s) => `graph TD\n  ${s}1 --> ${s}2`);
    codes.forEach((c) => mm.instant.add(c));
    const themes = ['dark', 'dark', 'default', 'dark'] as const;
    for (let i = 0; i < codes.length; i++) {
      const res = await renderMermaid(codes[i], { theme: themes[i] });
      expect(res.svg).toBeTruthy();
    }
    expect(mm.log).toEqual(
      codes.flatMap((c, i) => [`init:${themes[i]}`, `render:${c}`]),
    );
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
