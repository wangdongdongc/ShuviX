import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import * as editorIndex from '../index';

// 笔记本 live preview 里的 ```mermaid 围栏（mermaid-blocks.ts）—— 渲染器是 pele（2026-10-17 起）。
//
// 揭示机制（光标进出围栏）与 ```svg 共用 fenced-preview.ts，在 fenced-svg.test.tsx 里钉；导出按钮在
// figure-export.test.tsx。这里只钉 mermaid 自己那一半：
//
//  - **同步出图**（AM-1）：类型已注册就在挂载那一帧画好，没有渲染队列；
//  - **按类型懒加载**（AM-2…4）：第一次用到某种图先占位，分包到了再画并请 CM6 重新量高；加载失败也
//    画（于是是错误卡，不是永远的占位）；编辑器先没了就什么都不做；
//  - **失败关闭**（AM-5 / AM-9）：错误卡的源码以文本落地（不当 HTML 解析）；产物过手写档净化，剥空判死；
//  - **字体**（AM-6）：pele 按传进去的字体量字宽，所以传的是编辑器正文的字体与字号；
//  - **不重渲**（AM-7 / AM-8）：widget 按源码比较，光标移动保留 DOM；同一段源码只渲一次；
//  - 产物带着 pele 的类名与 `--pele-*` 中转（AM-11 —— 主题 token 靠 themes.css 的 `.pele` 接上），
//    不再垫白卡（AM-12），公共出口不再导出 renderMermaid（AM-10）。
//
// `pele/lazy` 真跑，只把 render / load 包成透传 spy。类型注册是**本文件的模块级状态**：beforeAll 只
// 加载 flowchart；pie（AM-2）、gantt（AM-3，永远加载失败）、sequence（AM-4，永远不落定之前就卸下）
// 都依赖在本文件别处不被加载。
//
// 焦点 / selectionchange 的注意事项与 fenced-svg.test.tsx 文件头一致：这里不涉及焦点（没聚焦时光标在哪
// 都显示图），selectionchange 的补丁照抄过来。happy-dom 把 `<rect/>` 序列化成 `<rect></rect>`，所以
// 只做结构断言。

vi.mock('pele/lazy', async (importOriginal) => {
  const m = await importOriginal<typeof import('pele/lazy')>();
  return { ...m, render: vi.fn(m.render), load: vi.fn(m.load) };
});

import { load, render as peleRender } from 'pele/lazy';

const render = vi.mocked(peleRender);
const loadSpy = vi.mocked(load);

// 理由同 fenced-svg.test.tsx：happy-dom 同步派发 selectionchange，CM6 会在 update 中途重入。
const nativeAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, ...rest: unknown[]) => {
  if (type === 'selectionchange') return;
  return (nativeAddEventListener as unknown as (...args: unknown[]) => void)(type, ...rest);
}) as typeof document.addEventListener;

// ---- 夹具 / 挂载 --------------------------------------------------------

/** 行号：1 intro / 2 空 / 3 ```mermaid / 4… 源码 / ``` / 空 / outro */
const mermaidDoc = (...codes: string[]): string =>
  [
    'intro',
    '',
    ...codes.flatMap((code) => ['```mermaid', code, '```', '']),
    'outro',
  ].join('\n');

type Mounted = { host: HTMLElement; root: Root; view: EditorView };
const mounts: Mounted[] = [];

/**
 * 挂一个编辑器并等第一次绘制落定。挂载那一刻的 widget 是在 EditorView 构造函数里画的，
 * 那时正文还没挂上 `cm-content` 与主题 —— widget 推迟一个微任务再量字体画图（见 mermaid-blocks），
 * 所以这里用 async act 把微任务冲掉；之后再建的 widget（光标移动、编辑）都是同步画的。
 */
async function mount(doc: string): Promise<Mounted> {
  const m = mountNow(doc);
  await act(async () => {});
  return m;
}

/** 只挂、不等：看「加载中」占位的用例用它 —— 冲微任务时一个很快的分包可能已经到了 */
function mountNow(doc: string): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AtomicCodeMirrorEditor markdownSource={doc} readOnly={false} />));
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  const m = { host, root, view };
  mounts.push(m);
  return m;
}

function unmount(m: Mounted): void {
  mounts.splice(mounts.indexOf(m), 1);
  act(() => m.root.unmount());
  m.host.remove();
}

/** 等所有已发起的图类型加载落定，再放一轮宏任务让补画跑完 */
async function settleLoads(): Promise<void> {
  await act(async () => {
    await Promise.allSettled(loadSpy.mock.results.map((r) => r.value));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const diagram = (m: Mounted): HTMLElement | null =>
  m.host.querySelector<HTMLElement>('.cm-atomic-mermaid-diagram');
const diagramSvg = (m: Mounted): SVGSVGElement | null =>
  m.host.querySelector<SVGSVGElement>('.cm-atomic-mermaid-diagram > svg');
const errorCard = (m: Mounted): HTMLElement | null =>
  m.host.querySelector<HTMLElement>('.cm-atomic-mermaid-error');
/** 以某段源码为第一个参数的 render 调用 */
const callsFor = (code: string): Array<Parameters<typeof peleRender>> =>
  render.mock.calls.filter((c) => c[0] === code);

const realGetComputedStyle = window.getComputedStyle;
/**
 * 换 getComputedStyle：被测代码读的是**全局**那一个。happy-dom 环境里 globalThis 与 window 是两个对象
 * （环境把 window 的成员抄到了 globalThis 上），只改 window 的那份被测代码看不见。
 */
const setGetComputedStyle = (fn: typeof window.getComputedStyle): void => {
  window.getComputedStyle = fn;
  globalThis.getComputedStyle = fn;
};
const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  await load('flowchart');
});

beforeEach(() => {
  render.mockClear();
  loadSpy.mockClear();
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
  setGetComputedStyle(realGetComputedStyle);
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

// ========================================================================

describe('出图（AM-1 / AM-11）', () => {
  it('AM-1 类型已注册：挂载一落定就是图（不等分包、没有加载占位）', async () => {
    const m = await mount(mermaidDoc('graph TD\n  am1a --> am1b'));
    expect(diagramSvg(m)).not.toBeNull();
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).toBeNull();
    expect(errorCard(m)).toBeNull();
    expect(callsFor('graph TD\n  am1a --> am1b')).toHaveLength(1);
  });

  it('AM-11 产物的根原样带着 pele 的类名与 --pele-* 中转（主题 token 由宿主的 .pele 接上）', async () => {
    const m = await mount(mermaidDoc('graph TD\n  am11a --> am11b'));
    const svg = diagramSvg(m)!;
    expect(svg.getAttribute('class')?.split(/\s+/)).toContain('pele');
    expect(svg.getAttribute('class')).toMatch(/^pele /);
    expect(svg.getAttribute('style')).toContain('--_bg:var(--pele-bg');
  });
});

describe('按类型懒加载（AM-2…4）', () => {
  it('AM-2 第一次用到 pie：先占位「Rendering diagram…」；分包到了就画，并请 CM6 重新量高', async () => {
    const m = mountNow(mermaidDoc('pie title am2\n  "A" : 1\n  "B" : 2'));
    const el = diagram(m)!;
    expect(el.classList.contains('cm-atomic-mermaid-loading')).toBe(true);
    expect(el.textContent).toBe('Rendering diagram…');
    expect(loadSpy).toHaveBeenCalledWith('pie');
    const measure = vi.spyOn(m.view, 'requestMeasure');

    await settleLoads();
    expect(el.classList.contains('cm-atomic-mermaid-loading')).toBe(false);
    expect(diagramSvg(m)).not.toBeNull();
    expect(errorCard(m)).toBeNull();
    expect(measure).toHaveBeenCalled();
  });

  it('AM-3 分包加载失败：不卡在占位 —— 画成错误卡（not supported + 源码）', async () => {
    const code = 'gantt\n  title am3\n  dateFormat YYYY-MM-DD\n  section S\n  t1 :a1, 2024-01-01, 3d';
    loadSpy.mockRejectedValueOnce(new Error('chunk failed'));
    const m = mountNow(mermaidDoc(code));
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).not.toBeNull();

    await settleLoads();
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).toBeNull();
    const card = errorCard(m);
    expect(card).not.toBeNull();
    expect(card!.querySelector('.cm-atomic-mermaid-error-label')?.textContent).toBe(
      'Mermaid diagram failed to render',
    );
    const detail = card!.querySelector('pre.cm-atomic-mermaid-error-detail')!.textContent ?? '';
    expect(detail).toContain('not supported');
    expect(detail).toContain(code);
  });

  it('AM-4 分包还没到编辑器就没了：到了之后不抛、也不请已经没有的视图重新量高', async () => {
    let resolveLoad!: (ok: boolean) => void;
    loadSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const m = await mount(mermaidDoc('sequenceDiagram\n  am4a->>am4b: hi'));
    expect(m.host.querySelector('.cm-atomic-mermaid-loading')).not.toBeNull();
    const measure = vi.spyOn(m.view, 'requestMeasure');
    unmount(m);

    await act(async () => {
      resolveLoad(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('失败关闭（AM-5 / AM-9）', () => {
  it('AM-5 错误卡的详情 = 渲染器的错误 + 空行 + 源码，源码以文本落地（里面的 <img onerror> 不成元素）', async () => {
    const code = 'graph TD\n  am5 -->\n  <img src=x onerror="window.__am5 = 1">';
    let message = '';
    try {
      peleRender(code, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    render.mockClear();

    const m = await mount(mermaidDoc(code));
    const detail = m.host.querySelector('.cm-atomic-mermaid-error-detail');
    expect(detail?.textContent).toBe(`${message}\n\n${code}`);
    expect(m.host.querySelector('img')).toBeNull();
    expect((window as unknown as { __am5?: number }).__am5).toBeUndefined();
  });

  it('AM-9 产物过手写档净化：<script> / onclick 剥掉、图形留下；整段都是禁用的东西就是错误卡', async () => {
    render.mockReturnValueOnce({
      // `<script/>` 自闭合：happy-dom 的 HTML 解析器会把 `<script>x</script>` 之后的兄弟整段吞掉
      // （真浏览器不会），那样「图形留下」就测不到了
      svg: '<svg viewBox="0 0 10 10"><script/><rect onclick="x" width="1" height="1"/></svg>',
      width: 10,
      height: 10,
      type: 'flowchart',
      mermaidType: 'flowchart-v2',
      links: [],
    });
    const m = await mount(mermaidDoc('graph TD\n  am9a --> am9b'));
    expect(m.host.querySelector('.cm-atomic-mermaid-diagram rect')).not.toBeNull();
    expect(m.host.querySelector('script')).toBeNull();
    expect(m.host.querySelector('[onclick]')).toBeNull();

    render.mockReturnValueOnce({
      svg: '<svg><script>x</script></svg>',
      width: 10,
      height: 10,
      type: 'flowchart',
      mermaidType: 'flowchart-v2',
      links: [],
    });
    const bad = await mount(mermaidDoc('graph TD\n  am9c --> am9d'));
    expect(errorCard(bad)).not.toBeNull();
    expect(errorCard(bad)!.textContent).toContain('SVG sanitization failed');
    expect(bad.host.querySelector('script')).toBeNull();
    expect(bad.host.querySelector('.cm-atomic-mermaid-diagram > svg')).toBeNull();
  });
});

describe('字体（AM-6）', () => {
  /**
   * 编辑器正文那一层（view.contentDOM）。按位置认、不按 `cm-content` 类名认：widget 第一次画是在
   * EditorView 的构造函数里（`new DocView`），那时 CM6 还没给 contentDOM 挂上类名与主题样式
   * （`updateAttrs` / `mountStyles` 在它之后）—— 按类名认，第一帧的那次读取就漏掉了。
   */
  const isContentDom = (el: Element): boolean =>
    el.parentElement?.classList.contains('cm-scroller') === true &&
    !el.classList.contains('cm-gutters') &&
    !el.classList.contains('cm-layer');

  /** 只改编辑器正文那一层的计算样式；其余元素照旧 */
  const stubContentFont = (fontFamily: string, fontSize: string): void => {
    setGetComputedStyle(((el: Element, pseudo?: string | null) => {
      if (isContentDom(el)) {
        return { fontFamily, fontSize, getPropertyValue: () => '' } as unknown as CSSStyleDeclaration;
      }
      return realGetComputedStyle.call(window, el, pseudo);
    }) as typeof window.getComputedStyle);
  };

  it('AM-6 按编辑器正文的字体与字号（取整）渲染；字号读不出来就按 14', async () => {
    stubContentFont('Probe Sans', '15.4px');
    const code = 'graph TD\n  am6a --> am6b';
    const m = await mount(mermaidDoc(code));
    const [call] = callsFor(code);
    expect(call?.[1]).toMatchObject({ fontFamily: 'Probe Sans', fontSize: 15 });
    expect(diagramSvg(m)!.getAttribute('style')).toContain('var(--pele-font,Probe Sans)');

    stubContentFont('Probe Sans', 'normal');
    const code2 = 'graph TD\n  am6c --> am6d';
    await mount(mermaidDoc(code2));
    expect(callsFor(code2)[0]?.[1]).toMatchObject({ fontFamily: 'Probe Sans', fontSize: 14 });
  });
});

describe('不重渲（AM-7 / AM-8）', () => {
  it('AM-7 光标在围栏外移动：同一个 <svg> 节点；改了围栏里的源码：换成新图', async () => {
    const code = 'graph TD\n  am7a --> am7b';
    const m = await mount(mermaidDoc(code));
    const svg = diagramSvg(m);
    expect(svg).not.toBeNull();

    act(() => {
      m.view.dispatch({ selection: { anchor: 0 } });
    });
    act(() => {
      m.view.dispatch({ selection: { anchor: m.view.state.doc.length } });
    });
    expect(diagramSvg(m)).toBe(svg);
    expect(callsFor(code)).toHaveLength(1);

    // 在源码最后一行末尾补一条边，光标留在文末（围栏外）
    const line = m.view.state.doc.line(5);
    expect(line.text).toBe('  am7a --> am7b');
    act(() => {
      m.view.dispatch({
        changes: { from: line.to, insert: '\n  am7b --> am7c' },
        selection: { anchor: m.view.state.doc.length + '\n  am7b --> am7c'.length },
      });
    });
    const next = diagramSvg(m);
    expect(next).not.toBeNull();
    expect(next).not.toBe(svg);
    expect(next!.querySelector('[data-id="am7c"]')).not.toBeNull();
  });

  it('AM-8 两段一模一样的围栏：同一字体下只渲一次，两处都出图', async () => {
    const code = 'graph TD\n  am8a --> am8b';
    const m = await mount(mermaidDoc(code, code));
    expect(m.host.querySelectorAll('.cm-atomic-mermaid-diagram > svg')).toHaveLength(2);
    expect(callsFor(code)).toHaveLength(1);
  });
});

describe('公共出口与样式（AM-10 / AM-12）', () => {
  it('AM-10 index 不再导出 renderMermaid（mermaid.js 时代的按主题渲染入口），mermaidBlocks 还在', () => {
    expect('renderMermaid' in editorIndex).toBe(false);
    expect(typeof editorIndex.mermaidBlocks).toBe('function');
  });

  it('AM-12 .cm-atomic-mermaid-diagram 不再垫白底（图跟编辑器底色与主题走）', () => {
    // happy-dom 换掉了全局 URL（fs 不认它的实例），所以按路径拼
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../styles/inline-preview.css'), 'utf8');
    const rule = /\.cm-atomic-mermaid-diagram\s*\{([^}]*)\}/.exec(css);
    expect(rule, '找不到 .cm-atomic-mermaid-diagram 规则').not.toBeNull();
    expect(rule![1]).not.toMatch(/background/);
    // 正控制组：读到的就是那条规则
    expect(rule![1]).toMatch(/border/);
  });
});
