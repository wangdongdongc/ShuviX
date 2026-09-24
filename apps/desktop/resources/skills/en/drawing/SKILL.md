---
name: drawing
description: "The contract and the craft for inline SVG figures — what a figure must keep to render at all (viewBox, color tokens, what gets stripped), picking the form (and when not to draw a chart at all), boxes-and-arrows diagrams that stay small enough to read, mark specs, label and legend rules, the categorical/sequential/status palette, interactive blocks where your system prompt describes them (when one earns its place, layout, wiring, a worked example), and a catalog of what goes wrong. Load this before the first figure in a conversation, even a two-box sketch."
---

# Drawing figures

This skill is the whole guide to figures: first the **contract** a ```svg figure has to keep to render at all, then the **craft** — what to draw, and how to make it read. Your system prompt only tells you to load it. Once loaded it stays in the conversation, so the next figure does not need it again.

## The contract

However small the figure, break one of these and it renders wrong.

- **One element per line** — `edit` needs anchors; a minified figure can only be redrawn.
- **`viewBox` on the root, never `width` / `height`** — the figure is scaled to the column and overflow is clipped.
- **`role="img"` and an `aria-label` on the root**, saying what it shows — the label is also its title.
- **Colors only from tokens, never hex** — a literal color breaks in 10 of the 11 themes. `var()` works in presentation attributes: `fill="var(--viz-1)"`.
  - Series `--viz-1` … `--viz-8` in that order · magnitude `--viz-seq-1` … `--viz-seq-5` · polarity `--viz-1` ↔ `--viz-mid` ↔ `--viz-8` · state `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical`
  - Gridlines `--viz-grid` · axes `--viz-axis` · surfaces `--theme-bg-secondary` / `-tertiary` · borders `--theme-border-primary`
- **Text in text tokens, never a series color** — `fill="var(--theme-text-secondary)"` (or `-primary` / `-tertiary`), `font-family="var(--theme-font-sans)"`, `font-size` at least 11.
- **No `<style>`, `<foreignObject>`, `<script>` or remote `href` / `src`** — they are stripped before display. `url(#id)` references are fine; `url(https://…)` is not.

## Boxes and arrows: the budget

A figure that explains must be smaller than the thing it explains. Before a flow or a structure, name the one question it answers and count its parts.

- At most 5 boxes, at most 4 in a row, one direction; a box holds a short phrase, not a sentence.
- More parts than that: draw the overview — the boxes and the main flow only — then one small figure per part that matters, with prose between; or draw the overview and offer to open a part.
- Arrows stop at box edges and cross no other box.

Flows, structures, layers, before-and-after have their own reference: `references/diagrams.md`. Read it before drawing one; the steps below are for figures that carry data.

**Interactive blocks** (```interactive — sliders, step-throughs, hover-to-read charts) have theirs too: `references/interactive.md` — **only if your system prompt describes ```interactive blocks**; where it does not, your replies are shown somewhere that cannot run them, so do not write one. Read it before writing one; the palette rules below apply inside a block as well.

## Do this in order. Color comes last.

1. **Decide whether it should be a figure at all.** Prose is often clearer, and a single number is not a chart. → `references/choosing-a-form.md`
2. **Pick the form from the data's job** — magnitude, identity, polarity, one headline number, change over time. The job picks the type; the type is not a matter of taste. → same file
3. **Lay out the marks.** Thin marks, recessive frame, gaps instead of borders. → `references/marks.md`
4. **Assign color by role** (below) — never by taste, never by rank.
5. **Check it against `references/anti-patterns.md`.** If your figure matches an entry, it is wrong. This is the highest-value pass; do not skip it.
6. **Read the rendered figure.** Collided labels, marks outside the `viewBox`, a legend doing a direct label's job — all mean it is not finished.

## Color: four jobs, four token sets

Every color answers exactly one of these. Pick the job first, then the tokens follow.

| The color's job | Tokens | Rule |
|---|---|---|
| **Identity** — which series is this | `--viz-1` … `--viz-8` | In that order, never cycled. |
| **Magnitude** — how much | `--viz-seq-1` (least) … `--viz-seq-5` (most) | One ramp, monotonic. |
| **Polarity** — which side of nothing | `--viz-1` ↔ `--viz-mid` ↔ `--viz-8` | Gray in the middle, opposite hues at the poles. |
| **State** — good or bad | `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical` | Only when the color *means* a state. Never as a 9th series. |

Frame and ink are not color jobs: gridlines `--viz-grid`, axes and baselines `--viz-axis`, all text `--theme-text-primary` / `-secondary` / `-tertiary`.

**The slot order is a colorblind-safety mechanism, not decoration.** The eight hues were ordered so that *adjacent* slots stay separable under protanopia and deuteranopia; taking them out of order, or skipping to the one you like, breaks that. Take them 1, 2, 3, … as you need them.

**There is no ninth color.** A ninth series folds into "Other", or the figure becomes small multiples. Never invent a hue — a generated one is indistinguishable from an existing slot under CVD, and it will not survive theme switching either.

**Sequential is the safe default.** One hue, more-is-further-from-the-surface. Reach for categorical only when the series themselves are the subject — and when the story is "this one moved", that is *emphasis* (one slot plus `--theme-text-tertiary` for the rest), not eight colors.

**Some slots sit below 3:1 against some theme surfaces.** That is the palette paying for colorblind separability, and the price is that **every part of the figure must be labeled directly**. A figure whose parts are told apart by color alone is wrong here, regardless of how it looks in your current theme.

## A small figure in full

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

## Things only true of hand-written SVG

- **You cannot measure text.** Nothing tells you how wide a label renders, so a label placed inside a bar is a guess that will sometimes be clipped. Put labels outside marks. When you must estimate, budget roughly 0.6em per Latin character and a full 1em per CJK character, then leave margin on top of that.
- **Nothing lays out for you.** Every coordinate is yours, so collision is the default failure. Work on a grid — a fixed left gutter for row labels, a fixed baseline, even spacing — and keep the count low enough that the grid stays coarse.
- **`viewBox` is the whole coordinate system.** Pick round numbers and let the card scale it. Do not chase pixel sizes; a `viewBox` of `0 0 320 180` is easier to lay out in than `0 0 1024 576` and renders identically.
- **Give the figure an accessible name**: `role="img"` plus `aria-label` on the root, saying what the figure shows. It is also what the app can read back as a title.
