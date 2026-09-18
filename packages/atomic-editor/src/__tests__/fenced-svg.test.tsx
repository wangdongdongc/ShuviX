import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EditorView } from '@codemirror/view';
import { AtomicCodeMirrorEditor } from '../AtomicCodeMirrorEditor';
import { setFrozen } from '../editor-interaction';

// 笔记本 live preview 里的 ```svg 围栏 —— **就地出图**。
//
// 一份而不是两份：`fenced-preview.ts` 的揭示机制（光标出围栏 → 图、进围栏 → 源码）与
// `svg-blocks.ts` 的画/不画判定是同一个特性的两半，拆开会让「图没出来」这类失败在两份
// 里各绿一半。FP-* 钉前者（它同时承载 ```mermaid，所以串台也在这里钉），SB-* 钉后者。
//
// 两条贯穿全文的注意事项，写在这里免得每条用例重复：
//
//  1. **焦点是异步的，而且还得有人把它捅出来。** `focusedField` 由 focusWatcher 在
//     `queueMicrotask` 里派发（见 editor-interaction.ts），而揭示读的正是它 —— 所以
//     「focus() 之后同步读 DOM」在这里是假绿/假红的来源；更隐蔽的是 `view.focus()` 自己
//     **不产出一次 update**，那条微任务于是压根不会入队（详见 `focus` 助手的注释）。
//     两半都封在 `focus()` / `blur()` 里，涉及焦点一律走它们，别手写。
//     （隔壁 local-reveal.test.tsx 不需要，那是 ViewPlugin 直接读 `view.hasFocus`。）
//  2. **只做结构断言。** happy-dom 把 `<rect/>` 序列化成 `<rect></rect>`，所以一律
//     `querySelector`，绝不对 innerHTML 做字符串相等；而它的 `getBoundingClientRect`
//     全是 0，任何尺寸/裁切断言只能进 e2e（见 e2e/specs/notebook/svg-figure.e2e.ts）。

// happy-dom **同步**派发 selectionchange，真实浏览器是异步的（事件排进任务队列）。
// 差别在这里是致命的：CM6 在一次 update 中途把选区写进 DOM，同步事件让它自己的
// DOMObserver 立刻回调 applyDOMChange 并再 dispatch 一次，于是抛
// "Calls to EditorView.update are not allowed while an update is in progress"。
// 这份用例里选区只由 dispatch 驱动（DOM → 状态那条反向路需要真实布局，happy-dom 没有），
// 所以直接不注册这个监听 —— 效果等同浏览器里那次姗姗来迟、读到状态与 DOM 一致后什么都
// 不做的回调。必须在挂载之前打好：CM6 是在构造 view 时注册它的。
const nativeAddEventListener = document.addEventListener.bind(document);
document.addEventListener = ((type: string, ...rest: unknown[]) => {
  if (type === 'selectionchange') return;
  return (nativeAddEventListener as unknown as (...args: unknown[]) => void)(type, ...rest);
}) as typeof document.addEventListener;

// mermaid 是全仓唯一值得在这里挡掉的动态 import：只有 FP-5（两种围栏共存）需要一个
// mermaid widget 真的存在，而真模块会把这份用例拖慢到不成比例。
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: (id: string) => Promise.resolve({ svg: `<svg data-mermaid="${id}"></svg>` }),
  },
}));

// ---- 夹具 ---------------------------------------------------------------

/** 一张能画出来的图：authored 档全过，出图后 DOM 里有一个 <rect> */
const FIGURE = [
  '<svg viewBox="0 0 120 60">',
  '  <rect width="120" height="60" fill="var(--viz-1)"/>',
  '</svg>',
].join('\n');

/** 行号：1 intro / 2 空 / 3 ```svg / 4 `<svg …>` / 5 `<rect …>` / 6 `</svg>` / 7 ``` / 8 空 / 9 outro */
const DOC = ['intro', '', '```svg', FIGURE, '```', '', 'outro'].join('\n');

// ---- 挂载 / 探针 --------------------------------------------------------

type Mounted = { host: HTMLElement; root: Root; view: EditorView };
const mounts: Mounted[] = [];

function mount(doc: string, opts: { readOnly?: boolean } = {}): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <AtomicCodeMirrorEditor markdownSource={doc} readOnly={opts.readOnly ?? false} />,
    ),
  );
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
  const m = { host, root, view };
  mounts.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    act(() => m.root.unmount());
    m.host.remove();
  }
});

/** 放行焦点镜像那条微任务（见文件头第 1 条）；两轮，免得依赖入队顺序 */
async function flushFocus(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/**
 * 聚焦并把焦点镜像推到状态里。
 *
 * 跟着的空事务不是仪式：focusWatcher 挂在 `ViewUpdate.focusChanged` 上，而那面旗只在
 * **发生一次 update** 时才被点亮。真实应用里聚焦后总有测量/重绘把 update 带出来（rAF
 * 驱动），happy-dom 不跑那一轮，于是 `view.focus()` 自己不产出 update，镜像永远不派发 ——
 * 没有这一下，后面每条「聚焦后该揭示」的断言都会稳定地假绿（图一直在，因为它压根没聚焦过）。
 */
async function focus(m: Mounted): Promise<void> {
  act(() => {
    m.view.focus();
    m.view.dispatch({});
  });
  await flushFocus();
}

/** 失焦，同样要一次 update 才能把镜像翻回去（理由同 `focus`） */
async function blur(m: Mounted): Promise<void> {
  act(() => {
    m.view.contentDOM.blur();
    m.view.dispatch({});
  });
  await flushFocus();
}

function caret(m: Mounted, pos: number): void {
  act(() => {
    m.view.dispatch({ selection: { anchor: pos } });
  });
}

/** 把光标放到第 n 行行首（围栏的开/闭 ``` 行也按行号点名） */
function caretAtLine(m: Mounted, n: number): void {
  caret(m, m.view.state.doc.line(n).from);
}

/** 已出图的块数（错误卡也是一块 widget，所以这个数不区分两者） */
const figures = (m: Mounted): number => m.host.querySelectorAll('.cm-atomic-svg').length;

/** 判死时才有的红卡 */
const errorCards = (m: Mounted): number =>
  m.host.querySelectorAll('.cm-atomic-svg-error').length;

/** 已渲染那张图的 <svg> 根（用于结构断言与节点身份比较） */
const figureSvg = (m: Mounted): Element | null =>
  m.host.querySelector('.cm-atomic-svg-figure svg');

const contentText = (m: Mounted): string =>
  m.host.querySelector('.cm-content')?.textContent ?? '';

/**
 * 围栏的源码行还在不在 —— 认 inline-preview 给 FencedCode 每一行打的行装饰。
 *
 * 不按文本认：` ```svg ` 这串本身是 CodeMark + CodeInfo，光标不在块上时 inline-preview
 * 会把它藏掉，于是「源码露着」与「整块被 widget 顶掉」在 textContent 上长得一样。
 * 行装饰则只跟着真实存在的行走：整块被 replace 掉时一行都不剩。
 */
const fenceLines = (m: Mounted): number =>
  m.host.querySelectorAll('.cm-atomic-fenced-code').length;

// ========================================================================
// FP-*：揭示机制（fenced-preview.ts）
// ========================================================================

describe('```svg 围栏的揭示（光标进出）', () => {
  it('FP-1 光标在围栏外 → 整块是图；移进围栏任一行（含开/闭 ``` 行）→ 源码；再移出 → 又是图', async () => {
    // 红了就是揭示机制整体死了 —— 要么永远出图（图没法编辑），要么永远是源码（等于没这个特性）。
    const m = mount(DOC);
    await focus(m);

    caretAtLine(m, 1);
    expect(figures(m)).toBe(1);
    expect(fenceLines(m)).toBe(0);

    for (const line of [3, 4, 5, 6, 7]) {
      caretAtLine(m, line);
      expect(figures(m), `光标在第 ${line} 行`).toBe(0);
      // 源码回来了，而且是可编辑的真实行（5 行：开 ``` / 三行图 / 闭 ```）
      expect(fenceLines(m), `光标在第 ${line} 行`).toBe(5);
      expect(contentText(m), `光标在第 ${line} 行`).toContain('viewBox="0 0 120 60"');
    }

    caretAtLine(m, 9);
    expect(figures(m)).toBe(1);
    expect(fenceLines(m)).toBe(0);
  });

  it('FP-2 边界对：光标在结束 ``` 行上 = 源码，在紧邻的下一行 = 图', async () => {
    // 红了就是 `doc.lineAt(node.to)` 差一行。症状不是「图不见了」而更阴：在图**下面**
    // 打字，上面那张图莫名其妙变回源码（多一行），或者点不进结束 ``` 行去改（少一行）。
    const m = mount(DOC);
    await focus(m);

    caretAtLine(m, 7);
    expect(figures(m)).toBe(0);

    caretAtLine(m, 8);
    expect(figures(m)).toBe(1);
  });

  it('FP-3 光标停在围栏内但编辑器失焦 → 照样是图', async () => {
    // `activeLines` 只在 focused 时才填。红了 = 笔记刚打开、或用户点到别处时，图停在
    // 源码态 —— 一篇只读着看的笔记于是满屏 SVG 标记。
    const m = mount(DOC);

    // 从未聚焦过（刚打开的笔记）：哪怕光标就在围栏里也该出图
    caretAtLine(m, 4);
    expect(figures(m)).toBe(1);

    await focus(m);
    expect(figures(m)).toBe(0); // 同一处光标，聚焦之后才揭示

    await blur(m);
    expect(figures(m)).toBe(1); // 点到别处 → 收回源码
  });

  it.each([
    ['正文为空', ['```svg', '```'].join('\n'), 2],
    ['正文只有空白', ['```svg', '   ', '```'].join('\n'), 3],
  ])('FP-4 空围栏不渲染，保持源码：%s', (_label, doc, lines) => {
    // 红了 = 刚敲完 ```svg 围栏头，一块 widget 就盖上来，字都没法往里打。
    const m = mount(doc);
    expect(figures(m)).toBe(0);
    expect(fenceLines(m)).toBe(lines);
  });

  it('FP-5 ```svg 与 ```mermaid 共存：进谁的围栏只揭示谁', async () => {
    // 两种围栏各有一个 StateField，装饰集互不相干。红了 = 两份装饰串台：改 mermaid
    // 源码时旁边那张 SVG 图跟着塌回源码（反之亦然），而两边的代码看起来都没错。
    const doc = [
      '```svg',
      FIGURE,
      '```',
      '',
      '```mermaid',
      'graph TD;',
      'A-->B;',
      '```',
    ].join('\n');
    // 行号：1 ```svg / 2-4 图 / 5 ``` / 6 空 / 7 ```mermaid / 8-9 图源 / 10 ```
    const m = mount(doc);
    await focus(m);
    // mermaid widget 的渲染是异步的（此处已 mock），让它落定再断言，免得卸载时炸在 then 里
    await new Promise((resolve) => setTimeout(resolve, 0));

    caretAtLine(m, 8); // 进 mermaid
    expect(m.host.querySelectorAll('.cm-atomic-mermaid').length).toBe(0);
    expect(figures(m)).toBe(1); // svg 那张纹丝不动

    caretAtLine(m, 2); // 进 svg
    expect(figures(m)).toBe(0);
    expect(m.host.querySelectorAll('.cm-atomic-mermaid').length).toBe(1);
  });

  it('FP-7 只读文档里点图不揭示：图留着、选区不动', async () => {
    // 真实路径是内置知识库 `shuvix` 的只读笔记本。红了 = 在一篇改不动的笔记里点一下图，
    // 它塌回源码却又编辑不了，只剩满屏标记。
    const m = mount(DOC, { readOnly: true });
    expect(figures(m)).toBe(1);

    const before = m.view.state.selection.main.anchor;
    const wrap = m.host.querySelector('.cm-atomic-svg') as HTMLElement;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushFocus();

    expect(figures(m)).toBe(1);
    expect(m.view.state.selection.main.anchor).toBe(before);
  });

  it('FP-8 指针按下期间冻结：选区进围栏图不塌，解冻那一下才应用揭示', async () => {
    // 红了 = 「点击变拖选」那个 bug 回来了：图在 mousedown 与 mouseup 之间塌成源码，
    // 鼠标底下的内容整体上移，CM6 于是把这一次点击算成一段拖动选区。
    const m = mount(DOC);
    await focus(m);
    caretAtLine(m, 1);
    expect(figures(m)).toBe(1);

    act(() => m.view.dispatch({ effects: setFrozen.of(true) }));
    caretAtLine(m, 4);
    expect(figures(m)).toBe(1);

    act(() => m.view.dispatch({ effects: setFrozen.of(false) }));
    expect(figures(m)).toBe(0);
  });

  it('FP-9 图渲染着时改它的源码 → 图跟着变，不 stale', async () => {
    // 真实路径：智能体 `edit` 这篇笔记。红了 = 文件已经改了，屏幕上还是旧图 ——
    // 用户看到的与磁盘上的不是同一张，而没有任何报错。
    const m = mount(DOC);
    await focus(m);
    caretAtLine(m, 1);
    expect(figureSvg(m)?.querySelector('rect')).not.toBeNull();

    const at = m.view.state.doc.toString().indexOf('<rect');
    act(() =>
      m.view.dispatch({ changes: { from: at + 1, to: at + 5, insert: 'circle' } }),
    );

    expect(figureSvg(m)?.querySelector('circle')).not.toBeNull();
    expect(figureSvg(m)?.querySelector('rect')).toBeNull();
  });

  it('FP-10 光标不动的外部插入新增一个 ```svg 围栏 → 新图出现', async () => {
    // 这一条钉 `changeAffectsBlocks` 的**第二段**（扫改动行里有没有 ```）。它看着像死代码：
    // 任何用户输入都会移动光标，选区分支先一步触发重建。唯一承重的就是这条路 —— 智能体
    // 写笔记：改动落在光标之后、光标没动。红了 = 智能体画完的图要等用户碰一下才显形。
    const m = mount('intro\n');
    await focus(m);
    caret(m, 0);
    expect(figures(m)).toBe(0);

    const end = m.view.state.doc.length;
    act(() =>
      m.view.dispatch({
        changes: { from: end, insert: ['', '```svg', FIGURE, '```', ''].join('\n') },
      }),
    );

    // 前提成立才算钉住了那一段：光标真的没动，所以走不到选区分支
    expect(m.view.state.selection.main.anchor).toBe(0);
    expect(figures(m)).toBe(1);
  });

  it('FP-11 点图把光标放回围栏：图变回源码、选区落在围栏首行', async () => {
    // 红了 = 图成了一块点不动的死块 —— 只能靠方向键摸进去，用户会以为它不可编辑。
    const m = mount(DOC);
    expect(figures(m)).toBe(1);

    const wrap = m.host.querySelector('.cm-atomic-svg') as HTMLElement;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flushFocus(); // 揭示要等焦点镜像落地（文件头第 1 条）

    expect(figures(m)).toBe(0);
    const line = m.view.state.doc.lineAt(m.view.state.selection.main.anchor).number;
    expect(line).toBe(3); // ```svg 那一行
  });
});

// ========================================================================
// SB-*：画/不画与画什么（svg-blocks.ts）
// ========================================================================

describe('```svg 围栏的渲染判定', () => {
  it('SB-1 源码还没写完（开标签未闭合）→ 不渲染、不出错误卡，源码原样', () => {
    // 「还没写完」与「写坏了」是两回事。红了 = 手打到 `<svg viewBox="0 0 4` 的那一刻
    // 被扣一张红卡，等于把「你还没写完」说成「你写错了」。
    const m = mount(['```svg', '<svg viewBox="0 0 4', '```'].join('\n'));
    expect(figures(m)).toBe(0);
    expect(errorCards(m)).toBe(0);
    expect(contentText(m)).toContain('<svg viewBox="0 0 4');
  });

  it('SB-2 成形但被净化判死 → 错误卡 + 源码可见，且 DOM 里绝无 <svg> 被注入', () => {
    // 这一条的分量在最后半句：断的是「没放行未经检查的标记」，不是错误卡长什么样。
    // 红了 = 净化失败之后仍然把原串塞进了 DOM —— 那正是这道闸唯一要挡的事。
    const m = mount(
      ['```svg', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', '```'].join(
        '\n',
      ),
    );
    expect(errorCards(m)).toBe(1);

    const wrap = m.host.querySelector('.cm-atomic-svg') as HTMLElement;
    expect(wrap.querySelector('pre')?.textContent).toContain('<script>');
    expect(wrap.querySelectorAll('svg').length).toBe(0);
    expect(m.host.querySelectorAll('.cm-content svg').length).toBe(0);
  });

  it('SB-3 叫的是 authored 档：<rect> 在、远程地址被剥', () => {
    // 只钉「叫的是哪一档」——名单本身由 svgSanitize.dom.test.ts 负责，这里不重复。
    // 红了 = 有人把它换成了 `sanitizeRenderedSvg`：那一档放行 http(s) 地址，于是一张
    // 笔记里的图一被渲染就往外发一次请求（本应用「本地优先、不出网」的前提就此破掉）。
    //
    // 判据用远程地址而不是 `<style>`（另一处两档不同的地方）：happy-dom 的 HTML 解析器
    // 在 `<svg>` 里遇到 `<style>` 会把该元素之后的整段兄弟节点一起吞掉（实测
    // `<svg><style/><rect/></svg>` 解析后 svg 里一个孩子都不剩），于是「style 不在」这条
    // 断言在这个环境里恒真、且顺带把 rect 也一并测没了。真实浏览器不这样，那一档的
    // 标签名单由 jsdom 下的 svgSanitize.dom.test.ts 覆盖。
    const m = mount(
      [
        '```svg',
        '<svg viewBox="0 0 10 10">',
        '  <rect width="10" height="10" fill="var(--viz-2)"/>',
        '  <image href="https://example.com/beacon.png" width="4" height="4"/>',
        '</svg>',
        '```',
      ].join('\n'),
    );
    const svg = figureSvg(m);
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('rect')).not.toBeNull();

    // 远程地址：按属性值查而不是按标签名，绕开「<image> 在 HTML 解析下叫什么」的问题。
    // 元素本身留着（净化剥的是属性），所以这一条不会因为整个元素消失而空转。
    expect(svg!.querySelectorAll('*').length).toBeGreaterThanOrEqual(2);
    const remote = [...svg!.querySelectorAll('*')].filter((el) =>
      [...el.attributes].some((a) => a.value.includes('https://')),
    );
    expect(remote).toHaveLength(0);
  });

  it('SB-4 成形但被截断 → 照画能画的那部分', () => {
    // 红了 = 尾部半截的元素让整张图判死。真实路径：磁盘上被截断的文件，以及一篇
    // 半成品笔记失焦的那一刻 —— 两处都该看到已经画好的部分，而不是一张红卡。
    const m = mount(
      [
        '```svg',
        '<svg viewBox="0 0 10 10"><rect width="10" height="10"/><circle cx=',
        '```',
      ].join('\n'),
    );
    expect(figures(m)).toBe(1);
    expect(errorCards(m)).toBe(0);

    const svg = figureSvg(m);
    expect(svg?.querySelector('rect')).not.toBeNull();
    expect(svg?.querySelector('circle')).toBeNull(); // 半截的那个不画
  });

  it('SB-5 光标在别处移动时，图的 <svg> 还是同一个 DOM 节点', () => {
    // `eq` 认源码，所以一次与本块无关的重建应当复用既有 DOM。红了 = 每按一次键就
    // 重跑一遍 DOMParser 净化并换掉节点：滚动位置与块高度跟着抖，而画面看上去没错。
    const m = mount(DOC);
    caretAtLine(m, 1);
    const svg = figureSvg(m);
    expect(svg).not.toBeNull();

    caretAtLine(m, 9);
    expect(figures(m)).toBe(1);
    expect(figureSvg(m)).toBe(svg);
  });

  it('SB-6 还没写完且画不出东西 → 既不出错误卡、也不留空框', () => {
    // 与 SB-1 的区别：那条是开标签都没闭合，这条是开标签闭合了、但整段净化后为空
    // （`<svg viewBox="0 0 320 200">` 正是这种）。红了有两种长相，都比源码没用：
    // 一张说「你写错了」的红卡，或者一个比源码更没信息量的空框。
    const m = mount(['```svg', '<svg viewBox="0 0 320 200">', '```'].join('\n'));
    expect(figures(m)).toBe(0);
    expect(errorCards(m)).toBe(0);
    expect(contentText(m)).toContain('<svg viewBox="0 0 320 200">');
  });
});
