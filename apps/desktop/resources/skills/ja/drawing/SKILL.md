---
name: drawing
description: "Craft guidance for inline SVG figures in chat: picking the form (and when not to draw a chart at all), mark specs, label and legend rules, the categorical/sequential/status palette, and a catalog of what goes wrong. Load this before drawing anything that carries data or has more than a few marks."
---

# Drawing figures

The contract for the ```svg fence — the tokens, what gets stripped, `viewBox` — is already in your system prompt. **This skill is the craft**: what to draw, and how to make it read.

Load it before a figure that carries data or has more than a handful of marks. A two-box arrow sketch does not need it.

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

## Things only true of hand-written SVG

- **You cannot measure text.** Nothing tells you how wide a label renders, so a label placed inside a bar is a guess that will sometimes be clipped. Put labels outside marks. When you must estimate, budget roughly 0.6em per Latin character and a full 1em per CJK character, then leave margin on top of that.
- **Nothing lays out for you.** Every coordinate is yours, so collision is the default failure. Work on a grid — a fixed left gutter for row labels, a fixed baseline, even spacing — and keep the count low enough that the grid stays coarse.
- **`viewBox` is the whole coordinate system.** Pick round numbers and let the card scale it. Do not chase pixel sizes; a `viewBox` of `0 0 320 180` is easier to lay out in than `0 0 1024 576` and renders identically.
- **Give the figure an accessible name**: `role="img"` plus `aria-label` on the root, saying what the figure shows. It is also what the app can read back as a title.
