# Interactive blocks

An ```interactive block is a small live page in the reply — **only where your system prompt describes it**; otherwise your replies are shown somewhere that cannot run one. This page is its contract — break one of those rules and the block does not run, or runs wrong — and then the craft: when a block earns its place, how to lay it out, and how to wire it so it stays small and editable.

## The contract

- **A self-contained body fragment.** Start with a `<title>` naming it, then the markup, then `<script>`. It appears only once the fence is closed, so write it in one go — in the reply, not as a file.
- **No network, no storage.** Nothing can be fetched and `localStorage` throws; put the data in the script as JS arrays (there is no `eval`, so `d3.csvParse` is unavailable).
- **Libraries** load only as `<script src="shuvix-lib://chart.js"></script>` (Chart.js 4) or `shuvix-lib://d3.js` (D3 7), placed before the script that uses them. Chart.js already follows the theme: datasets without colors take `--viz-1`, `--viz-2`… in order, and its bars, lines, legend and tooltip are already styled.
- **Colors from the same tokens as a figure** — `var(--viz-1)` in CSS or SVG attributes; on a canvas, `shuvix.color('--viz-1')` returns the resolved color. Series `--viz-1` … `--viz-8` in that order · magnitude `--viz-seq-1` … `--viz-seq-5` · state `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical` · gridlines `--viz-grid` · axes `--viz-axis` · text `--theme-text-primary` / `--theme-text-secondary` / `--theme-text-tertiary` · category tint `--viz-N-tint` with its text `--viz-N-ink` · a raised surface `--viz-wash`.
- **Controls are already styled.** Write bare `<button>`, `<input type="range">`, `<select>`, `<table>` — the theme font, text color and control look are applied, and `aria-pressed="true"` on a button shows it selected. Add layout, not looks.
- **Its height follows its content** (up to 720px); never set `height: 100%` or `100vh`.
- **`shuvix.sendPrompt(text)`** puts a sentence into the user's input box — for a button like "Explain this step"; the user decides whether to send it.
- **Buttons and input events, not `<form>` submission or `alert()` / `confirm()`** — both are blocked in the sandbox, and links inside the block do not open.
- **Budget:** one question, at most three controls, one screen.

## Does it need to move?

Ask what the user will **do** with a control. If the honest answer is "nothing, they will just look", draw a ```svg figure instead: it streams in as you write it, it costs no script, and it cannot break at runtime.

A block earns its place when the answer is one of these:

- **Explore a parameter** — drag a rate, a size, a threshold and watch the result move. The user learns the *shape* of a relationship, not one point on it.
- **Step through a process** — Next / Back over the states of an algorithm, a pipeline, a protocol. Each state is small; the sequence is the lesson.
- **Read exact values** — a chart dense enough that the user needs hover to read a point, or a toggle to isolate one series.
- **Compute** — a tiny calculator where typing a number is the point.

## Shape: one question, one control group, one view

- **Controls on top, in one row**, each with its label *and its current value* next to it (`Rate 4.5%`). A slider without its value printed is a guessing game.
- **One view below** — a chart, an SVG, a table. If you want two views, you have two questions; pick one, or ask which.
- **A readout** for the number the user is actually after, in the text color at a larger size, with `aria-live="polite"` so it is announced when it changes.
- At most three controls. A fourth usually means the block is answering two questions.

The pieces — control row, readout, hero number, stat tiles, legend strip, segmented choice, stepper, table — are in `references/style.md`, with the type scale and number formats they follow.

## Wiring: state → render

Keep one `state` object and one `render()` that redraws everything from it. Every control writes into `state` and calls `render()`; the script ends by calling `render()` once. Blocks are small, so redrawing everything is cheap — and a block written this way can be changed later with one `edit` to the state or the render, without untangling event handlers.

- **Chart.js:** create the chart once, then in `render()` replace `chart.data` values and call `chart.update('none')` (no animation while dragging). Never create a new `Chart` on every input — the old one keeps its canvas and listeners. Size it with a wrapper `<div>` of fixed height and `maintainAspectRatio: false`; format ticks and tooltips with the same rounding as your text; leave colors, the legend and the bar and line styling to the host.
- **D3:** draw into an `<svg viewBox="…">` so it scales with the column. Set colors as attributes from tokens — `.attr('fill', 'var(--viz-1)')`, axis text `var(--theme-text-secondary)`, axis lines `var(--viz-axis)`, gridlines `var(--viz-grid)`. The same palette rules as a static figure apply: series in slot order, no ninth color, direct labels.
- **No endless loops.** A `requestAnimationFrame` or `setInterval` that never stops burns the user's CPU for as long as the reply is on screen. Animate only in response to input, or give it a Play / Pause button that starts paused.

## Talking back

`shuvix.sendPrompt(text)` fills the user's input box. Use it for a button that turns the block's current state into a question — and put the state in the sentence, since the model reading it cannot see the block:

```js
shuvix.sendPrompt(`Why does the balance at ${state.rate}% grow faster after year ${state.years}?`)
```

One such button at most, labelled with what it will ask.

## Worked shape

```interactive
<title>Compound growth</title>
<div class="controls">
  <label>Rate <input id="rate" type="range" min="0" max="12" step="0.5" value="5"> <output id="rate-out"></output></label>
  <label>Years <input id="years" type="range" min="1" max="40" value="20"> <output id="years-out"></output></label>
</div>
<p class="hero" aria-live="polite"><span id="total"></span> from 1,000 after <span id="span"></span> years</p>
<div class="chart"><canvas id="chart" role="img" aria-label="Balance by year"></canvas></div>
<button id="ask">Ask why</button>
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
    data: { labels: [], datasets: [{ label: 'Balance', data: [], fill: true }] },
    options: {
      maintainAspectRatio: false,
      scales: { y: { ticks: { callback: (v) => v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: (c) => 'Balance ' + c.parsed.y.toLocaleString() } } }
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
    shuvix.sendPrompt(`Why does 1,000 at ${state.rate}% grow faster in the later years than the early ones?`)
  })
  render()
</script>
```

## What goes wrong

- **Static content in a block.** A chart with no control that nobody needs to hover is a ```svg figure written the long way.
- **Data fetched or parsed from CSV.** There is no network and no `eval`; `d3.csvParse` throws. Inline the data as JS arrays.
- **`<form>` with a submit handler.** Submission is blocked before the handler runs, so the Enter key does nothing. Use a button's `click` and an input's `input` event.
- **`alert()`, `confirm()`, `prompt()`.** Blocked. Show the message in the block.
- **Hex colors or a library's default palette.** They break in most themes. Leave Chart.js datasets uncolored (they take the palette in order) or use `shuvix.color('--viz-N')`; in CSS and SVG use `var(--viz-N)`.
- **`height: 100%` or `100vh`.** The block's height follows its content; a height tied to the viewport can never shrink.
- **Several blocks in one reply.** Each is a separate page to load. One block, and prose around it.
- **Also writing the page to a file.** The block lives in the reply; a copy in the workspace is a second thing that drifts. Write a file only when the user asks for one.
- **Restyling what the host already styled** — button CSS, dataset colors, a legend switched back on for one series, thick borders and big points. The defaults are the app's look; overriding them is how a block stops matching it.
- **A chart sized by its aspect ratio.** In a wide column it becomes half a screen tall, and a pie fills the whole width. Give the canvas a wrapper with a fixed height and `maintainAspectRatio: false`.
- **Unrounded numbers on screen** — `0.30000000000000004`, `2653.2977051`. Round every displayed value.
- **Rewriting a block to change it.** When the user asks for a change, adopt the block with `artifact` and `edit` the `.html` file; a rewritten block drifts on the parts nobody asked about.
