# Marks, labels and the frame

The quiet look is a few fixed specs plus two pieces of negative space. The data is the only thing allowed to be loud.

## Mark specs

| Mark | Spec |
|---|---|
| Bar / column | At most ~24 units thick in `viewBox` terms; never fill the slot — the leftover band is air. `rx="4"` on the data end, square at the baseline. |
| Line | `stroke-width="2"`, `stroke-linejoin="round"`, `stroke-linecap="round"` |
| Point marker | `r` at least 4 (8 across), filled with the series color |
| Area fill | The series hue at ~10% opacity — a wash, never a saturated block. Use `fill-opacity="0.1"`, not a lighter token. |
| Gridline | `stroke="var(--viz-grid)"`, `stroke-width="1"`, **solid** |
| Axis / baseline | `stroke="var(--viz-axis)"`, `stroke-width="1"`, solid |

Gridlines are a last resort: direct labels first, gridlines only if the reader must still compare across a distance. Never dash them — dashing reads as "projection" or "threshold" when it is just a grid.

## The two spacers — the surface does the separating

- **Surface gap.** A 2-unit gap in the card's background separates touching marks: every segment of a stacked bar, every pair of adjacent bars. Same width everywhere in one figure. Achieve it by making the marks smaller, not by drawing anything.
- **Surface ring.** A dot that overlaps a line or another dot gets a 2-unit ring in the surface color: `stroke="var(--theme-bg-secondary)" stroke-width="2"`.

**Never draw a border around a mark to separate it.** A stroke adds ink that is not data. The gap and the ring are the mechanism.

## Labels

- **Label directly, and label selectively.** Every part of the figure must be identifiable without relying on color — but a number on *every* point is chaos and goes unread. Name each series once, and call out the endpoint, the extreme, or the one value the argument rests on.
- **Text never wears the series color.** Labels, values and axis text use `--theme-text-secondary` or `-tertiary`; identity comes from the colored mark *beside* the text. Several slots are illegible as text on some theme surfaces, so this is a correctness rule, not a style preference.
- **Put labels outside marks.** You cannot measure text in hand-written SVG, so an inside-the-bar label is a bet you will sometimes lose, and a clipped label is worse than none. Bars → value past the tip. Columns → value above the cap. Lines → name at the right end.
- **Anchor deliberately.** `text-anchor="end"` for row labels in a left gutter, `middle` under a column, `start` after a bar tip. Getting this right is what makes a hand-laid grid look aligned.
- **Vertical centering.** SVG text sits on its baseline, so a label centered on a row at `y` goes at about `y + 4` for an 11-unit font. `dominant-baseline` is inconsistent across renderers — just do the arithmetic.
- **Size.** 11 units is the floor for anything that must be read; 10 is acceptable for axis ticks only. Set `font-family="var(--theme-font-sans)"` on a wrapping `<g>` rather than on every `<text>`.
- **Aligned columns of numbers** get `style="font-variant-numeric: tabular-nums"`. A single large number does not — equal-width digits make it look loose.

## Legend

A legend is for two or more series *when direct labels cannot reach them all*. One series needs none: the title already says what is plotted. When you do draw one, it is a row of `<rect>` swatches (about 8×8, `rx="2"`) with text in `--theme-text-secondary`, placed above the plot rather than beside it — a side legend steals width the figure needs.

Direct labels before a legend; a legend before gridlines; gridlines before anything else.

## The frame

Give the figure air: a left gutter wide enough for the longest row label, and about 12–16 units of margin on the other three sides. Crowding the `viewBox` edge is the most common way a hand-drawn figure looks unfinished — and, since the card clips overflow rather than scrolling it, the most common way part of it disappears.
