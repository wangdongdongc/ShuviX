# Design guide — follow it strictly

Widgets are dense, single-purpose utilities: think menu-bar app or extension popup, not a landing page.

- **Layout**: open straight into the working UI and fill the viewport (`p-3` or `p-4`; widths as in "Where it runs"); no hero, welcome title, "Get Started" button or onboarding. Stack vertically; use `grid` / `flex-row` only for genuinely columnar data.
- **Typography**: body `text-xs` or `text-sm`, nothing above `text-base`; `font-medium` / `font-semibold`, not `font-bold`; code, data and their inputs in `font-mono text-xs`.
- **Spacing**: padding `p-2.5`–`p-4`, gaps `gap-1.5`–`gap-3`, margins `mt-1`–`mt-4`.
- **Decoration**: `rounded-md` or `rounded-lg`; no shadow except `shadow-sm` on popovers; no gradients, `border-2` or nested cards; `transition-colors` only.
- **Interaction**: Enter runs or submits, Escape clears; derive results as the user types (`useMemo` / `useDeferredValue`), no spinner for local work; an icon-only copy button on generated output; errors inline under the field in `text-danger`, never in a modal.
- **Loading from the API or the disk**: show the previous content (or an empty state that says what will appear) while a request is in flight, never a full-screen spinner (`api.use` keeps the previous `data` while it reloads); a failure shows its `message` inline with a retry.

## Where it runs

The same widget is used in three places, and it has to work in all of them:

| Where                                                          | Width      | Input              |
| -------------------------------------------------------------- | ---------- | ------------------ |
| ShuviX's right panel (also in a browser connected to ShuviX)   | 300–420px  | mouse and keyboard |
| Its own window, or a browser tab, often maximized              | 800–1900px | mouse and keyboard |
| A phone's browser                                              | 360–430px  | touch              |

The widget runs in its own frame, so Tailwind's breakpoints measure the space it actually gets: the panel is narrow even on a large screen. Never try to detect where it is. The width decides the layout; the input decides the sizes.

1. **Write it for the panel first.** One column, controls `w-full`, no fixed width above 300px, the dense look above. A wide table or code block scrolls inside its own container (`overflow-x-auto`), never the whole page.
2. **Wide is an enhancement, not a stretch.** From `md:` up, use the room: list and detail side by side, every column of a table, a second column of figures. Cap the width so lines do not run across a maximized window: `max-w-2xl mx-auto` for a single tool, `max-w-5xl mx-auto` for two panes.
3. **Touch changes sizes, never the layout.** Use the `pointer-coarse:` variant, which applies on touch screens only, so the panel stays dense: inputs and selects `pointer-coarse:text-base` (below 16px, iOS zooms the page when one is focused), buttons, toggles and list rows `pointer-coarse:min-h-10`. Every action has a visible control: nothing appears only on hover, and whatever Enter or Escape does also has a button. Fill the screen with `min-h-dvh`, never `h-screen`.

Choose the layout by what the widget is:

- **A single tool** (formatter, calculator, timer): one column, `max-w-2xl mx-auto`. On a wide screen it simply gets margins.
- **A list with details** (notes, ledger, to-dos): narrow, the list, and tapping an item opens its detail with a back button; from `md:` up, the list on the left and the detail on the right.
- **Dense data** (tables, boards, charts): narrow, cards, or the table scrolling inside its container, with charts stacked; from `md:` up, the full table and charts side by side.

## Colors follow the app's theme

ShuviX has eleven themes (GitHub, Nord, Dracula, Solarized and others, each light or dark), and the widget's page always carries the one the user picked, switching live when they change it. Color the interface only with these names: each adapts to every theme, so it needs no `dark:` counterpart. Never color it with Tailwind's own palette (`bg-white`, `text-neutral-900`, `bg-violet-600` …) or hex values: those look the same in every theme and clash with most of them.

| Purpose                                         | Class                                                  |
| ----------------------------------------------- | ------------------------------------------------------ |
| Page background                                 | `bg-page`                                              |
| Surface / card                                  | `bg-surface`                                           |
| Control on a surface (input, segmented button)  | `bg-raised`                                            |
| Hover                                           | `hover:bg-hover`                                       |
| Selected or pressed row                         | `bg-active`                                            |
| Border / divider inside a card                  | `border-line` / `border-line-subtle`                   |
| Text primary / secondary / muted                | `text-fg` / `text-fg-muted` / `text-fg-subtle`         |
| Accent text, icon or link                       | `text-accent`                                          |
| Accent solid (the main button)                  | `bg-accent hover:bg-accent-hover text-on-accent`       |
| Accent tint (selected item, badge)              | `bg-accent-muted`                                      |
| Focus                                           | `focus:ring-2 focus:ring-accent/30 focus:border-accent` |
| Success / error / warning                       | `text-success` / `text-danger` / `text-warning`; a tinted box `bg-danger/10` |

Opacity modifiers work on all of them (`bg-accent/20`). Inputs, buttons and output blocks share one look: `rounded-md`, `text-xs` / `text-sm`, `bg-raised` (or `bg-page` on a surface) with `border border-line`, and the focus ring above on inputs.

**Charts and categories** use the series colors of ShuviX's own figures, in order and never cycled: `viz-1` … `viz-8` (`bg-viz-2`; on SVG `fill-viz-2` / `stroke-viz-2`). A labelled category box is `bg-viz-2-tint text-viz-2-ink`; a metric tile or table header one step above the surface is `bg-viz-wash`. A status shown by color in a chart still needs an icon or a word beside it.

**Code that needs a color as a value** (a `<canvas>`, a chart library's options): `themeColor(name)` from `shuvix/widget` returns the current color (`rgb(…)`) of any name above, and `useTheme()` re-renders the component when the theme changes:

```tsx
import { themeColor, useTheme } from 'shuvix/widget'

const theme = useTheme() // { id: 'nord', scheme: 'dark' }
const colors = useMemo(() => ({ line: themeColor('viz-1'), grid: themeColor('line-subtle') }), [theme])
```

In a `.css` file the same names are variables: `var(--widget-accent)`, `var(--widget-line)`.

`dark:` still works and follows the dark or light side of the current theme (not the system setting). Keep it for the rare thing the names cannot cover, such as `dark:invert` on a black-on-white image.

## Assets

- Images that ship with the widget live in its directory and are imported (`import logo from './logo.svg'`): `.svg`, `.png`, `.jpg` and `.gif` become inline data URLs, so keep them small. Other image formats do not import; read them from disk through `fs/file` instead (`files.md`).
- Fixed data that ships with the widget can be imported too: `.json` as a parsed value, `.txt` as a string.
- Styles go in `className`. A `.css` file imported from a component is bundled too, for what Tailwind cannot express.

## Check it

After a green build, `preview` it. It renders the widget in a hidden window, so nothing opens on the user's screen, at the three sizes above: `panel` (380×760), `window` (1280×800) and `phone` (390×780, touch), and returns the screenshots and any errors the page logged. Look at every image and fix what looks wrong at that size: text clipped or overlapping, a line stretched across the window, controls too small to tap, an empty area where content should be, a horizontal scrollbar on the page. Then build and preview again.

- `sizes: ["phone", "panel"]` previews only those sizes; `theme: "light"` or `"dark"` shows the user's light or dark theme (by default the one the app shows now). Check the other side once: a color written outside the theme names shows up there.
- It shows the last build: build before every preview.
