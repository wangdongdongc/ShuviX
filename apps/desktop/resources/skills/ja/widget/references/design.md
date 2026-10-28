# Design guide — follow it strictly

Widgets are dense, single-purpose utilities: think menu-bar app or extension popup, not a landing page.

- **Layout**: open straight into the working UI and fill the viewport (`p-3` or `p-4`; widths as in "Where it runs"); no hero, welcome title, "Get Started" button or onboarding. Stack vertically; use `grid` / `flex-row` only for genuinely columnar data.
- **Typography**: body `text-xs` or `text-sm`, nothing above `text-base`; `font-medium` / `font-semibold`, not `font-bold`; code, data and their inputs in `font-mono text-xs`.
- **Spacing**: padding `p-2.5`–`p-4`, gaps `gap-1.5`–`gap-3`, margins `mt-1`–`mt-4`.
- **Decoration**: `rounded-md` or `rounded-lg`; no shadow except `shadow-sm` on popovers; no gradients, `border-2` or nested cards; `transition-colors` only.
- **Interaction**: Enter runs or submits, Escape clears; derive results as the user types (`useMemo` / `useDeferredValue`), no spinner for local work; an icon-only copy button on generated output; errors inline under the field in rose, never in a modal.
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

## Dark mode is mandatory

Every color utility has its `dark:` counterpart. Use this palette:

| Purpose         | Light                                               | Dark                        |
| --------------- | --------------------------------------------------- | --------------------------- |
| Page background | `bg-white`                                          | `dark:bg-neutral-950`       |
| Surface / card  | `bg-neutral-50`                                     | `dark:bg-neutral-900`       |
| Hover surface   | `hover:bg-neutral-100`                              | `dark:hover:bg-neutral-800` |
| Border          | `border-neutral-200`                                | `dark:border-neutral-800`   |
| Text primary    | `text-neutral-900`                                  | `dark:text-neutral-100`     |
| Text secondary  | `text-neutral-600`                                  | `dark:text-neutral-400`     |
| Text muted      | `text-neutral-400`                                  | `dark:text-neutral-500`     |
| Accent text     | `text-violet-600`                                   | `dark:text-violet-400`      |
| Accent solid    | `bg-violet-600 hover:bg-violet-500 text-white`      | same                        |
| Accent ring     | `ring-violet-500/30` with `focus:border-violet-500` | same                        |
| Success         | `text-emerald-600`                                  | `dark:text-emerald-400`     |
| Error           | `text-rose-600`                                     | `dark:text-rose-400`        |
| Warning         | `text-amber-600`                                    | `dark:text-amber-400`       |

Inputs, buttons and output blocks share it: `rounded-md`, `text-xs` / `text-sm`, the surface and border colors above, and `focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500` on inputs.

## Assets

- Images that ship with the widget live in its directory and are imported (`import logo from './logo.svg'`): `.svg`, `.png`, `.jpg` and `.gif` become inline data URLs, so keep them small. Other image formats do not import; read them from disk through `fs/file` instead (`files.md`).
- Fixed data that ships with the widget can be imported too: `.json` as a parsed value, `.txt` as a string.
- Styles go in `className`. A `.css` file imported from a component is bundled too, for what Tailwind cannot express.

## Check it

After a green build, `preview` it. It renders the widget in a hidden window, so nothing opens on the user's screen, at the three sizes above: `panel` (380×760), `window` (1280×800) and `phone` (390×780, touch), and returns the screenshots and any errors the page logged. Look at every image and fix what looks wrong at that size: text clipped or overlapping, a line stretched across the window, controls too small to tap, an empty area where content should be, a horizontal scrollbar on the page. Then build and preview again.

- `--size phone,panel` previews only those sizes; `--theme light` or `--theme dark` forces a color scheme (by default it follows the app). Check the other scheme once, since dark mode is mandatory.
- It shows the last build: build before every preview.
