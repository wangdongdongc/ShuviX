# 交互块

```interactive 块是回复里的一个小活页面 —— **只在你的系统提示讲了它的时候才能用**；没讲的话，你的回复显示在跑不了它的地方。这一页先是它的契约 —— 违反其中一条，块就跑不起来或者跑错 —— 然后是手艺：什么时候值得用一块、怎么排、怎么接线，才能让它保持小巧、改得动。

## 契约

- **一段自包含的 body 片段。** 先写一个 `<title>` 给它起名，然后是标记，最后是 `<script>`。围栏闭合后它才出现，所以一口气写完 —— 写在回复里，不另写成文件。
- **没有网络，没有存储。** 什么都取不到，`localStorage` 会抛异常；数据直接写成脚本里的 JS 数组（没有 `eval`，所以 `d3.csvParse` 用不了）。
- **库**只能这样加载：`<script src="shuvix-lib://chart.js"></script>`（Chart.js 4）或 `shuvix-lib://d3.js`（D3 7），放在用它的脚本前面。Chart.js 已经跟随主题：没指定颜色的数据集按 `--viz-1`、`--viz-2`… 的顺序取色，柱、线、图例和提示框的样式也都已经设好。
- **颜色取自与图相同的 token** —— CSS 或 SVG 属性里写 `var(--viz-1)`；canvas 上用 `shuvix.color('--viz-1')` 取解析后的颜色。系列 `--viz-1` … `--viz-8`，按此顺序 · 量级 `--viz-seq-1` … `--viz-seq-5` · 状态 `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical` · 网格线 `--viz-grid` · 坐标轴 `--viz-axis` · 文字 `--theme-text-primary` / `--theme-text-secondary` / `--theme-text-tertiary` · 分类浅底 `--viz-N-tint` 配它的文字色 `--viz-N-ink` · 高一级的浅底 `--viz-wash`。
- **控件已经有样式。** 直接写裸的 `<button>`、`<input type="range">`、`<select>`、`<table>` —— 主题字体、文字色和控件外观都已套好，按钮上写 `aria-pressed="true"` 就显示为选中。你只管排版，不管外观。
- **高度随内容**（最高 720px）；绝不写 `height: 100%` 或 `100vh`。
- **`shuvix.sendPrompt(text)`** 把一句话填进用户的输入框 —— 用于「解释这一步」这类按钮；发不发由用户决定。
- **用按钮和 input 事件，不用 `<form>` 提交，也不用 `alert()` / `confirm()`** —— 这两样在沙箱里都被拦了，块里的链接也点不开。
- **预算：** 一个问题，最多三个控件，一屏以内。

## 它需要动吗？

先问用户会拿控件**做**什么。如果老实的回答是「什么也不做，就看看」，那就画一张 ```svg 图：它边写边出现，不用脚本，也不会在运行时坏掉。

一块交互值得存在，是因为答案属于下面几种之一：

- **探索一个参数** —— 拖动利率、尺寸、阈值，看结果跟着动。用户学到的是一段关系的**形状**，而不是其中一个点。
- **逐步走一个过程** —— 用「下一步 / 上一步」走过一个算法、一条流水线、一个协议的各个状态。每个状态都很小，顺序本身就是要讲的东西。
- **读精确的值** —— 图密到要悬停才读得出某个点，或者要切换才能单独看某个系列。
- **计算** —— 一个小计算器，输入一个数就是重点。

## 形状：一个问题，一组控件，一个视图

- **控件在上方排成一行**，每个都在旁边写上标签**和当前值**（`利率 4.5%`）。不印出当前值的滑块就是在让人猜。
- **下方一个视图** —— 一张图、一段 SVG、一张表。想放两个视图，说明你有两个问题；挑一个，或者问用户要哪个。
- **一个读数**，写用户真正关心的那个数，用正文色、字号大一点，并加 `aria-live="polite"`，变化时会被读出来。
- 最多三个控件。出现第四个，通常说明这一块在回答两个问题。

这些零件 —— 控件行、读数、主数字、指标卡、图例条、分段切换、分步器、表格 —— 都在 `references/style.md` 里，连同它们遵守的字号表和数字格式。

## 接线：state → render

只留一个 `state` 对象和一个 `render()`，由它从 state 重画一切。每个控件都只是写 `state`、再调 `render()`；脚本最后调一次 `render()`。块都很小，整块重画很便宜 —— 而且这样写的块以后改起来只要对 state 或 render 做一次 `edit`，不用去理一团事件处理器。

- **Chart.js：** 图只建一次，`render()` 里替换 `chart.data` 的值再调 `chart.update('none')`（拖动时不做动画）。绝不要每次输入都新建一个 `Chart` —— 旧的那个还占着 canvas 和监听器。用一个定高的 `<div>` 包住它、写 `maintainAspectRatio: false` 来定尺寸；刻度和提示框的数字按与正文相同的规则取整；颜色、图例、柱和线的样式交给宿主。
- **D3：** 画进一个 `<svg viewBox="…">`，让它跟着栏宽缩放。颜色用属性从 token 取 —— `.attr('fill', 'var(--viz-1)')`，坐标轴文字 `var(--theme-text-secondary)`，轴线 `var(--viz-axis)`，网格线 `var(--viz-grid)`。色板规矩与静态图相同：系列按槽位顺序，没有第九种颜色，直接标注。
- **不要无尽循环。** 一个永不停止的 `requestAnimationFrame` 或 `setInterval`，只要这条回复还在屏幕上就一直烧用户的 CPU。只在响应输入时做动画，或者给一个初始为暂停的「播放 / 暂停」按钮。

## 往回说话

`shuvix.sendPrompt(text)` 把一句话填进用户的输入框。用它做一个把当前状态变成问题的按钮 —— 并且把状态写进这句话里，因为读它的模型看不见这一块：

```js
shuvix.sendPrompt(`为什么利率 ${state.rate}% 时，余额在第 ${state.years} 年之后涨得更快？`)
```

最多一个这样的按钮，按钮上写清它会问什么。

## 成品的样子

```interactive
<title>复利增长</title>
<div class="controls">
  <label>利率 <input id="rate" type="range" min="0" max="12" step="0.5" value="5"> <output id="rate-out"></output></label>
  <label>年数 <input id="years" type="range" min="1" max="40" value="20"> <output id="years-out"></output></label>
</div>
<p class="hero" aria-live="polite"><span id="total"></span> 由 1,000 经过 <span id="span"></span> 年</p>
<div class="chart"><canvas id="chart" role="img" aria-label="逐年余额"></canvas></div>
<button id="ask">问问为什么</button>
<style>
  .controls { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 8px; }
  .hero { color: var(--theme-text-secondary); margin: 0 0 12px; }
  .hero #total { color: var(--theme-text-primary); font-size: 28px; font-weight: 500; font-variant-numeric: tabular-nums; margin-right: 6px; }
  .chart { position: relative; height: 220px; margin-bottom: 12px; }
</style>
<script src="shuvix-lib://chart.js"></script>
<script>
  const state = { rate: 5, years: 20 }
  const chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: '余额', data: [], fill: true }] },
    options: {
      maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: (c) => '余额 ' + c.parsed.y.toLocaleString() } } }
    }
  })
  function render() {
    const values = []
    for (let y = 0; y <= state.years; y++) values.push(Math.round(1000 * (1 + state.rate / 100) ** y))
    chart.data.labels = values.map((_, y) => y)
    chart.data.datasets[0].data = values
    chart.update('none')
    document.getElementById('rate-out').textContent = `${state.rate}%`
    document.getElementById('years-out').textContent = state.years
    document.getElementById('span').textContent = state.years
    document.getElementById('total').textContent = values[values.length - 1].toLocaleString()
  }
  for (const id of ['rate', 'years']) {
    document.getElementById(id).addEventListener('input', (e) => {
      state[id] = Number(e.target.value)
      render()
    })
  }
  document.getElementById('ask').addEventListener('click', () => {
    shuvix.sendPrompt(`为什么利率 ${state.rate}% 时，1,000 在后面几年比前面几年涨得快？`)
  })
  render()
</script>
```

## 画成这样就是错的

- **块里放的是静态内容。** 一张没有控件、也没人需要悬停的图，就是绕远路写的 ```svg 图。
- **数据靠抓取，或者从 CSV 解析。** 没有网络也没有 `eval`，`d3.csvParse` 会抛异常。把数据直接写成 JS 数组。
- **带 submit 处理器的 `<form>`。** 提交在处理器运行之前就被拦了，所以回车什么都不做。用按钮的 `click` 和输入框的 `input` 事件。
- **`alert()`、`confirm()`、`prompt()`。** 被拦了。把提示信息显示在块里。
- **十六进制颜色，或者库自带的默认色板。** 大多数主题下会坏。Chart.js 的数据集别指定颜色（它们会按顺序取色板），或者用 `shuvix.color('--viz-N')`；CSS 和 SVG 里用 `var(--viz-N)`。
- **`height: 100%` 或 `100vh`。** 块的高度跟着内容走；绑在视口上的高度永远缩不回来。
- **一条回复里好几块。** 每一块都是一个要单独加载的页面。一块，周围配文字。
- **还把页面另写成一个文件。** 块就长在回复里；工作区里再放一份，就多了一样会走样的东西。用户要文件时才写。
- **重新设计宿主已经设好的样式** —— 按钮 CSS、数据集颜色、单系列又把图例打开、粗边框和大圆点。这些缺省值就是应用的样子；覆盖掉它们，块就和应用对不上了。
- **按宽高比定尺寸的图。** 宽栏里它会变成半屏高，饼图会撑满整栏宽。给 canvas 包一个定高的 `<div>`，并写 `maintainAspectRatio: false`。
- **屏幕上出现没取整的数** —— `0.30000000000000004`、`2653.2977051`。每个显示出来的值都要取整。
- **要改就整块重写。** 用户要改时，用 `artifact` 认领（adopt）这一块、再 `edit` 那个 `.html` 文件；重写一遍，没人要改的地方也会跟着走样。
