# Design guide — follow it strictly

Widgets are dense, single-purpose utilities: think menu-bar app or extension popup, not a landing page.

## Width

The widget usually opens inside ShuviX's right panel, which is often 300–400px wide; the user can widen the panel or move the widget to its own window. Lay it out for 320px first:

- One column; controls `w-full`; no fixed width above 300px.
- A wide table or code block scrolls inside its own container (`overflow-x-auto`), never the whole page.
- Use extra room when it is there, with `sm:` / `md:` breakpoints (a second column, a side list).

- **Layout**: open straight into the working UI and fill the viewport (`max-w-3xl mx-auto`, `p-3` or `p-4`); no hero, welcome title, "Get Started" button or onboarding. Stack vertically; use `grid` / `flex-row` only for genuinely columnar data.
- **Typography**: body `text-xs` or `text-sm`, nothing above `text-base`; `font-medium` / `font-semibold`, not `font-bold`; code, data and their inputs in `font-mono text-xs`.
- **Spacing**: padding `p-2.5`–`p-4`, gaps `gap-1.5`–`gap-3`, margins `mt-1`–`mt-4`.
- **Decoration**: `rounded-md` or `rounded-lg`; no shadow except `shadow-sm` on popovers; no gradients, `border-2` or nested cards; `transition-colors` only.
- **Interaction**: Enter runs or submits, Escape clears; derive results as the user types (`useMemo` / `useDeferredValue`), no spinner for local work; an icon-only copy button on generated output; errors inline under the field in rose, never in a modal.
- **Loading from the database or the disk**: show the previous content (or an empty state that says what will appear) while a fetch is in flight, never a full-screen spinner; a failed fetch shows its `message` inline with a retry.

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

## Icon

`icon.svg` in the widget's directory is its icon on the Widget panel's home screen and in its window's title bar. It is optional: without it ShuviX shows the first letter of the name on a color picked from the id.

- A square `viewBox="0 0 64 64"` with `xmlns="http://www.w3.org/2000/svg"` on the root. Fill the whole square: ShuviX rounds the corners, so draw no rounded background or border of your own.
- One simple shape that still reads at 16px. No text.
- Colors from the theme tokens, so the icon follows the app theme: a background of `var(--viz-1)` … `var(--viz-8)` or the matching `var(--viz-N-tint)`, and the shape in `var(--theme-bg-primary)` or `var(--viz-N-ink)`. `<style>`, `<script>`, `<foreignObject>` and external `href`s are stripped before it is shown.
- Avoid `id`s, since every icon sits on the same page; if a gradient needs one, prefix it with the widget id.
- Keep it under 64 KB. The home screen picks up a new or changed icon after the next `shuvix widget build`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="var(--viz-3)"/>
<path d="M18 22h28M18 32h28M18 42h18" stroke="var(--theme-bg-primary)" stroke-width="5" stroke-linecap="round"/>
</svg>
```

## Assets

- Images that ship with the widget live in its directory and are imported (`import logo from './logo.svg'`): `.svg`, `.png`, `.jpg` and `.gif` become inline data URLs, so keep them small. Other image formats do not import; read them from disk through `fs/file` instead (`files.md`).
- Fixed data that ships with the widget can be imported too: `.json` as a parsed value, `.txt` as a string.
- Styles go in `className`. A `.css` file imported from a component is bundled too, for what Tailwind cannot express.
