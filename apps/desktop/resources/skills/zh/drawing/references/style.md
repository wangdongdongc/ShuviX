# 观感

一张画完的图长什么样。这份技能的其余部分让图**画对**：图型选对、颜色有含义、标记不说谎。这一页让它**看起来画完了**：字、颜色的实际用法、线、留白、数字，以及交互块由哪些小零件拼成。其中大部分是克制。

## 画完的样子

- **它是回复的一部分。** 图坐在对话里，用的是应用自己的字体和颜色。它应该看起来像应用画的，而不是从别处贴进来的一张截图。
- **扁平、安静。** 纯色平涂、细线、宽松的留白。不要渐变、阴影、模糊、发光；图后面不垫背景矩形 —— 卡片本身就是底。
- **只有一样东西是显眼的。** 数据，或者这张图讲的那一个框。其余的 —— 骨架、标注、中性的框 —— 都往后退。
- **文字写在回复里。** 图里不放标题、段落或解释。标题是根节点的 `aria-label` 和图前面那句话；一块交互里只有它的控件、它的视图，以及最多一行读数。
- **基础样式宿主已经做好了。** 交互块里，字体、文字色、按钮、滑块、下拉框、表格和 Chart.js 都已经有样式。直接写裸标签，别去动它们；重新设计它们，正是块和应用渐渐对不上的原因。

## 字

**两种字重：400 和 500。** 框标题、读数、指标值用 500，其余一律 400。绝不用 600、700 或 `bold` —— 放在应用的文字旁边会显得笨重。

**字号只取自一张短表。** 在图里（`viewBox` 单位，在聊天栏里约等于像素）：

| 文字 | 字号 | 字重 | 颜色 |
|---|---|---|---|
| 框标题 | 13 | 500 | `--theme-text-primary`，或那个框的 `--viz-N-ink` |
| 框副标题、说明、直接标注 | 11 | 400 | `--theme-text-secondary`，或那个框的 ink |
| 标记旁的数值 | 11 | 400 | `--theme-text-secondary` |
| 坐标刻度 | 11 | 400 | `--theme-text-tertiary` |

在交互块里（CSS 像素）：正文和控件标签 13，说明和图例 12，读数 16、字重 500，指标值 20、字重 500，唯一的主数字 28、字重 500。一律不小于 11，坐标刻度也一样。

**大小写。** 英文只有句首大写："Monthly revenue"，不写 "Monthly Revenue"，更不写 "MONTHLY REVENUE"。标注里不加粗，标注末尾不加句号。

**数字。** 成列的数字，以及拖动时会变化的数字，写 `font-variant-numeric: tabular-nums`，免得跳动。单个静止的大数字不用 —— 等宽数字会显得松。

**中日韩文字。** 按每字 1em 估宽；绝不加字距。中英混排的标注保持主题字体 —— 不要为哪一种文字单独换字族。

**不要 emoji、图标字符、装饰性编号**（大号的「①」「第 1 步：」）。图靠形状、位置和几个字说话。

## 颜色的实际用法

颜色的四种职责和色板在 `SKILL.md` 里 —— 身份、量级、极性、状态。这里讲的是它们怎么落到框和块上。

**缺省是中性。** 一个不代表某个种类的框，就是 `fill="var(--viz-wash)"` 加 `stroke="var(--theme-border-primary)"`，文字用 `--theme-text-primary`。大多数图里的大多数框都是中性的。

**种类用浅底，不用实色。** 框按种类分组时（我们的与第三方、客户端与服务端、输入与输出），一种就是一个槽位 N，画成：

- 铺底 `var(--viz-N-tint)` —— 这个色相的一层淡洗；
- 描边 `var(--viz-N)`，线宽 1；
- 文字 `var(--viz-N-ink)` —— 同一个色相，深到能在它的浅底上读清（标题和副标题都用它，靠字重和字号区分）。

```svg
<rect x="20" y="20" width="140" height="52" rx="6" fill="var(--viz-1-tint)" stroke="var(--viz-1)"/>
<g font-family="var(--theme-font-sans)" text-anchor="middle" fill="var(--viz-1-ink)">
  <text x="90" y="37" dominant-baseline="central" font-size="13" font-weight="500">订单服务</text>
  <text x="90" y="55" dominant-baseline="central" font-size="11">Postgres</text>
</g>
```

槽位按顺序取 —— 第一种是 1，第二种是 2 —— 最多三种。结构性的框（起点、终点、用户、一个普通步骤）保持中性。颜色跟着种类走：同一种的两个框永远共用一个槽位。

**浅底上的字用它的 ink。** 浅底上绝不写 `--theme-text-secondary`（彩色上的灰字显脏），绝不写槽位色本身（作为文字太浅），绝不用 `opacity` 调淡文字（它在每种底色上合成出来都不一样）。

**一张图只有一处强调。** 这张图讲的那个框得到强调 —— 一排中性框里的一块浅底，或者一条 1.5 的描边 —— 其余的都不和它抢。

**状态是一个词加一个颜色。** 风险或失败是一个中性框，加 `--viz-warn` 或 `--viz-critical` 的 1.5 描边，**再加**一个说明它的标注。状态从不单靠颜色承载。

**在块里：** CSS 和内联 SVG 直接写 `var(--viz-1)`、`var(--viz-1-tint)`、`var(--viz-wash)`；canvas 上用 `shuvix.color('--viz-1')` 取解析后的颜色。

## 线、圆角、底色

| 元素 | 描边 |
|---|---|
| 中性框的边框 | 1，`--theme-border-primary` |
| 种类框的边框 | 1，`--viz-N` |
| 连线 / 箭头 | 1，`--theme-text-tertiary` |
| 网格线 | 1，`--viz-grid` |
| 坐标轴、基线 | 1，`--viz-axis` |
| 唯一的强调 | 1.5 |

除非线宽本身就是数据（一股流的宽度、一条线的粗细代表它的权重），不要比 1.5 更粗。

**圆角：** 框 `rx="6"`，柱 `rx="4"`，外层区域 `rx="10"`。圆角半径等于高度的一半就成了胶囊 —— 只在你确实要胶囊时这样写。

**底色：** 卡片就是底，所以根节点永远不铺底色。图或块里高一级的区域 —— 指标卡、图例条、表头 —— 用 `--viz-wash`。底色最多两层。

## 留白与对齐

- **按 4 的节奏** —— 4、8、12、16、24。零件内部的间距 4–8，零件之间 12–16，新的一段之前 24。
- **四边都有边距。** 示意图的 `viewBox` 左右各 20，图表的绘图区四周 12–16，再加一个与最长行标签同宽的左侧栏。
- **同类的东西一样大。** 所有单行的框同一个高度（36），所有两行的框同一个高度（52）；一行里每两个框之间的间距都一样。
- **对齐到网格。** 行标签右对齐到同一条栏线，数值左对齐在柱端之后，框的中心落在同一条基线上。
- **用留白分隔，不用边框。** 两样东西需要分开时，先把它们挪开，再考虑在中间画线。

## 文字与数字

- **标注是短语** —— 英文约 5 个词，中文约 10 个字。第二行只在它承载一个事实时才加。
- **单位只写一次。** 单位写在轴名或第一个值上（「营收，百万元」，然后是「12、19、14」），不要每个刻度都写。
- **显示出来的一切都要取整。** 计数取整数；百分比保留一位小数，除非差异比这更小；同一张图精度一致。在块里，每个上屏的数字都要过一遍 `Math.round`、`toFixed` 或 `toLocaleString()` —— `0.1 + 0.2` 会打印出 `0.30000000000000004`。
- **千分位分隔**，超过 9,999 的都要（`toLocaleString()` 会做）；位置紧时写 `1.2M` / `34K`。
- **正负号：** 写 `-$5M`，不写 `$-5M`；符号本身就是重点时写 `+4.2%`。
- **日期**写短：「3 月 3 日」「2026-03」「Q2」。除非时刻要紧，不写几点几分。
- **标注用用户的语言。** 中文里整张图选定一个数量级单位（万或亿）。

## 交互块 —— 零件

这些只在你的系统提示讲了 ```interactive 交互块的时候才适用。每段片段都放进块的 body 里；裸标签已经有样式，所以这里的 CSS 只管排版。

**控件行** —— 每个控件旁边都写着它的当前值：

```html
<div class="controls">
  <label>利率 <input id="rate" type="range" min="0" max="12" step="0.5" value="5"> <output id="rate-out">5%</output></label>
  <label>方案 <select id="plan"><option>基础版</option><option>专业版</option></select></label>
</div>
<style>.controls { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 12px; }</style>
```

**读数** —— 用户要的那个数，控件下面一行：

```html
<p class="readout" aria-live="polite">20 年后，1,000 变成 <strong id="total">2,653</strong></p>
<style>
  .readout { color: var(--theme-text-secondary); margin: 0 0 12px; }
  .readout strong { color: var(--theme-text-primary); font-size: 16px; font-variant-numeric: tabular-nums; }
</style>
```

**主数字** —— 当一个数**就是**答案时，把它写大，旁边说明它是什么：

```html
<div class="hero"><span id="hero">2,653</span> 20 年后</div>
<style>
  .hero { color: var(--theme-text-secondary); margin: 4px 0 12px; }
  .hero span { color: var(--theme-text-primary); font-size: 28px; font-weight: 500; font-variant-numeric: tabular-nums; margin-right: 6px; }
</style>
```

**指标卡** —— 两到四个头条数字并排：

```html
<div class="stats">
  <div><span>营收</span><strong>¥1.2M</strong></div>
  <div><span>订单</span><strong>8,410</strong></div>
  <div><span>退款率</span><strong>2.1%</strong></div>
</div>
<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .stats div { background: var(--viz-wash); border-radius: 8px; padding: 10px 12px; }
  .stats span { display: block; font-size: 12px; color: var(--theme-text-secondary); }
  .stats strong { font-size: 20px; }
</style>
```

**图例条** —— 给 D3 或内联 SVG 用，也给需要在图例里带数值的饼图用。（Chart.js 在有两个及以上系列时已经画了一个小图例，只有一个系列时不画。）

```html
<div class="legend"><span><i style="background: var(--viz-1)"></i>搜索 48%</span><span><i style="background: var(--viz-2)"></i>直接访问 27%</span></div>
<style>
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--theme-text-secondary); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 8px; height: 8px; border-radius: 2px; }
</style>
```

**分段切换** —— 两到四个选项，选中一个。`aria-pressed="true"` 就是选中的样子；你只需翻转这个属性：

```html
<div class="seg" role="group" aria-label="周期"><button aria-pressed="true" data-v="month">按月</button><button aria-pressed="false" data-v="year">按年</button></div>
<style>.seg { display: inline-flex; gap: 4px; }</style>
<script>
  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-pressed', String(x === b))
      state.period = b.dataset.v
      render()
    })
  }
</script>
```

**分步器** —— 用「上一步 / 下一步」走过一个过程的各个状态，并把位置写出来：

```html
<div class="steps"><button id="back">上一步</button><span id="pos" aria-live="polite">第 1 步，共 4 步</span><button id="next">下一步</button></div>
<style>.steps { display: flex; align-items: center; gap: 12px; margin-top: 12px; color: var(--theme-text-secondary); }</style>
```

**表格** —— 裸 `<table>` 已有样式；数字列右对齐：

```html
<table>
  <tr><th>区域</th><th>订单</th><th>占比</th></tr>
  <tr><td>华北</td><td>3,120</td><td>37.1%</td></tr>
</table>
<style>td + td, th + th { text-align: right; font-variant-numeric: tabular-nums; }</style>
```

## 块里的图表

**宿主已经做了的 —— 别再写一遍：** 系列按槽位顺序取色，柱子圆头、最宽 24，线宽 2、点只在悬停时出现，折线图悬停时读同一个 x 上的所有系列，分类轴不画网格线，小方块图例（只有一个系列时不画），主题配色的提示框，主题字体，500 字重的标题，简短的动画（系统要求减少动效时关掉）。

**要你来做的：**

- **用一个包裹层定尺寸**，不是给 canvas 定：`<div style="position: relative; height: 220px"><canvas id="chart" role="img" aria-label="…"></canvas></div>`，并写 `maintainAspectRatio: false`。饼图、环图 200–240 高；横向柱状图 `条数 × 32 + 48`。
- **刻度和提示框的数字格式**与正文一致：`scales.y.ticks.callback: (v) => v.toLocaleString()`，`plugins.tooltip.callbacks.label: (c) => c.dataset.label + ': ' + c.parsed.y.toFixed(1) + '%'`。
- **强调**是给数据集指定颜色的唯一理由：要紧的那条系列保留它的槽位色，其余用 `shuvix.color('--theme-text-tertiary')`。
- **别动的：** 除此之外的数据集颜色、图例、边框线宽、点半径、字体。

## 动效

只在响应输入时发生，只动 `opacity` 和 `transform`，200ms 以内。你加的任何 CSS 过渡都包进 `@media (prefers-reduced-motion: no-preference) { … }`。没有东西自己动；一段用户没开启的动画，就是一个永不停止的循环。

## 观感检查

发出去之前，拿这张清单过一遍：

- 字重只有 400 和 500；英文没有每词大写、没有全大写，标注里没有加粗。
- 每个字号都在表里；没有小于 11 的。
- 最多三个色相，每个代表一种东西；浅底上的字用它的 ink；结构保持中性。
- 线宽是 1，唯一的强调是 1.5；没有渐变、阴影或背景铺色。
- 每个数字都取整、带格式；每个单位只出现一次。
- 四边都有边距；同类的东西一样大；边缘对齐。
- 没有 emoji，图里没有标题或段落。
- 在块里：控件都显示当前值，只有一个视图，宿主的样式没被改动。
