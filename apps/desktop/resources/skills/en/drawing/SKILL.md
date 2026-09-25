---
name: drawing
description: "The contract and the craft for inline SVG figures — what a figure must keep to render at all (viewBox, color tokens, what gets stripped), picking the form (and when not to draw a chart at all), boxes-and-arrows diagrams that stay small enough to read, mark specs, label and legend rules, the categorical/sequential/status palette, the look (type scale, two weights, category tints, lines, spacing, number formatting), interactive blocks where your system prompt describes them (when one earns its place, layout, wiring, a worked example), and a catalog of what goes wrong. Load this before the first figure in a conversation, even a two-box sketch."
---

# Drawing figures

This skill is the whole guide to figures: first the **contract** a ```svg figure has to keep to render at all, then the **craft** — what to draw, and how to make it read. Your system prompt only tells you to load it. Once loaded it stays in the conversation, so the next figure does not need it again.

## The contract

However small the figure, break one of these and it renders wrong.

- **One element per line** — `edit` needs anchors; a minified figure can only be redrawn.
- **`viewBox` on the root, never `width` / `height`, and 640 wide** — the figure is scaled to the column and overflow is clipped. 640 is about the column's width, so a unit is about a pixel and `font-size="11"` reads as 11; a narrower `viewBox` is blown up, text and all (320 wide renders 11 as 22). Narrow content stays in a 640-wide `viewBox`, centered.
- **`role="img"` and an `aria-label` on the root**, saying what it shows — the label is also its title.
- **Colors only from tokens, never hex** — a literal color breaks in 10 of the 11 themes. `var()` works in presentation attributes: `fill="var(--viz-1)"`.
  - Series `--viz-1` … `--viz-8` in that order · magnitude `--viz-seq-1` … `--viz-seq-5` · polarity `--viz-1` ↔ `--viz-mid` ↔ `--viz-8` · state `--viz-good` / `--viz-warn` / `--viz-serious` / `--viz-critical`
  - Gridlines `--viz-grid` · axes `--viz-axis` · surfaces `--theme-bg-secondary` / `-tertiary` · borders `--theme-border-primary`
  - Category boxes `--viz-N-tint` (fill) with `--viz-N-ink` (text) · a raised surface or neutral box `--viz-wash`
- **Text in text tokens, never a series color** — `fill="var(--theme-text-secondary)"` (or `-primary` / `-tertiary`), `font-family="var(--theme-font-sans)"`, `font-size` at least 11. The one exception: text on a category tint is that slot's ink — `var(--viz-2-ink)` on `var(--viz-2-tint)`.
- **No `<style>`, `<foreignObject>`, `<script>` or remote `href` / `src`** — they are stripped before display. `url(#id)` references are fine; `url(https://…)` is not.

## Boxes and arrows: the budget

A figure that explains must be smaller than the thing it explains. Before a flow or a structure, name the one question it answers and count its parts.

- At most 5 boxes, at most 4 in a row, one direction; a box holds a short phrase, not a sentence.
- More parts than that: draw the overview — the boxes and the main flow only — then one small figure per part that matters, with prose between; or draw the overview and offer to open a part.
- Arrows stop at box edges and cross no other box.

Flows, structures, layers, before-and-after have their own reference: `references/diagrams.md`. Read it before drawing one; the steps below are for figures that carry data.

**Interactive blocks** (```interactive — sliders, step-throughs, hover-to-read charts) have theirs too: `references/interactive.md` — **only if your system prompt describes ```interactive blocks**; where it does not, your replies are shown somewhere that cannot run them, so do not write one. Read it before writing one; the palette rules below apply inside a block as well.

## The look

Correct is not finished. These eight rules are what make a figure look like part of the app; the full guide — type scale, spacing, number formats, and the components of an interactive block (those only if your system prompt describes interactive blocks) — is `references/style.md`.

1. **Two weights: 400 and 500.** 500 for a box title or a headline number, 400 for the rest. Never 600, 700 or `bold`.
2. **Sentence case, short labels.** "Monthly revenue", never "Monthly Revenue" or capitals; no bold inside a label, no trailing period.
3. **Thin lines.** 1 for boxes, connectors, axes and gridlines; 1.5 for the one accent; nothing heavier unless the weight is data.
4. **Color by kind, not by sequence.** Neutral by default (`--viz-wash` fill, `--theme-border-primary` stroke). When boxes are grouped by kind, a kind is one slot: `--viz-N-tint` fill, `--viz-N` stroke, `--viz-N-ink` text. At most three kinds; structure stays neutral.
5. **Flat.** No gradients, shadows, blur or glow, and no background rectangle — the card is the background.
6. **No emoji and no title inside the figure.** The title is the `aria-label` and your sentence before it; explanations go in the reply.
7. **Rounded, formatted numbers.** `1,234`, `12.5%`, `-$5M`; the same precision across a figure; each unit once.
8. **Air.** Margins on every side, equal heights for equal things, space instead of borders.

## Do this in order. Color comes last.

1. **Decide whether it should be a figure at all.** Prose is often clearer, and a single number is not a chart. → `references/choosing-a-form.md`
2. **Pick the form from the data's job** — magnitude, identity, polarity, one headline number, change over time. The job picks the type; the type is not a matter of taste. → same file
3. **Lay out the marks.** Thin marks, recessive frame, gaps instead of borders. → `references/marks.md`
4. **Assign color by role** (below) — never by taste, never by rank.
5. **Apply the look** (above). Before an interactive block — only if your system prompt describes them — or a figure with more than a few parts, read `references/style.md`.
6. **Check it against `references/anti-patterns.md`.** If your figure matches an entry, it is wrong. This is the highest-value pass; do not skip it.
7. **Read the rendered figure.** Collided labels, marks outside the `viewBox`, a legend doing a direct label's job — all mean it is not finished.

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
<svg viewBox="0 0 640 128" role="img" aria-label="Requests by tier: free 1,840, team 960, enterprise 410">
  <g font-family="var(--theme-font-sans)" font-size="11" text-anchor="end" fill="var(--theme-text-secondary)">
    <text x="100" y="32" dominant-baseline="central">Free</text>
    <text x="100" y="64" dominant-baseline="central">Team</text>
    <text x="100" y="96" dominant-baseline="central">Enterprise</text>
  </g>
  <rect x="112" y="22" width="460" height="20" rx="4" fill="var(--viz-1)"/>
  <rect x="112" y="54" width="240" height="20" rx="4" fill="var(--viz-1)"/>
  <rect x="112" y="86" width="102" height="20" rx="4" fill="var(--viz-1)"/>
  <line x1="112" y1="14" x2="112" y2="114" stroke="var(--viz-axis)" stroke-width="1"/>
  <g font-family="var(--theme-font-sans)" font-size="11" fill="var(--theme-text-secondary)" style="font-variant-numeric: tabular-nums">
    <text x="580" y="32" dominant-baseline="central">1,840</text>
    <text x="360" y="64" dominant-baseline="central">960</text>
    <text x="222" y="96" dominant-baseline="central">410</text>
  </g>
</svg>
```

One hue for every bar (they compare one measure, so color would only repeat the length), labels in a right-aligned gutter, each value just past its bar's tip, bars 20 thick with air between them, and no gridlines because the values are written out.

Read the figure once before you call it done: labels that collide, marks outside the `viewBox`, or a legend doing work a direct label should do all mean it is not finished.

## Things only true of hand-written SVG

- **You cannot measure text.** Nothing tells you how wide a label renders, so a label placed inside a bar is a guess that will sometimes be clipped. Put labels outside marks. When you must estimate, budget roughly 0.6em per Latin character and a full 1em per CJK character, then leave margin on top of that.
- **Nothing lays out for you.** Every coordinate is yours, so collision is the default failure. Work on a grid — a fixed left gutter for row labels, a fixed baseline, even spacing — and keep the count low enough that the grid stays coarse.
- **`viewBox` is the whole coordinate system, and its width sets the scale.** Keep it 640 wide so units are pixels: the type scale and stroke widths in this skill assume it. Pick a round height that fits the content plus its margin.
- **Give the figure an accessible name**: `role="img"` plus `aria-label` on the root, saying what the figure shows. It is also what the app can read back as a title.
