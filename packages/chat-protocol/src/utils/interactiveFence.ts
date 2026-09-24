/**
 * ```interactive 围栏 —— 回复里一块**能动的**图：一段自包含的 HTML/JS，在沙箱 iframe 里跑。
 *
 * 这里只有纯函数（chat-protocol 是零依赖叶子包）：围栏名、库表、注入的 token 名单、沙箱文档
 * 的拼装、桥消息的校验、流式中「围栏闭合没有」的判定。渲染组件在 chat-ui 的 InteractiveBlock，
 * 库的协议在桌面 main 的 customProtocols。
 *
 * **隔离靠的是 iframe，不是这里的任何过滤。** 模型写的整段标记原样进 srcdoc，一个字不改 ——
 * 与 ```svg 那档（sanitizeAuthoredSvg 逐元素白名单）刻意不同：svg 是注进宿主 DOM 的，只能靠
 * 净化；这里的东西跑在另一个文档里，净化它既做不全（脚本就是要跑的），也没有必要。边界是：
 *
 *  1. `sandbox="allow-scripts"`，**不给** allow-same-origin → 不透明源：够不着父页面的 DOM、
 *     `window.api`、localStorage / IndexedDB / cookie；也不给 popups / forms / top-navigation。
 *     子框架不跑 preload（主窗口没开 nodeIntegrationInSubFrames），所以连 preload 都挂不上。
 *  2. CSP 两层取交集：srcdoc 继承宿主页面的策略，这里再在 `<head>` 最前面写一条更严的 meta CSP
 *     （SANDBOX_CSP）。meta CSP 只能再收紧、不能放宽，模型内容排在它之后，改不动它。
 *     结果是**没有任何网络出口**：connect / img / font / frame 都只剩 data:（或 none），脚本只能是
 *     内联的或来自 `shuvix-lib:`（随包发布的静态库，见 SANDBOX_LIBS）。iframe 把自己导航去外站，
 *     由宿主页面 CSP 的 frame-src 拦下（导航子框架看的是嵌入方的策略）。
 *
 * **已知管不到的两条出口**（CSP 不覆盖）：WebRTC 与 DNS 预取。要利用它们得先让模型被注入、
 * 再写出一块恶意的交互图，而拿着 bash 的档案本来就有更直接的出口 —— 记在这里，不假装没有。
 */

/** 围栏语言名 —— 刻意不叫 `html`：编程对话里 ```html 代码示例太常见，那样每个示例都会被跑起来 */
export const INTERACTIVE_FENCE_LANG = 'interactive'

/** 库协议名（`shuvix-lib://<name>`）。协议注册与处理在桌面 main 的 customProtocols.ts */
export const SANDBOX_LIB_SCHEME = 'shuvix-lib'

/**
 * 沙箱里能加载的库：名字 → 随包文件。**名字是教给模型的契约**，版本不是 —— 升级只换文件
 * （apps/desktop/resources/sandbox-libs/README.md）。不在表里的名字一律 404。
 */
export const SANDBOX_LIBS: Readonly<Record<string, { file: string; global: string }>> = {
  'chart.js': { file: 'chart.umd.min.js', global: 'Chart' },
  'd3.js': { file: 'd3.min.js', global: 'd3' }
}

/** `<script src>` 里写的地址 */
export const sandboxLibUrl = (name: string): string => `${SANDBOX_LIB_SCHEME}://${name}`

/**
 * 注进沙箱 `:root` 的 token —— 与 ```svg 契约教的是同一套（visual-guide 片段），于是同一张图
 * 不论画在 svg 还是 interactive 里，取色写法一样。
 */
export const SANDBOX_THEME_TOKENS: readonly string[] = [
  '--theme-bg-primary',
  '--theme-bg-secondary',
  '--theme-bg-tertiary',
  '--theme-bg-hover',
  '--theme-bg-active',
  '--theme-text-primary',
  '--theme-text-secondary',
  '--theme-text-tertiary',
  '--theme-border-primary',
  '--theme-border-secondary',
  '--theme-accent',
  '--theme-accent-hover',
  '--theme-accent-muted',
  '--theme-font-sans',
  '--theme-font-serif',
  '--theme-font-mono',
  '--viz-1',
  '--viz-2',
  '--viz-3',
  '--viz-4',
  '--viz-5',
  '--viz-6',
  '--viz-7',
  '--viz-8',
  '--viz-seq-1',
  '--viz-seq-2',
  '--viz-seq-3',
  '--viz-seq-4',
  '--viz-seq-5',
  '--viz-mid',
  '--viz-good',
  '--viz-warn',
  '--viz-serious',
  '--viz-critical',
  '--viz-grid',
  '--viz-axis'
]

/**
 * 沙箱文档自己的 CSP。与宿主页面继承下来的那条取交集，所以这里只需要写「最多允许什么」。
 * 没有 'unsafe-eval'（宿主那条本来也没有）：d3.csvParse 这类靠 `new Function` 的 API 用不了，
 * 提示词因此教「数据写成 JS 数组」。
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${SANDBOX_LIB_SCHEME}:`,
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** 高度上报的范围（px）。上界之外在块内滚动，不撑长对话 */
export const SANDBOX_MIN_HEIGHT = 40
export const SANDBOX_MAX_HEIGHT = 720
/** sendPrompt 的长度上限 —— 它只是把一句话填进输入框，不是传数据的通道 */
export const SANDBOX_PROMPT_MAX = 2000

/** 桥消息的标记字段：只认带它的消息（页面里别的库也可能 postMessage） */
const BRIDGE_TAG = '__shuvix'

/**
 * 沙箱里的桥 —— 排在模型内容之前执行。只做三件事：
 *
 *  - **高度**：ResizeObserver 盯根元素，变了就报给宿主（宿主再限定范围）；
 *  - **`shuvix.color(name)`**：把 token 解析成具体颜色（`rgb(…)`）—— canvas 画不了 `var()`；
 *  - **`shuvix.sendPrompt(text)`**：把一句话交给宿主，宿主填进输入框，由用户决定发不发。
 *
 * 外加一件不用教的事：页面加载 Chart.js 时（UMD 会赋值 `window.Chart`），顺手把它的默认字色、
 * 网格色、字体对齐 token，宽栏里把缺省宽高比收到 3:1，并注册一个取色插件 —— 没有自己指定颜色的数据集按 --viz-1、--viz-2…
 * 的顺序取色（饼图类按扇区取）。于是「照着教程写一张 Chart.js 图」默认就是主题色板。
 *
 * 写成 ES5 且不含 `</script>`：它被原样拼进 srcdoc。
 */
const BRIDGE_SCRIPT = `(function () {
  'use strict';
  var TAG = '${BRIDGE_TAG}';
  var VIZ = ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-8'];
  function post(msg) {
    msg[TAG] = 1;
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }
  var probe = null;
  function color(name) {
    if (typeof name !== 'string' || !/^--[A-Za-z0-9-]+$/.test(name)) return '';
    if (!probe) {
      probe = document.createElement('span');
      probe.style.display = 'none';
      (document.body || document.documentElement).appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = 'var(' + name + ')';
    return getComputedStyle(probe).color;
  }
  var lastHeight = -1;
  function report() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h !== lastHeight) { lastHeight = h; post({ type: 'resize', height: h }); }
  }
  try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
  window.addEventListener('load', report);
  var themed = null;
  function themeChart(C) {
    if (!C || !C.defaults || C === themed) return;
    themed = C;
    try {
      var d = C.defaults;
      d.color = color('--theme-text-secondary');
      d.borderColor = color('--viz-grid');
      d.font.family = getComputedStyle(document.documentElement).fontFamily;
      // 缺省 2:1 在一条宽栏里是一张半屏高的图；宽栏收扁一点（饼图类有自己的 1:1，不受影响）
      if (document.documentElement.clientWidth > 900) d.aspectRatio = 3;
      if (d.plugins && d.plugins.colors) d.plugins.colors.enabled = false;
      C.register({
        id: 'shuvixPalette',
        beforeLayout: function (chart) {
          var cfg = chart.config;
          var sets = (cfg.data && cfg.data.datasets) || [];
          for (var i = 0; i < sets.length; i++) {
            var ds = sets[i];
            if (ds.backgroundColor || ds.borderColor) continue;
            var t = ds.type || cfg.type;
            if (t === 'pie' || t === 'doughnut' || t === 'polarArea') {
              ds.backgroundColor = (ds.data || []).map(function (_, j) { return color(VIZ[j % VIZ.length]); });
              ds.borderColor = color('--theme-bg-primary');
            } else {
              var c = color(VIZ[i % VIZ.length]);
              ds.borderColor = c;
              ds.backgroundColor = c;
            }
          }
        }
      });
    } catch (e) {}
  }
  var chartRef;
  try {
    Object.defineProperty(window, 'Chart', {
      configurable: true,
      enumerable: true,
      get: function () { return chartRef; },
      set: function (v) { chartRef = v; themeChart(v); }
    });
  } catch (e) {}
  window.shuvix = Object.freeze({
    color: color,
    sendPrompt: function (text) { post({ type: 'prompt', text: String(text) }); }
  });
})();`

/**
 * 沙箱的基础样式：透明底（卡片的底色透出来 —— 前提是 color-scheme 与宿主一致，否则 Chromium
 * 会给 iframe 垫一块不透明底），正文字色与字体取 token，控件给一套与应用同形的缺省外观，
 * 模型不写 CSS 也不会是一块 1998 年的表单。模型自己的样式排在后面，随时覆盖。
 *
 * `scrollbar-gutter: stable` 不是装饰：系统设成「总是显示滚动条」时，滚动条占宽度。块刚挂上时
 * iframe 还矮、内容溢出 → 出滚动条 → 页面变窄 → 按宽度定高的内容（Chart.js 的 responsive 图）
 * 跟着变矮 → 上报的高度变了 → 宿主改 iframe 高度 → 滚动条消失 → 页面变宽 → 又变高……来回振荡
 * 到 Chart.js 自己的节流碰巧停下为止（实测 401↔394px 振了 29 次、约 0.9s）。槽位常驻，宽度就
 * 永远不变，这个环一开始就不成立。浮层滚动条（不占宽度）下它什么也不占。
 */
const BASE_STYLE = `html,body{margin:0;padding:0;background:transparent}
html{font-family:var(--theme-font-sans);scrollbar-gutter:stable}
body{color:var(--theme-text-primary);font-size:13px;line-height:1.5;padding:12px 16px;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
button{font:inherit;color:inherit;background:var(--theme-bg-tertiary);border:1px solid var(--theme-border-primary);border-radius:6px;padding:3px 10px;cursor:pointer}
button:hover{background:var(--theme-bg-hover)}
input,select,textarea{font:inherit;color:inherit}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--theme-accent)}
:focus-visible{outline:2px solid var(--theme-accent);outline-offset:1px}
svg{max-width:100%;height:auto}`

/** token 名与值的形状 —— 值来自宿主的 getComputedStyle，但拼进 `<style>` 前仍按形状过一遍 */
const TOKEN_NAME_RE = /^--[A-Za-z0-9-]+$/
const TOKEN_VALUE_BAD_RE = /[<>{};\\]/
const COLOR_SCHEME_RE = /^(light|dark|normal|light dark|dark light)$/

export interface SandboxDocumentInput {
  /** 模型写的围栏体（原样放进 body） */
  body: string
  /** token 名 → 宿主上的取值（`light-dark(…)` 原串即可，沙箱里同样的 color-scheme 会解析它） */
  tokens: Readonly<Record<string, string>>
  /** 宿主根元素实际生效的 color-scheme */
  colorScheme: string
}

/**
 * 拼出 srcdoc。顺序就是安全前提：**meta CSP 第一个**，然后 token、基础样式、桥，最后才是模型内容。
 * 模型内容里再写 `<html>` / `<head>` / `<meta>` 都无妨：解析器在 body 里忽略重复的 html/head 开标签，
 * body 里的 meta CSP 也不生效 —— 只能更严的那条已经在前面了。
 */
export function buildSandboxDocument({ body, tokens, colorScheme }: SandboxDocumentInput): string {
  const decls: string[] = []
  const scheme = COLOR_SCHEME_RE.test(colorScheme.trim()) ? colorScheme.trim() : 'normal'
  decls.push(`color-scheme:${scheme}`)
  for (const [name, raw] of Object.entries(tokens)) {
    const value = raw.trim()
    if (!TOKEN_NAME_RE.test(name) || !value || TOKEN_VALUE_BAD_RE.test(value)) continue
    decls.push(`${name}:${value}`)
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    `<style>:root{${decls.join(';')}}\n${BASE_STYLE}</style>`,
    `<script>${BRIDGE_SCRIPT}</script>`,
    '</head><body>',
    body,
    '</body></html>'
  ].join('\n')
}

export type SandboxMessage = { type: 'resize'; height: number } | { type: 'prompt'; text: string }

/**
 * 沙箱发来的消息 → 合法的那两种之一，否则 null。来源（`event.source` 是不是这个 iframe）由调用方
 * 先查；这里只管形状。数据来自模型写的代码，按不可信处理：高度必须是有限非负数，文字非空且不超长
 * （超长直接丢弃而不是截断 —— 截出来的半句话填进输入框只会更让人困惑）。
 */
export function parseSandboxMessage(data: unknown): SandboxMessage | null {
  if (!data || typeof data !== 'object') return null
  const msg = data as Record<string, unknown>
  if (msg[BRIDGE_TAG] !== 1) return null
  if (msg.type === 'resize') {
    const h = msg.height
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) return null
    return { type: 'resize', height: h }
  }
  if (msg.type === 'prompt') {
    const text = msg.text
    if (typeof text !== 'string') return null
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > SANDBOX_PROMPT_MAX) return null
    return { type: 'prompt', text: trimmed }
  }
  return null
}

/** 上报的高度 → iframe 实际高度 */
export const clampSandboxHeight = (height: number): number =>
  Math.min(SANDBOX_MAX_HEIGHT, Math.max(SANDBOX_MIN_HEIGHT, Math.ceil(height)))

/**
 * 一个代码块在 markdown 源文本里的那一截（从开栅栏到节点末尾）是否已经闭合。
 *
 * remark 把没闭合的围栏也当成一个到文末为止的代码块，所以组件自己看不出「写完了没」。交互图
 * 不能像 svg 那样逐帧画 —— 半截脚本跑起来只会报错 —— 必须等围栏闭合。判定：最后一行是与开栅栏
 * 同字符、不短于它的栅栏行。容器前缀（引用块的 `>`、列表缩进）在最后一行里一并放过。
 */
export function fenceSourceIsClosed(slice: string): boolean {
  const lines = slice.replace(/\s+$/, '').split('\n')
  if (lines.length < 2) return false
  const open = /^[\s>]*(`{3,}|~{3,})/.exec(lines[0])
  if (!open) return false
  const fence = open[1]
  const close = /^[\s>]*(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1])
  return !!close && close[1][0] === fence[0] && close[1].length >= fence.length
}
