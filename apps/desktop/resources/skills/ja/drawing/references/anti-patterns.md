# Anti-patterns — what goes wrong

Check every figure against this list before you send it. If your figure matches an entry, it is wrong; fix it. This pass is worth more than anything else in this skill.

## Encoding

**Two y-scales on one plot.** The alignment of the two scales is arbitrary, so the figure invents a correlation that is not in the data. This is the single worst chart mistake.
→ Two figures, or index both series to a common base (=100 at the start) on one axis.

**A value ramp on categories that have no order.** Colouring each bar darker-where-bigger when the categories are products or teams double-encodes bar length as hue, spends the only free channel on information the figure already shows, and breaks the palette's checks.
→ One color (`--viz-1`) for every bar. The ramp is for ordered things only.

**A generated or recycled ninth hue.** Indistinguishable from an existing slot under colorblindness, and it will not follow the theme.
→ Fold the tail into "Other", or facet.

**Slots taken out of order** (using `--viz-5` for the first series because you like it). The order *is* the colorblind-safety mechanism.
→ 1, 2, 3, … as needed.

**A status color used for a plain series**, or a series color used to mean good/bad.
→ Status tokens only when the color *means* a state.

**A hue at the diverging midpoint, or two cool hues as the two poles.** The midpoint has to read as "nothing" and the poles as opposites.
→ `--viz-1` ↔ `--viz-mid` ↔ `--viz-8`.

**A truncated bar baseline.** Bars encode length, so a non-zero start exaggerates every difference.
→ Start at zero, or use a different form.

## Form

**Eight colors when the story is one number.** The most common way a figure misses its own point.
→ Emphasis: one slot, the rest gray. Or just write the number in a sentence.

**A one-bar chart, or a two-slice pie.**
→ The number is the figure. Put it in the sentence.

**A pie or donut used to compare close values.** Angles are unjudgeable.
→ Bars, sorted. Part-to-whole at a glance only, and at most ~6 segments.

**A figure that restates the sentence above it.** If the prose already said it, the figure is decoration.
→ Delete it, or make it show what the prose cannot.

**Unsorted bars** when nothing about the order is meaningful.
→ Sort by value; that is the comparison the reader came for.

## Marks and chrome

**Thick saturated blocks, heavy gridlines, no breathing room.** Reads loud and unfinished.
→ Thin marks, hairline recessive frame, generous padding. Saturated fills belong on small marks.

**Dashed gridlines or axes.** Dashing means "projected" or "threshold"; on a plain grid it is just noise.
→ Solid hairlines, one step off the surface.

**A border drawn around marks to separate them.**
→ A 2-unit surface gap, or a 2-unit surface ring on overlapping dots.

**A number on every data point.**
→ Label the endpoint, the extreme, the one that matters. Let the rest go.

**A label clipped by its own mark**, or text running past the `viewBox`. The card clips overflow, so whatever runs over simply disappears.
→ Labels outside marks; margin on all four sides; re-read the rendered figure.

**Text in the series color.** Several slots are below 3:1 on some theme surfaces and become unreadable as text.
→ Text tokens always; identity from the mark beside the text.

**A hard-coded hex, `white`, `black`, or a fixed background rectangle.** It survives exactly one of the eleven themes.
→ Tokens only. The card already supplies the background.

**A `width`/`height` on the root, or no `viewBox`.** The card scales by `viewBox` and clips the rest.
→ `viewBox` only.

## Structure

**Crossing arrows in a diagram** when reordering the boxes would avoid it.
→ Reorder. Crossings are almost always a layout failure, not a fact about the system.

**More than ~10 boxes.** Past that nobody reads it.
→ Cut a level of detail, or split into two figures.

**Mixed flow directions** — some arrows down, some right, some back up.
→ One direction, with returns visually distinct.
