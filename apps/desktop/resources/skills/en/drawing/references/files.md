# Saving a figure as a file

A ```svg fence in your reply takes its colors and font from ShuviX: every `var(--viz-…)` / `var(--theme-…)` is defined by the app, which is what lets the figure follow the theme. A `.svg` file is opened somewhere else — a browser, a Markdown preview, a document, another app — where none of those tokens exist: fills fall back to black, strokes disappear, text turns into black serif. So a file carries its own definitions.

This applies whenever you write a figure to a `.svg` file: the user asked you to save it, or it goes into their project or a note. A figure you `artifact` adopt stays inside ShuviX and needs none of this — until you copy it out to a file of its own.

## What changes from a fence

1. **`xmlns="http://www.w3.org/2000/svg"` on the root.** A file is parsed as XML; without the namespace it is not an SVG at all and shows as a broken image.
2. **Text escaped for XML** — `&` as `&amp;`, `<` as `&lt;`. A fence forgives a bare `&`; a file with one does not render at all.
3. **The block below, right after the opening `<svg …>` tag, copied whole.** It defines every token the contract lists, with a light and a dark value, plus a background standing in for the card the figure sits on in a reply (so the root itself still gets no fill). A viewer set to dark gets the dark values. Copy all of it, not only the tokens you used — a missing line is a shape that silently turns black.
4. **Everything else exactly as in the fence.** Keep every `var(--…)`; do not swap in hex. The file's lines are the fence's lines plus the block, so the same figure still renders in a reply and is still edited with `edit`.

This block is the only `<style>` a figure carries, and only in a file. A ```svg fence still has none: it would be stripped there, and the app's own tokens apply.

## The block

```xml
<style>
  svg {
    color-scheme: light dark;
    background: light-dark(#f2f5f7, #191e24);
    --theme-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Ubuntu', 'Cantarell', 'Noto Sans', sans-serif;
    --theme-text-primary: light-dark(#1f2328, #e6edf3);
    --theme-text-secondary: light-dark(#656d76, #8b949e);
    --theme-text-tertiary: light-dark(#8b949e, #6e7681);
    --theme-bg-secondary: light-dark(#f6f8fa, #161b22);
    --theme-bg-tertiary: light-dark(#eaeef2, #21262d);
    --theme-border-primary: light-dark(#d0d7de, #30363d);
    --viz-1: light-dark(#2a78d6, #3987e5);
    --viz-2: light-dark(#eb6834, #d95926);
    --viz-3: light-dark(#1baf7a, #199e70);
    --viz-4: light-dark(#eda100, #c98500);
    --viz-5: light-dark(#e87ba4, #d55181);
    --viz-6: light-dark(#008300, #008300);
    --viz-7: light-dark(#4a3aa7, #9085e9);
    --viz-8: light-dark(#e34948, #e66767);
    --viz-seq-1: light-dark(#86b6ef, #184f95);
    --viz-seq-2: light-dark(#5598e7, #256abf);
    --viz-seq-3: light-dark(#2a78d6, #3987e5);
    --viz-seq-4: light-dark(#1c5cab, #6da7ec);
    --viz-seq-5: light-dark(#104281, #9ec5f4);
    --viz-mid: light-dark(#f0efec, #383835);
    --viz-good: #0ca30c;
    --viz-warn: #fab219;
    --viz-serious: #ec835a;
    --viz-critical: #d03b3b;
    --viz-grid: light-dark(rgba(31, 35, 40, 0.1), rgba(230, 237, 243, 0.12));
    --viz-axis: light-dark(rgba(31, 35, 40, 0.28), rgba(230, 237, 243, 0.3));
    --viz-1-tint: color-mix(in srgb, var(--viz-1) 14%, transparent);
    --viz-2-tint: color-mix(in srgb, var(--viz-2) 14%, transparent);
    --viz-3-tint: color-mix(in srgb, var(--viz-3) 14%, transparent);
    --viz-4-tint: color-mix(in srgb, var(--viz-4) 14%, transparent);
    --viz-5-tint: color-mix(in srgb, var(--viz-5) 14%, transparent);
    --viz-6-tint: color-mix(in srgb, var(--viz-6) 14%, transparent);
    --viz-7-tint: color-mix(in srgb, var(--viz-7) 14%, transparent);
    --viz-8-tint: color-mix(in srgb, var(--viz-8) 14%, transparent);
    --viz-1-ink: color-mix(in srgb, var(--viz-1) 40%, light-dark(#000, #fff));
    --viz-2-ink: color-mix(in srgb, var(--viz-2) 40%, light-dark(#000, #fff));
    --viz-3-ink: color-mix(in srgb, var(--viz-3) 40%, light-dark(#000, #fff));
    --viz-4-ink: color-mix(in srgb, var(--viz-4) 40%, light-dark(#000, #fff));
    --viz-5-ink: color-mix(in srgb, var(--viz-5) 40%, light-dark(#000, #fff));
    --viz-6-ink: color-mix(in srgb, var(--viz-6) 40%, light-dark(#000, #fff));
    --viz-7-ink: color-mix(in srgb, var(--viz-7) 40%, light-dark(#000, #fff));
    --viz-8-ink: color-mix(in srgb, var(--viz-8) 40%, light-dark(#000, #fff));
    --viz-wash: color-mix(in srgb, var(--theme-text-primary) 5%, transparent);
  }
</style>
```

## A file, start to finish

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 128" role="img" aria-label="Requests by plan: Free 1,840, Team 960, Enterprise 410">
  <style>
    …the block above, whole…
  </style>
  <g font-family="var(--theme-font-sans)" font-size="11" text-anchor="end" fill="var(--theme-text-secondary)">
    <text x="100" y="32" dominant-baseline="central">Free</text>
    …the rest of the figure, line for line as in the fence…
  </g>
</svg>
```
