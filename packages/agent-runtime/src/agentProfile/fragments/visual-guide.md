<!-- shuvix:carrier-start -->

## Drawing figures inline

A ```svg fenced block in your reply renders **inline as a figure**, drawn as you write it — hand-written SVG, no file, no tool call. Reach for it when the shape itself carries the argument: a chart at true proportions, an annotated schematic, a layout or mockup. Structure — flow, state machines, sequence, ER — goes in a ```mermaid fence in the reply instead, not in a `*-graph.md` and not through a sub-agent. When prose is clearer, write prose.

<!-- shuvix:adopt-start -->

**When the user asks to change a figure you already drew, `artifact` adopt it and `edit` the file — never redraw it.**

<!-- shuvix:adopt-end -->

<!-- shuvix:carrier-end -->

### The contract

However small the figure, break one of these and it renders wrong.

- **One element per line** — `edit` needs anchors; a minified figure can only be redrawn.
- **`viewBox` on the root, never `width` / `height`** — the figure is scaled to the column and overflow is clipped.
- **`role="img"` and an `aria-label` on the root**, saying what it shows — the label is also its title.
- **Colors only from tokens, never hex** — a literal color breaks in 10 of the 11 themes. `var()` works in presentation attributes: `fill="var(--viz-1)"`.
  - Series `--viz-1` … `--viz-8` in that order · magnitude `--viz-seq-1` … `--viz-seq-5` · polarity `--viz-1` ↔ `--viz-mid` ↔ `--viz-8` · state `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical`
  - Gridlines `--viz-grid` · axes `--viz-axis` · surfaces `--theme-bg-secondary` / `-tertiary` · borders `--theme-border-primary`
- **Text in text tokens, never a series color** — `fill="var(--theme-text-secondary)"` (or `-primary` / `-tertiary`), `font-family="var(--theme-font-sans)"`, `font-size` at least 11.
- **No `<style>`, `<foreignObject>`, `<script>` or remote `href` / `src`** — they are stripped before display. `url(#id)` references are fine; `url(https://…)` is not.

<!-- shuvix:craft-start -->

### Craft

- **Series colors in order, never cycled.** A ninth series folds into "other" or becomes small multiples — never a color you invent. State colors mean state; never borrow one as a series color. Gridlines and axes are deliberately faint: data always reads louder than the frame.
- **Label the figure directly.** Some series colors sit under 3:1 against some theme surfaces by design — the palette trades that for color-blind separability, and direct labels are what pays for it. A figure that identifies its parts by color alone is wrong here. Two or more series: name each one in the figure; keep the count small enough that you can.
- **One axis.** Two measures of different scale become two figures or an indexed common base — never two y-scales.

### Shape

```svg
<svg viewBox="0 0 320 120" role="img" aria-label="Requests by tier">
  <line x1="40" y1="100" x2="300" y2="100" stroke="var(--viz-axis)" stroke-width="1"/>
  <rect x="56" y="40" width="40" height="60" rx="4" fill="var(--viz-1)"/>
  <rect x="136" y="64" width="40" height="36" rx="4" fill="var(--viz-2)"/>
  <g font-family="var(--theme-font-sans)" font-size="11" text-anchor="middle"
     fill="var(--theme-text-secondary)">
    <text x="76" y="116">free</text>
    <text x="156" y="116">paid</text>
  </g>
</svg>
```

Read the figure once before you call it done: labels that collide, marks outside the `viewBox`, or a legend doing work a direct label should do all mean it is not finished.

<!-- shuvix:craft-end -->
