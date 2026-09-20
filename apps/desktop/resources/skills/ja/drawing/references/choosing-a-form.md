# Choosing a form

Decide this **before** color, and decide it from the data's job — not from which chart looks nice. Sometimes the right form is not a chart, and sometimes it is not a figure at all.

## Should this be a figure?

A figure earns its place when the *shape* carries an argument that prose or a table cannot. If the reader would get it faster from a sentence, write the sentence.

| The data is… | Use | Not |
|---|---|---|
| One current value, maybe with a direction | The number, in the sentence | A one-bar chart |
| A handful of headline numbers | A small table, or prose | A grouped bar chart |
| One ratio against a limit | A single bar with the limit marked | A two-slice pie |
| More than ~7 classes that all carry meaning | A table | More colors |
| Exact values the reader will compare digit by digit | A table | Any chart |

A chart is for *shape* — order, proportion, trend, outlier. A table is for *values*. When you need both, the chart shows the shape and names the two or three numbers that matter.

## The job → the form

| What the reader must do | Form | Color job |
|---|---|---|
| Compare magnitude, low → high | Horizontal bars, sorted | Sequential, or one slot |
| Follow a trend over time | Line; area only for a single series | One slot |
| Tell distinct series apart | Grouped/stacked bars, multi-line | Categorical |
| See that **one** series is the point | **Emphasis**: one slot, the rest `--theme-text-tertiary` | One slot + gray |
| Above/below a baseline, delta to target | Diverging bars from a centered axis | Polarity |
| Part-to-whole | One stacked bar, horizontal | Categorical |
| Before → after per item | Dumbbell (two dots, connector) | One hue, two steps |
| Structure, flow, state machine | This is a *diagram* — write a ```mermaid fence in the reply and the chat will render it, or draw boxes and arrows by hand if it is one sentence's worth | — |

## Rules behind the table

- **Horizontal bars beat vertical ones** for anything with names. Category labels read horizontally without rotation, long names fit, and you can sort by value — which is usually the actual point.
- **Sort unless the order means something.** Alphabetical or arrival order hides the ranking the reader came for. Keep the data's own order only for time, or for an ordered scale.
- **Emphasis is the most underused form.** One series in `--viz-1`, everything else in `--theme-text-tertiary`. When the story is "this one moved", eight colors bury it. This is very often the honest answer to "make this clearer".
- **Start bars at zero.** A truncated baseline exaggerates differences; that is the oldest chart lie. Lines over time may be truncated — say so on the axis.
- **Area only for one series.** Stacked areas make every band above the first unreadable, because each one's baseline moves.

## Series-count ladder

| Series | Treatment |
|---|---|
| 1 | No legend — the title says what it is |
| 2–3 | Comfortable; direct-label each |
| 4 | Direct labels become mandatory — yellow and orange are now both on screen |
| 5–6 | Soft cap; consider small multiples |
| 7–8 | The ceiling, and it will look busy |
| 9+ | Fold the tail into "Other", or facet into small multiples |

Never solve "too many series" by inventing a hue.

## When it is a diagram, not a chart

Boxes and arrows have their own discipline: one direction of flow (left-to-right for pipelines, top-to-bottom for decisions), boxes on a grid with equal widths, arrows that meet box edges rather than corners, and no crossing lines if any reordering avoids it. Keep it under ~10 boxes — past that, the figure stops being readable and the content wants a different cut.
