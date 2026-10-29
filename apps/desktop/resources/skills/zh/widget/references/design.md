# 设计指南 —— 严格遵守

小组件（widget）是紧凑、单一用途的工具：想想菜单栏应用或扩展的弹出窗口，而不是落地页。

- **布局**：一打开就直接是工作界面，并填满视口（`p-3` 或 `p-4`；宽度见「在哪里运行」）；不要 hero 区、欢迎标题、"Get Started" 按钮或新手引导。纵向堆叠；只有真正成列的数据才用 `grid` / `flex-row`。
- **字体排印**：正文 `text-xs` 或 `text-sm`，不超过 `text-base`；用 `font-medium` / `font-semibold`，不用 `font-bold`；代码、数据和它们的输入框用 `font-mono text-xs`。
- **间距**：内边距 `p-2.5`–`p-4`，间隙 `gap-1.5`–`gap-3`，外边距 `mt-1`–`mt-4`。
- **装饰**：`rounded-md` 或 `rounded-lg`；除了弹出层上的 `shadow-sm` 之外不要阴影；不要渐变、`border-2` 或嵌套卡片；只用 `transition-colors`。
- **交互**：Enter 执行或提交，Escape 清空；随用户输入推导结果（`useMemo` / `useDeferredValue`），本地计算不显示加载转圈；生成的输出配一个只有图标的复制按钮；错误用 `text-danger` 显示在字段下方，绝不用模态框。
- **从 API 或磁盘加载**：请求进行中时显示之前的内容（或者一个说明将会出现什么的空状态），绝不全屏转圈（`api.use` 重新加载时会保留之前的 `data`）；失败时在原处显示它的 `message`，并提供重试。

## 在哪里运行

同一个小组件会在三个地方被使用，三处都要能用：

| 在哪里                                         | 宽度       | 输入方式    |
| ---------------------------------------------- | ---------- | ----------- |
| ShuviX 的右侧面板（从浏览器连上 ShuviX 时也是） | 300–420px  | 鼠标和键盘  |
| 它自己的窗口，或一个浏览器标签页，常常是最大化 | 800–1900px | 鼠标和键盘  |
| 手机浏览器                                     | 360–430px  | 触屏        |

小组件运行在自己的框架里，所以 Tailwind 的断点量的是它实际拿到的空间：即便在大屏幕上，面板也是窄的。不要去判断自己在哪里。宽度决定布局，输入方式决定尺寸。

1. **先按面板写。** 单栏，控件 `w-full`，不要超过 300px 的固定宽度，用上面那套紧凑的样子。宽表格或代码块在自己的容器里横向滚动（`overflow-x-auto`），不要让整页滚。
2. **宽屏是增强，不是拉伸。** 从 `md:` 起把空间用上：列表和详情并排、表格显示全部列、多一栏数字。同时限制宽度，别让一行字横跨最大化的窗口：单一工具 `max-w-2xl mx-auto`，双栏 `max-w-5xl mx-auto`。
3. **触屏只改尺寸，不改布局。** 用只在触屏上生效的 `pointer-coarse:` 变体，面板因此保持紧凑：输入框和下拉框 `pointer-coarse:text-base`（小于 16px 时，iOS 一聚焦输入框就会放大页面），按钮、开关和列表行 `pointer-coarse:min-h-10`。每个操作都要有看得见的控件：不要只在悬停时出现，Enter 或 Escape 能做的事也要有一个按钮。用 `min-h-dvh` 填满屏幕，不要用 `h-screen`。

按小组件是什么来选布局：

- **单一工具**（格式化、计算器、计时器）：单栏，`max-w-2xl mx-auto`。宽屏上只是多出两边的留白。
- **列表加详情**（笔记、记账、待办）：窄时是列表，点一项打开它的详情，带返回键；从 `md:` 起左边列表、右边详情。
- **数据密集**（表格、看板、图表）：窄时用卡片，或让表格在自己的容器里滚动，图表竖着排；从 `md:` 起显示完整表格，图表并排。

## 颜色跟随应用的主题

ShuviX 有十一套主题（GitHub、Nord、Dracula、Solarized 等，各分浅色和深色），小组件的页面始终带着用户选的那一套，用户一换就实时跟着换。界面只用下面这些颜色名：每个名字都适配所有主题，所以不用再配一个 `dark:`。不要用 Tailwind 自带的色板（`bg-white`、`text-neutral-900`、`bg-violet-600` …）或十六进制颜色给界面上色：它们在每套主题里都一样，和大多数主题都不搭。

| 用途                               | 类名                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| 页面背景                           | `bg-page`                                               |
| 表面 / 卡片                        | `bg-surface`                                            |
| 表面上的控件（输入框、分段按钮）   | `bg-raised`                                             |
| 悬停                               | `hover:bg-hover`                                        |
| 选中或按下的行                     | `bg-active`                                             |
| 边框 / 卡片内的分隔线              | `border-line` / `border-line-subtle`                    |
| 主要 / 次要 / 弱化文字             | `text-fg` / `text-fg-muted` / `text-fg-subtle`          |
| 强调色文字、图标或链接             | `text-accent`                                           |
| 强调色实心（主按钮）               | `bg-accent hover:bg-accent-hover text-on-accent`        |
| 强调色浅底（选中项、徽标）         | `bg-accent-muted`                                       |
| 焦点                               | `focus:ring-2 focus:ring-accent/30 focus:border-accent` |
| 成功 / 错误 / 警告                 | `text-success` / `text-danger` / `text-warning`；带底色的框 `bg-danger/10` |

它们都能加透明度修饰（`bg-accent/20`）。输入框、按钮和输出块用同一套外观：`rounded-md`、`text-xs` / `text-sm`、`bg-raised`（在表面上则用 `bg-page`）加 `border border-line`，输入框再加上面那个焦点环。

**图表和分类** 用 ShuviX 自己作图的那组系列色，按顺序取、不循环复用：`viz-1` … `viz-8`（`bg-viz-2`；SVG 上用 `fill-viz-2` / `stroke-viz-2`）。带文字的分类框用 `bg-viz-2-tint text-viz-2-ink`；比表面高一级的指标卡或表头用 `bg-viz-wash`。图表里用颜色表示的状态，旁边仍要有图标或文字。

**需要颜色值的代码**（`<canvas>`、图表库的配置）：`shuvix/widget` 的 `themeColor(name)` 返回上面任一名字此刻的颜色（`rgb(…)`），`useTheme()` 在主题变了时让组件重新渲染：

```tsx
import { themeColor, useTheme } from 'shuvix/widget'

const theme = useTheme() // { id: 'nord', scheme: 'dark' }
const colors = useMemo(() => ({ line: themeColor('viz-1'), grid: themeColor('line-subtle') }), [theme])
```

在 `.css` 文件里，同样的名字是变量：`var(--widget-accent)`、`var(--widget-line)`。

`dark:` 仍然可用，跟随的是当前主题的深浅（不是系统设置）。只把它留给这些名字覆盖不到的少数情况，比如白底黑图上的 `dark:invert`。

## 资源

- 随小组件一起提供的图片放在它的目录里，并通过 import 引入（`import logo from './logo.svg'`）：`.svg`、`.png`、`.jpg` 和 `.gif` 会变成内联 data URL，所以要保持小。其他图片格式不能 import；改为通过 `fs/file` 从磁盘读取（`files.md`）。
- 随小组件提供的固定数据也可以 import：`.json` 得到解析后的值，`.txt` 得到字符串。
- 样式写在 `className` 里。组件里 import 的 `.css` 文件也会被打包，用于 Tailwind 表达不了的东西。

## 检查

构建成功后用 `preview` 预览它。它在一个看不见的窗口里渲染小组件（用户屏幕上什么都不会打开），按上面三种尺寸各截一张图：`panel`（380×760）、`window`（1280×800）和 `phone`（390×780，触屏），并返回这些截图和页面报出的错误。查看每一张图，修掉在那个尺寸下不对的地方：文字被截断或重叠、一行横跨整个窗口、控件小到点不中、该有内容的地方是空的、整页出现横向滚动条。然后再构建、再预览。

- `sizes: ["phone", "panel"]` 只预览这几种尺寸；`theme: "light"` 或 `"dark"` 显示用户的浅色或深色主题（缺省是应用此刻显示的那套）。另一侧也看一次：写在主题颜色名之外的颜色会在那里露出来。
- 它显示的是上一次构建的结果：每次预览之前先构建。
