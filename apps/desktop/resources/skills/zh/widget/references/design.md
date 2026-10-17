# 设计指南 —— 严格遵守

小组件（widget）是紧凑、单一用途的工具：想想菜单栏应用或扩展的弹出窗口，而不是落地页。

## 宽度

小组件多半在 ShuviX 的右侧面板里打开，面板通常只有 300–400px 宽；用户可以把面板拉宽，或把小组件移到独立窗口。先按 320px 排版：

- 单栏；控件 `w-full`；不要超过 300px 的固定宽度。
- 宽表格或代码块在自己的容器里横向滚动（`overflow-x-auto`），不要让整页滚。
- 有余地时再用 `sm:` / `md:` 断点利用起来（第二栏、侧边列表）。

- **布局**：一打开就直接是工作界面，并填满视口（`max-w-3xl mx-auto`、`p-3` 或 `p-4`）；不要 hero 区、欢迎标题、"Get Started" 按钮或新手引导。纵向堆叠；只有真正成列的数据才用 `grid` / `flex-row`。
- **字体排印**：正文 `text-xs` 或 `text-sm`，不超过 `text-base`；用 `font-medium` / `font-semibold`，不用 `font-bold`；代码、数据和它们的输入框用 `font-mono text-xs`。
- **间距**：内边距 `p-2.5`–`p-4`，间隙 `gap-1.5`–`gap-3`，外边距 `mt-1`–`mt-4`。
- **装饰**：`rounded-md` 或 `rounded-lg`；除了弹出层上的 `shadow-sm` 之外不要阴影；不要渐变、`border-2` 或嵌套卡片；只用 `transition-colors`。
- **交互**：Enter 执行或提交，Escape 清空；随用户输入推导结果（`useMemo` / `useDeferredValue`），本地计算不显示加载转圈；生成的输出配一个只有图标的复制按钮；错误用 rose 色显示在字段下方，绝不用模态框。
- **从数据库或磁盘加载**：fetch 进行中时显示之前的内容（或者一个说明将会出现什么的空状态），绝不全屏转圈；fetch 失败时在原处显示它的 `message`，并提供重试。

## 暗色模式是必须的

每个颜色工具类都要有它的 `dark:` 对应项。用这套色板：

| 用途        | 浅色                                                | 暗色                        |
| ----------- | --------------------------------------------------- | --------------------------- |
| 页面背景    | `bg-white`                                          | `dark:bg-neutral-950`       |
| 表面 / 卡片 | `bg-neutral-50`                                     | `dark:bg-neutral-900`       |
| 悬停表面    | `hover:bg-neutral-100`                              | `dark:hover:bg-neutral-800` |
| 边框        | `border-neutral-200`                                | `dark:border-neutral-800`   |
| 主要文字    | `text-neutral-900`                                  | `dark:text-neutral-100`     |
| 次要文字    | `text-neutral-600`                                  | `dark:text-neutral-400`     |
| 弱化文字    | `text-neutral-400`                                  | `dark:text-neutral-500`     |
| 强调文字    | `text-violet-600`                                   | `dark:text-violet-400`      |
| 强调实色    | `bg-violet-600 hover:bg-violet-500 text-white`      | 相同                        |
| 强调光环    | `ring-violet-500/30` 配 `focus:border-violet-500`   | 相同                        |
| 成功        | `text-emerald-600`                                  | `dark:text-emerald-400`     |
| 错误        | `text-rose-600`                                     | `dark:text-rose-400`        |
| 警告        | `text-amber-600`                                    | `dark:text-amber-400`       |

输入框、按钮和输出块共用这套色板：`rounded-md`、`text-xs` / `text-sm`、上面的表面色和边框色，输入框上加 `focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500`。

## 图标

小组件目录里的 `icon.svg` 是它在 Widget 面板主屏上、以及它窗口标题栏里的图标。它是可选的：没有时，ShuviX 显示名字的第一个字，底色按 id 选定。

- 正方形 `viewBox="0 0 64 64"`，根元素带 `xmlns="http://www.w3.org/2000/svg"`。铺满整个正方形：圆角由 ShuviX 裁，不要自己画圆角背景或边框。
- 一个在 16px 下也认得出的简单图形。不要文字。
- 颜色用主题 token，图标才会跟着应用主题走：背景用 `var(--viz-1)` … `var(--viz-8)` 或对应的 `var(--viz-N-tint)`，图形用 `var(--theme-bg-primary)` 或 `var(--viz-N-ink)`。`<style>`、`<script>`、`<foreignObject>` 和外部 `href` 在显示前会被剥掉。
- 避免用 `id`，因为所有图标都在同一个页面上；渐变确实需要时，用小组件 id 作前缀。
- 保持在 64 KB 以内。新画或改过的图标在下一次 `shuvix widget build` 之后出现在主屏上。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="var(--viz-3)"/>
<path d="M18 22h28M18 32h28M18 42h18" stroke="var(--theme-bg-primary)" stroke-width="5" stroke-linecap="round"/>
</svg>
```

## 资源

- 随小组件一起提供的图片放在它的目录里，并通过 import 引入（`import logo from './logo.svg'`）：`.svg`、`.png`、`.jpg` 和 `.gif` 会变成内联 data URL，所以要保持小。其他图片格式不能 import；改为通过 `fs/file` 从磁盘读取（`files.md`）。
- 随小组件提供的固定数据也可以 import：`.json` 得到解析后的值，`.txt` 得到字符串。
- 样式写在 `className` 里。组件里 import 的 `.css` 文件也会被打包，用于 Tailwind 表达不了的东西。
