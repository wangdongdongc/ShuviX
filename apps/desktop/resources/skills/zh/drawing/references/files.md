# 把图存成文件

回复里的 ```svg 围栏，颜色和字体都由 ShuviX 提供：每一个 `var(--viz-…)` / `var(--theme-…)` 都是应用定义的，图因此能跟着主题走。`.svg` 文件却是在别处打开的 —— 浏览器、Markdown 预览、文档、别的应用 —— 那里没有这些 token：填色退回黑色，描边消失，文字变成黑色的衬线体。所以文件要自带定义。

只要你把图写成 `.svg` 文件，这一页就适用：用户让你保存下来，或者图要放进他的项目、某篇笔记里。用 `artifact` 认领的图留在 ShuviX 里显示，不需要这些 —— 直到你把它另存成一个独立的文件。

## 和围栏相比，变的只有这几处

1. **根上加 `xmlns="http://www.w3.org/2000/svg"`。** 文件按 XML 解析，没有这个命名空间它就根本不是 SVG，显示出来是一张破图。
2. **文字按 XML 转义** —— `&` 写 `&amp;`，`<` 写 `&lt;`。围栏容得下一个裸 `&`，文件里有一个就整张渲染不出来。
3. **把下面这段原样放在 `<svg …>` 开标签的下一行，整段照抄。** 它给契约里列的每一个 token 定义了浅色和深色两档取值，外加一块底色 —— 顶替回复里图下面那张卡片（所以根节点自己照旧不铺底色）。看的人用深色时取深色档。整段都抄，不要只抄你用到的那几行 —— 少一行就是一个悄悄变黑的形状。
4. **其余的和围栏一字不差。** 每一个 `var(--…)` 都留着，不要换成十六进制。文件的每一行就是围栏的每一行加上这一段，于是同一张图照样能在回复里画出来，照样用 `edit` 改。

这是一张图唯一可以带的 `<style>`，而且只在文件里。```svg 围栏照旧不写：在那里它会被剥掉，用的是应用自己的 token。

## 这一段

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

## 一个完整的文件

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 128" role="img" aria-label="各档请求量：免费 1,840，团队 960，企业 410">
  <style>
    …上面那一段，整段…
  </style>
  <g font-family="var(--theme-font-sans)" font-size="11" text-anchor="end" fill="var(--theme-text-secondary)">
    <text x="100" y="32" dominant-baseline="central">免费</text>
    …图的其余部分，和围栏里逐行一致…
  </g>
</svg>
```
