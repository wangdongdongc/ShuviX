# 设计指南 —— 严格遵守

小组件（widget）是紧凑、单一用途的工具：想想菜单栏应用或扩展的弹出窗口，而不是落地页。

- **布局**：一打开就直接是工作界面，并填满视口（`p-3` 或 `p-4`；宽度见「在哪里运行」）；不要 hero 区、欢迎标题、"Get Started" 按钮或新手引导。纵向堆叠；只有真正成列的数据才用 `grid` / `flex-row`。
- **字体排印**：正文 `text-xs` 或 `text-sm`，不超过 `text-base`；用 `font-medium` / `font-semibold`，不用 `font-bold`；代码、数据和它们的输入框用 `font-mono text-xs`。
- **间距**：内边距 `p-2.5`–`p-4`，间隙 `gap-1.5`–`gap-3`，外边距 `mt-1`–`mt-4`。
- **装饰**：`rounded-md` 或 `rounded-lg`；除了弹出层上的 `shadow-sm` 之外不要阴影；不要渐变、`border-2` 或嵌套卡片；只用 `transition-colors`。
- **交互**：Enter 执行或提交，Escape 清空；随用户输入推导结果（`useMemo` / `useDeferredValue`），本地计算不显示加载转圈；生成的输出配一个只有图标的复制按钮；错误用 rose 色显示在字段下方，绝不用模态框。
- **从数据库或磁盘加载**：fetch 进行中时显示之前的内容（或者一个说明将会出现什么的空状态），绝不全屏转圈；fetch 失败时在原处显示它的 `message`，并提供重试。

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

## 资源

- 随小组件一起提供的图片放在它的目录里，并通过 import 引入（`import logo from './logo.svg'`）：`.svg`、`.png`、`.jpg` 和 `.gif` 会变成内联 data URL，所以要保持小。其他图片格式不能 import；改为通过 `fs/file` 从磁盘读取（`files.md`）。
- 随小组件提供的固定数据也可以 import：`.json` 得到解析后的值，`.txt` 得到字符串。
- 样式写在 `className` 里。组件里 import 的 `.css` 文件也会被打包，用于 Tailwind 表达不了的东西。

## 检查

构建成功后运行 `shuvix widget preview <id>`。它在一个看不见的窗口里渲染小组件（用户屏幕上什么都不会打开），按上面三种尺寸各截一张图：`panel`（380×760）、`window`（1280×800）和 `phone`（390×780，触屏），并输出每张截图的路径和页面报出的错误。用 `read` 看每一张图，修掉在那个尺寸下不对的地方：文字被截断或重叠、一行横跨整个窗口、控件小到点不中、该有内容的地方是空的、整页出现横向滚动条。然后再构建、再预览。

- `--size phone,panel` 只预览这几种尺寸；`--theme light` 或 `--theme dark` 强制一种配色（缺省跟应用）。另一种配色也看一次，因为暗色模式是必须的。
- 它显示的是上一次构建的结果：每次预览之前先构建。
