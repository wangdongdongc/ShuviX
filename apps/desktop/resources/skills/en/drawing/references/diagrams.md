# Boxes and arrows

Flows, structures, layers, before-and-after — every figure made of boxes and arrows. It is drawn by hand, like every other figure here.

**A figure that explains must be smaller than the thing it explains.** When someone asks for a picture of a plan, they are asking for less than the plan: the shape of it, the part that matters. Turning every step into a box hands the same complexity back in a harder notation. You wrote the plan, so a thirty-box graph reads fine to you — to them it has no way in.

## Before you draw

1. **Name the one question the figure answers** — "what are the phases", "where does a request go", "what depends on what", "what changes". Put it in the root's `aria-label`: that is the figure's title.
2. **Count the parts.** More than 5 boxes means one figure is the wrong answer — see *Splitting*.
3. **Pick the shape from the question**, not from the subject:

| The question | Draw |
|---|---|
| What happens, in what order | A flow in one direction: left to right for up to 4 boxes, top to bottom beyond that |
| What is inside what | One outer region with 2–4 regions side by side inside it; at most two levels |
| What sits on what | A stack of full-width bands, top to bottom |
| What changes | Before and after: two columns of the same boxes, the changed one marked |
| What repeats | A straight flow plus a single return arrow — never boxes placed around a ring |

Not every plan is a flow. A sequence of phases is often clearest as a row of 3–5 boxes with no branches at all; a list of options is a table, not a diagram.

## The budget

- **At most 5 boxes per figure, at most 4 in a row.**
- **A box holds a short phrase**: about 5 words, or 10 CJK characters. A second line only when it carries a fact; never a sentence.
- **One accent.** The box that matters — the risk, the change, the answer — is marked; everything else stays neutral.
- **Arrows carry no labels** unless their meaning is not obvious from the two ends; then 3 words at most, in clear space.

## Splitting

When the thing has more parts than the budget:

1. **Draw the overview**: 3–5 boxes and the main flow only — no fan-outs, no meshes, no error paths.
2. **Then one small figure per part that matters**, each introduced by a sentence of prose saying what it zooms into.
3. **Or stop after the overview** and ask which part to open. The reader asked to understand; completeness can arrive over several figures, never crammed into one.

Promise only what you draw: if the prose says "two figures", draw both.

## Geometry — do the arithmetic before writing coordinates

Use a `viewBox` 640 wide and leave 20 units of margin on each side, so the usable width is 600.

- **Text width**: font-size × 0.6 per Latin character, font-size × 1.0 per CJK character. Box width = the widest label + 32 of padding, rounded up.
- **Row packing**: n boxes of width w with gaps g need n·w + (n − 1)·g ≤ 600. If the row does not fit, shorten labels or use a second row — boxes never touch or overlap.
- **Gaps**: at least 40 along the flow (room for an arrow), at least 16 across it.
- **Same content, same size**: every single-line box has the same height (36 at font-size 13).
- **Centered text**: `x` = box x + width / 2, `y` = box y + height / 2, with `text-anchor="middle"` and `dominant-baseline="central"` on the `<text>` itself.
- **Height**: the `viewBox` height is the lowest element's bottom + 20. Nothing sits outside it.

## Arrows

Define one marker and reuse it:

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M1 1L9 5L1 9" fill="none" stroke="var(--theme-text-tertiary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

- **An arrow runs edge to edge**: it starts on the source box's edge and ends 4 units short of the target's edge. Compute both ends from the boxes; never draw center to center.
- **An arrow crosses no other box and no label.** If the straight line would, route it with right angles: `<path d="M x1 y1 V ymid H x2 V y2" fill="none" .../>`. Every connector `<path>` needs `fill="none"`.
- **Arrows run with the flow.** A return arrow is the only exception, and a figure has at most one.

## Color

- **Boxes**: `fill="var(--theme-bg-secondary)"`, `stroke="var(--theme-border-primary)"`, labels in `var(--theme-text-primary)`.
- **The accent**: the same box with `stroke="var(--viz-1)"` and `stroke-width="1.5"` — or a state token when it means a state (`--viz-warn` for a risk, `--viz-critical` for a failure). Its label stays in a text token.
- **Regions** (the outer box of a containment figure): `fill="none"`, a dashed border (`stroke-dasharray="4 4"`), the region's name at its top-left inside.
- **Connectors**: `var(--theme-text-tertiary)`, width 1.

## A worked shape

A migration plan, asked "how does this go and where is the risk": four steps, one accent, no branches.

```svg
<svg viewBox="0 0 640 114" role="img" aria-label="The migration in four steps; dual write carries the risk">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1L9 5L1 9" fill="none" stroke="var(--theme-text-tertiary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <rect x="180" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--viz-1)" stroke-width="1.5"/>
  <rect x="340" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <rect x="500" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <line x1="140" y1="48" x2="176" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <line x1="300" y1="48" x2="336" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <line x1="460" y1="48" x2="496" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <text x="80" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">New API</text>
  <text x="240" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">Dual write</text>
  <text x="400" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">Cut reads</text>
  <text x="560" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">Drop table</text>
  <text x="240" y="88" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="11" fill="var(--theme-text-secondary)">risk is here</text>
</svg>
```

The arithmetic behind it: the widest label, "Drop table", is 10 × 13 × 0.6 ≈ 78, plus 32 of padding = 110, rounded up to 120. Four boxes of 120 with three gaps of 40 take 600 — exactly the usable width. Each arrow starts on a box's right edge and stops 4 short of the next box.

## Check before you call it done

- At most 5 boxes, at most 4 in a row.
- Every label fits its box by the arithmetic above.
- No arrow passes through a box or a label; no label touches a line.
- Everything is inside the `viewBox`.
- Read it as someone who never saw the plan: can they say in five seconds what it shows? If not, cut something.
