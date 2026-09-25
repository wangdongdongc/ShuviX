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
  '--viz-axis',
  // 分类框的浅底与同色深字、中性浅底（themes.css 从 --viz-N 派生）。宿主读到的是 var() 已代入
  // 的原串（`color-mix(… light-dark(…) …)`），在沙箱里按同一个 color-scheme 解析
  '--viz-1-tint',
  '--viz-2-tint',
  '--viz-3-tint',
  '--viz-4-tint',
  '--viz-5-tint',
  '--viz-6-tint',
  '--viz-7-tint',
  '--viz-8-tint',
  '--viz-1-ink',
  '--viz-2-ink',
  '--viz-3-ink',
  '--viz-4-ink',
  '--viz-5-ink',
  '--viz-6-ink',
  '--viz-7-ink',
  '--viz-8-ink',
  '--viz-wash'
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
 * 的顺序取色（饼图类按扇区取），只有一个系列时替它关掉图例。于是「照着教程写一张 Chart.js 图」默认就是主题色板。
 *
 * 再往下是**观感**的缺省值（柱的圆角与宽度上限、线宽、悬停才出现的点、分类轴不画网格、小方块图例、
 * 主题配色的提示框、500 字重的标题）—— drawing 技能的 references/style.md 教的是同一套，这里让
 * 「什么都没写」的图直接就长那样：规则写在技能里模型未必照做，缺省值不用它记得。
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
  var PIE = { pie: 1, doughnut: 1, polarArea: 1 };
  /** 沿路径写一个缺省值，缺的中间层就地补上（真 Chart.js 的 defaults 都是普通对象） */
  function put(root, path, value) {
    var keys = path.split('.');
    var o = root;
    for (var i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  /** rgb(r, g, b) → rgba(r, g, b, a)：面积图的底色要同色的一层淡洗，不是一整块实色 */
  function alpha(c, a) {
    var m = /^rgba?\\(([^,]+),([^,]+),([^,)]+)/.exec(c || '');
    return m ? 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ', ' + a + ')' : c;
  }
  /**
   * 这条线画不画面积：数据集自己的 fill，没写就看全图的 elements.line.fill；雷达图缺省就填。
   * fill: 0（填到第 0 个数据集）是假值却是填充，所以不能只看真假。
   */
  function filled(ds, t, cfg) {
    var f = ds.fill;
    if (f === undefined) {
      var o = cfg.options;
      f = o && o.elements && o.elements.line ? o.elements.line.fill : undefined;
    }
    if (f === undefined) return t === 'radar';
    return f === 0 || !!f;
  }
  function themeChart(C) {
    if (!C || !C.defaults || C === themed) return;
    themed = C;
    try {
      var d = C.defaults;
      d.color = color('--theme-text-secondary');
      d.borderColor = color('--viz-grid');
      d.font.family = getComputedStyle(document.documentElement).fontFamily;
      // 缺省 2:1 在一条宽栏里是一张半屏高的图；越宽收得越扁（饼图类有自己的 1:1，不受影响）
      var cw = document.documentElement.clientWidth;
      if (cw > 900) d.aspectRatio = 3;
      else if (cw > 560) d.aspectRatio = 2.5;
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
            if (PIE[t]) {
              ds.backgroundColor = (ds.data || []).map(function (_, j) { return color(VIZ[j % VIZ.length]); });
            } else {
              var c = color(VIZ[i % VIZ.length]);
              ds.borderColor = c;
              ds.backgroundColor = (t === 'line' || t === 'radar') && filled(ds, t, cfg) ? alpha(c, 0.1) : c;
            }
          }
        }
      });
    } catch (e) {}
    // 观感的缺省值（与 drawing 技能的 references/style.md 同一套）。单独一个 try：哪一项在某个版本里
    // 不存在，也不该连累上面的取色。模型自己写的配置照样盖过这些 —— 这里只换「什么都不写」时的样子。
    try {
      var d2 = C.defaults;
      var ink = color('--theme-text-primary');
      // 柱：数据端 4 的圆角、基线端方角（borderSkipped 的缺省），最宽 24 —— 柱子不塞满格子，剩下的是留白
      put(d2, 'elements.bar.borderRadius', 4);
      put(d2, 'datasets.bar.maxBarThickness', 24);
      // 柱宽被上限卡住后，同组的几根柱会在各自的槽里居中、彼此隔得很开 —— 槽收窄一点让它们挨近
      put(d2, 'datasets.bar.categoryPercentage', 0.6);
      // 线：2 宽、圆头圆角；点只在悬停时出现（每个点一个圆会把线变成串珠）
      put(d2, 'elements.line.borderWidth', 2);
      put(d2, 'elements.line.borderCapStyle', 'round');
      put(d2, 'elements.line.borderJoinStyle', 'round');
      put(d2, 'datasets.line.pointRadius', 0);
      put(d2, 'datasets.line.pointHoverRadius', 4);
      put(d2, 'datasets.line.pointHitRadius', 8);
      // 折线图悬停读同一个 x 上的所有系列，不必正好指着那个点（只放在 line 上：饼图、散点仍按命中）
      if (C.overrides) put(C.overrides, 'line.interaction', { mode: 'index', intersect: false });
      // 环 / 饼：不描边（猜不到卡片底色），扇区之间留 2 的缝；环的孔大一点，读起来轻
      put(d2, 'elements.arc.borderWidth', 0);
      put(d2, 'datasets.doughnut.spacing', 2);
      put(d2, 'datasets.doughnut.cutout', '62%');
      put(d2, 'datasets.pie.spacing', 2);
      // 坐标：分类轴不画网格（竖网格只是噪声），轴线用 --viz-axis，不画刻度短线
      put(d2, 'scales.category.grid.display', false);
      put(d2, 'scale.border.color', color('--viz-axis'));
      put(d2, 'scale.grid.drawTicks', false);
      put(d2, 'scale.ticks.padding', 8);
      // 图例：8×8 的小圆角方块，顶部靠左。只有一个系列时不画（标题已经说了画的是什么）—— 写成
      // 可脚本化的缺省值而不是改作者的配置：每次渲染现算（后来加了第二个系列，图例就回来），
      // 作者自己写的 display 天然排在缺省值前面；饼图类的图例列的是扇区，照画
      put(d2, 'plugins.legend.display', function (ctx) {
        var c = ctx && ctx.chart;
        if (!c) return true;
        var cfg = c.config || {};
        return !!PIE[cfg.type] || ((c.data && c.data.datasets) || []).length > 1;
      });
      put(d2, 'plugins.legend.align', 'start');
      put(d2, 'plugins.legend.labels.boxWidth', 8);
      put(d2, 'plugins.legend.labels.boxHeight', 8);
      put(d2, 'plugins.legend.labels.useBorderRadius', true);
      put(d2, 'plugins.legend.labels.borderRadius', 2);
      put(d2, 'plugins.legend.labels.padding', 16);
      // 提示框：主题的浮层配色，不是 Chart.js 的黑底
      put(d2, 'plugins.tooltip.backgroundColor', color('--theme-bg-tertiary'));
      put(d2, 'plugins.tooltip.borderColor', color('--theme-border-primary'));
      put(d2, 'plugins.tooltip.borderWidth', 1);
      put(d2, 'plugins.tooltip.titleColor', ink);
      put(d2, 'plugins.tooltip.bodyColor', color('--theme-text-secondary'));
      put(d2, 'plugins.tooltip.padding', 8);
      put(d2, 'plugins.tooltip.cornerRadius', 6);
      put(d2, 'plugins.tooltip.boxWidth', 8);
      put(d2, 'plugins.tooltip.boxHeight', 8);
      put(d2, 'plugins.tooltip.boxPadding', 4);
      // titleFont 在真 Chart.js 里是一条路由属性（→ 全局 font）：getter 每次交回合并后的新对象，
      // 逐段写 weight 会写在副本上丢掉 —— 只能整体赋值，setter 存下、getter 再与 font 合并
      put(d2, 'plugins.tooltip.titleFont', { weight: '500' });
      // 两种字重：标题 500，不是 Chart.js 缺省的 bold
      put(d2, 'plugins.title.color', ink);
      put(d2, 'plugins.title.align', 'start');
      put(d2, 'plugins.title.font.weight', '500');
      put(d2, 'plugins.title.font.size', 13);
      // 动画短一点；系统要求减少动效时整个关掉
      var reduce = false;
      try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
      if (reduce) d2.animation = false;
      else put(d2, 'animation.duration', 400);
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
 * 只给**裸标签**上样式，不发明 class：技能教「直接写裸标签」，覆盖面最大，也没有一套要记的类名。
 * 其中两条是替模型守规矩的：`strong` / `b` / `th` / 标题一律 500（只用两种字重），
 * `button[aria-pressed=true]` 是分段切换的选中态（选中与否写在语义属性上，不必另写样式）。
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
h1,h2,h3,h4,h5,h6,strong,b,th{font-weight:500}
h1,h2,h3,h4{margin:0 0 8px;line-height:1.3}
h1{font-size:18px}h2{font-size:16px}h3,h4{font-size:14px}
p{margin:0 0 8px}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--theme-border-primary);border-radius:6px;padding:4px 12px;line-height:1.4;cursor:pointer}
button:hover{background:var(--theme-bg-hover)}
button:active{transform:scale(.98)}
button[aria-pressed=true]{background:var(--theme-accent-muted);border-color:var(--theme-accent)}
button:disabled{opacity:.5;cursor:default;transform:none}
input,select,textarea{font:inherit;color:var(--theme-text-primary)}
input:not([type]),input[type=text],input[type=number],input[type=search],select{height:28px;padding:0 8px;border:1px solid var(--theme-border-primary);border-radius:6px;background:transparent}
input[type=number]{width:88px}
textarea{padding:6px 8px;border:1px solid var(--theme-border-primary);border-radius:6px;background:transparent}
input:not([type]):focus-visible,input[type=text]:focus-visible,input[type=number]:focus-visible,input[type=search]:focus-visible,select:focus-visible,textarea:focus-visible{outline:none;border-color:var(--theme-accent);box-shadow:0 0 0 2px var(--theme-accent-muted)}
input[type=checkbox],input[type=radio]{accent-color:var(--theme-accent)}
input[type=range]{-webkit-appearance:none;appearance:none;width:160px;height:18px;margin:0;background:transparent;vertical-align:middle;cursor:pointer}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--theme-border-primary)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--theme-accent)}
input[type=range]:hover::-webkit-slider-thumb{box-shadow:0 0 0 4px var(--theme-accent-muted)}
label{display:inline-flex;align-items:center;gap:8px;color:var(--theme-text-secondary)}
output{color:var(--theme-text-primary);font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:12px}
th{text-align:left;color:var(--theme-text-secondary)}
th,td{padding:6px 8px;border-bottom:1px solid var(--theme-border-secondary)}
tr:last-child td{border-bottom:0}
canvas{display:block;max-width:100%}
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
