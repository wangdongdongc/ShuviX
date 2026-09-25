# Style

How a finished figure looks. The rest of this skill makes a figure *correct* — the right form, colors that mean something, marks that do not lie. This page makes it *look finished*: type, color in practice, lines, space, numbers, and the small components an interactive block is built from. Most of it is restraint.

## What finished looks like

- **Part of the reply.** A figure sits inside the conversation, in the app's own font and colors. It should look like the app drew it, not like a screenshot pasted from somewhere else.
- **Flat and quiet.** Solid fills, thin lines, generous space. No gradients, shadows, blur or glow; no background rectangle behind the figure — the card is the background.
- **One thing is loud.** The data, or the one box the figure is about. Everything else — frame, labels, neutral boxes — steps back.
- **Words go in the reply.** No headings, paragraphs or explanations inside the figure. The title is the root's `aria-label` and the sentence before the figure; a block holds its controls, its view and at most one readout line.
- **The host has already styled the basics.** In an interactive block the font, text color, buttons, sliders, selects, tables and Chart.js are styled for you. Write bare tags and leave them alone; restyling them is how blocks drift away from the app.

## Type

**Two weights: 400 and 500.** 500 for a box title, a readout, a stat value; 400 for everything else. Never 600, 700 or `bold` — next to the app's text they look heavy.

**Sizes come from a short scale.** In a figure (`viewBox` units, roughly pixels in the chat column):

| Text | Size | Weight | Color |
|---|---|---|---|
| Box title | 13 | 500 | `--theme-text-primary`, or the box's `--viz-N-ink` |
| Box subtitle, callout, direct label | 11 | 400 | `--theme-text-secondary`, or the box's ink |
| Data value next to a mark | 11 | 400 | `--theme-text-secondary` |
| Axis tick | 11 | 400 | `--theme-text-tertiary` |

In an interactive block (CSS pixels): body and control labels 13, captions and legends 12, a readout 16 at 500, a stat value 20 at 500, one hero number 28 at 500. Nothing below 11, axis ticks included.

**Case.** Sentence case everywhere: "Monthly revenue", not "Monthly Revenue", never "MONTHLY REVENUE". No bold inside a label, no trailing period on a label.

**Numerals.** Numbers in a column, and a number that changes while the user drags, get `font-variant-numeric: tabular-nums` so they do not jitter. A single static large number does not — equal-width digits look loose.

**CJK.** Budget a full 1em per character; never add letter spacing. Mixed Chinese and Latin labels stay in the theme font — do not switch families for either script.

**No emoji, no icon glyphs, no decorative numbering** ("①", "Step 1:" in large type). A figure communicates with shape, position and a few words.

## Color in practice

The color jobs and palettes are in `SKILL.md` — identity, magnitude, polarity, state. This is how they are applied to boxes and blocks.

**Neutral is the default.** A box that is not about a category is `fill="var(--viz-wash)"` with `stroke="var(--theme-border-primary)"` and text in `--theme-text-primary`. Most boxes in most figures are neutral.

**Categories get a tint, not a solid.** When boxes are grouped by kind (yours vs third-party, client vs server, input vs output), a kind is one slot N, drawn as:

- fill `var(--viz-N-tint)` — a light wash of the hue;
- stroke `var(--viz-N)` at width 1;
- text `var(--viz-N-ink)` — the same hue, dark enough to read on its tint (title and subtitle both use it; the weight and size tell them apart).

```svg
<rect x="20" y="20" width="140" height="52" rx="6" fill="var(--viz-1-tint)" stroke="var(--viz-1)"/>
<g font-family="var(--theme-font-sans)" text-anchor="middle" fill="var(--viz-1-ink)">
  <text x="90" y="37" dominant-baseline="central" font-size="13" font-weight="500">Orders</text>
  <text x="90" y="55" dominant-baseline="central" font-size="11">Postgres</text>
</g>
```

Take slots in order — the first kind is 1, the second 2 — and stop at three kinds. A structural box (start, end, the user, a generic step) stays neutral. Color follows the kind: two boxes of the same kind always share a slot.

**Text on a tint is its ink.** Never `--theme-text-secondary` on a tint (gray on color reads dirty), never the slot color itself (too light as text), never `opacity` on text (it composites differently on every surface).

**One accent per figure.** The box the figure is about gets the emphasis — a tint among neutrals, or a 1.5 stroke — and nothing else competes with it.

**State is a word plus a color.** A risk or a failure is a neutral box with a `--viz-warn` or `--viz-critical` stroke at 1.5 *and* a label saying so. Color alone never carries a state.

**In a block:** CSS and inline SVG take `var(--viz-1)`, `var(--viz-1-tint)`, `var(--viz-wash)` directly; on a canvas, `shuvix.color('--viz-1')` gives the resolved color.

## Lines, corners, surfaces

| Element | Stroke |
|---|---|
| Neutral box border | 1, `--theme-border-primary` |
| Category box border | 1, `--viz-N` |
| Connector / arrow | 1, `--theme-text-tertiary` |
| Gridline | 1, `--viz-grid` |
| Axis, baseline | 1, `--viz-axis` |
| The one accent | 1.5 |

Nothing heavier than 1.5 unless the weight itself is data (a flow's width, a line's thickness as its weight).

**Corners:** boxes `rx="6"`, bars `rx="4"`, outer regions `rx="10"`. A radius of half the height makes a pill — only when you mean a pill.

**Surfaces:** the card is the background, so the root never gets a fill. A raised area inside a figure or block — a stat tile, a legend strip, a table header — is `--viz-wash`. Two levels of surface at most.

## Space and alignment

- **Work on a 4-unit rhythm** — 4, 8, 12, 16, 24. Gaps inside a component are 4–8, between components 12–16, before a new section 24.
- **Margins on every side.** 20 on the sides of a diagram's `viewBox`, 12–16 around a chart's plot, plus a left gutter as wide as the longest row label.
- **Equal things are equal.** Every single-line box the same height (36), every two-line box the same (52); same gaps between every pair in a row.
- **Align on a grid.** Row labels right-aligned to one gutter line, values left-aligned after a bar's tip, box centers on one baseline.
- **Space separates, borders do not.** If two things need separating, move them apart before drawing a line between them.

## Words and numbers

- **Labels are short phrases** — about 5 words, 10 CJK characters. A second line only when it carries a fact.
- **Units once.** Put the unit in the axis label or the first value ("Revenue, $M" then "12, 19, 14"), not on every tick.
- **Round everything that is displayed.** Integers for counts; one decimal for percentages unless the differences are smaller than that; the same precision across one figure. In a block, every number that reaches the screen goes through `Math.round`, `toFixed` or `toLocaleString()` — `0.1 + 0.2` prints `0.30000000000000004`.
- **Thousands separators** on anything over 9,999 (`toLocaleString()` does it); `1.2M` / `34K` when space is tight.
- **Signs:** `-$5M`, not `$-5M`; `+4.2%` when the sign is the point.
- **Dates** short: "Mar 3", "2026-03", "Q2". No time of day unless it matters.
- **The user's language** for every label. In Chinese, pick one magnitude unit (万 or 亿) for the whole figure.

## Interactive blocks — components

These apply only where your system prompt describes ```interactive blocks. Each snippet goes inside the block's body; the bare tags are already styled, so the CSS here is only layout.

**Control row** — every control shows its current value beside it:

```html
<div class="controls">
  <label>Rate <input id="rate" type="range" min="0" max="12" step="0.5" value="5"> <output id="rate-out">5%</output></label>
  <label>Plan <select id="plan"><option>Basic</option><option>Pro</option></select></label>
</div>
<style>.controls { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 12px; }</style>
```

**Readout** — the number the user is after, in one line under the controls:

```html
<p class="readout" aria-live="polite">After 20 years, 1,000 becomes <strong id="total">2,653</strong></p>
<style>
  .readout { color: var(--theme-text-secondary); margin: 0 0 12px; }
  .readout strong { color: var(--theme-text-primary); font-size: 16px; font-variant-numeric: tabular-nums; }
</style>
```

**Hero number** — when one figure *is* the answer, make it big and say what it is beside it:

```html
<div class="hero"><span id="hero">2,653</span> after 20 years</div>
<style>
  .hero { color: var(--theme-text-secondary); margin: 4px 0 12px; }
  .hero span { color: var(--theme-text-primary); font-size: 28px; font-weight: 500; font-variant-numeric: tabular-nums; margin-right: 6px; }
</style>
```

**Stat tiles** — two to four headline numbers side by side:

```html
<div class="stats">
  <div><span>Revenue</span><strong>$1.2M</strong></div>
  <div><span>Orders</span><strong>8,410</strong></div>
  <div><span>Refund rate</span><strong>2.1%</strong></div>
</div>
<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .stats div { background: var(--viz-wash); border-radius: 8px; padding: 10px 12px; }
  .stats span { display: block; font-size: 12px; color: var(--theme-text-secondary); }
  .stats strong { font-size: 20px; }
</style>
```

**Legend strip** — for D3 or inline SVG, and for a pie whose legend should carry values. (Chart.js already draws a small legend when there are two or more series, and none for one.)

```html
<div class="legend"><span><i style="background: var(--viz-1)"></i>Search 48%</span><span><i style="background: var(--viz-2)"></i>Direct 27%</span></div>
<style>
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--theme-text-secondary); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 8px; height: 8px; border-radius: 2px; }
</style>
```

**Segmented choice** — two to four options, one selected. `aria-pressed="true"` is the selected look; you only flip the attribute:

```html
<div class="seg" role="group" aria-label="Period"><button aria-pressed="true" data-v="month">Month</button><button aria-pressed="false" data-v="year">Year</button></div>
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

**Stepper** — Back / Next over the states of a process, with the position spelled out:

```html
<div class="steps"><button id="back">Back</button><span id="pos" aria-live="polite">Step 1 of 4</span><button id="next">Next</button></div>
<style>.steps { display: flex; align-items: center; gap: 12px; margin-top: 12px; color: var(--theme-text-secondary); }</style>
```

**Table** — bare `<table>` is styled; right-align the number columns:

```html
<table>
  <tr><th>Region</th><th>Orders</th><th>Share</th></tr>
  <tr><td>North</td><td>3,120</td><td>37.1%</td></tr>
</table>
<style>td + td, th + th { text-align: right; font-variant-numeric: tabular-nums; }</style>
```

## Charts inside a block

**Already done by the host — do not restate it:** series colors in slot order, bars with rounded ends and no wider than 24, 2-unit lines whose points appear only on hover, hover that reads every series at one x on line charts, no gridlines along a category axis, a small square legend (none for a single series), a tooltip in the theme's colors, the theme font, 500-weight titles, a short animation that turns off when the system asks for reduced motion.

**Yours to do:**

- **Size the chart with a wrapper**, not the canvas: `<div style="position: relative; height: 220px"><canvas id="chart" role="img" aria-label="…"></canvas></div>` and `maintainAspectRatio: false`. A pie or doughnut 200–240 high; horizontal bars `bars × 32 + 48`.
- **Format ticks and tooltips** with the same rounding as your text: `scales.y.ticks.callback: (v) => v.toLocaleString()`, `plugins.tooltip.callbacks.label: (c) => c.dataset.label + ': ' + c.parsed.y.toFixed(1) + '%'`.
- **Emphasis** is the only reason to set a dataset color: the series that matters keeps its slot, the rest get `shuvix.color('--theme-text-tertiary')`.
- **Leave alone:** dataset colors otherwise, the legend, border widths, point radii, fonts.

## Motion

Only in response to input, and only `opacity` and `transform`, 200ms or less. Wrap any CSS transition you add in `@media (prefers-reduced-motion: no-preference) { … }`. Nothing moves on its own; an animation the user did not start is a loop that never stops.

## The look pass

Before sending, check the figure against this list:

- Weights are 400 and 500 only; no Title Case, no capitals, no bold inside labels.
- Every size is on the scale; nothing under 11.
- At most three hues, each meaning one kind of thing; text on a tint is its ink; structure is neutral.
- Lines are 1, the one accent 1.5; no gradients, shadows or background fills.
- Every number is rounded and formatted; each unit appears once.
- Margins on every side; equal things are equal; edges line up.
- No emoji, no heading or paragraph inside the figure.
- In a block: controls show their values, there is one view, and the host's styling is untouched.
