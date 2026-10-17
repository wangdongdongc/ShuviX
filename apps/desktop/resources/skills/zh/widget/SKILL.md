---
name: widget
description: "如何构建、修改、导出和调试 ShuviX 小组件（widget）—— 用户从「Widget 面板」反复打开、各自在独立窗口里运行的常驻 React 小应用：`shuvix widget` CLI 的生命周期、封闭的依赖集、把记录存进小组件自己的数据库、以从浏览器使用 ShuviX 时也能工作的方式读取用户电脑上的文件、设计指南，以及改造旧的小组件。用户要一个 widget、mini app、小工具或小组件，或者一个会反复回来用的小工具时加载它；修改或调试已有的小组件之前也要加载。"
---

# ShuviX 小组件

小组件（widget）是一个小型 React 应用，放在 ShuviX 的 widgets 文件夹下属于它自己的目录里。ShuviX 负责打包它、在 `/w/<id>/` 下提供服务。右侧面板的「Widget」标签页是一块摆着应用图标的主屏：点图标就在面板里打开这个小组件，用户也可以把它移到独立窗口（远程使用 ShuviX 时是一个浏览器标签页）。每个小组件有自己的数据库 schema 和自己的 git 仓库。每次构建成功后 ShuviX 都会记录一次提交，所以你从不自己运行 git。

本文件就是完整的工作流程。细节在参考文件里；文末索引的每一行都写明了什么时候读哪一份。

## 什么时候该做小组件

- 用户管它叫 widget、mini app、小工具或小组件，或者想要一个会反复打开的小工具：格式化器、转换器、追踪器、基于自己文件的仪表盘。一次性的问题给一个答案或一个脚本，不做小组件。
- 一个用途一个小组件。对已有小组件的改动就是改那个小组件，绝不另做一个。

## 始终成立的规矩

1. **生命周期一律走 `shuvix` CLI**，ShuviX 启动的每个 shell 里它都在 PATH 上。`shuvix widget build` 是唯一的构建：绝不安装包，绝不运行 npm、npx 或打包器。
2. **封闭的依赖集**：React 19 加 TypeScript，通过 `className` 使用的 Tailwind CSS v4（`dark:` 跟随应用主题），以及只在确实是多页面的小组件里使用的 React Router（`react-router` 的 `createHashRouter`）。别的都解析不了；未知的 import 会让构建失败。图标用内联 SVG，HTTP 用 `fetch`，日期用 `Intl` 和 `Date`。
3. **`index.tsx` 以挂载块结尾**，放在脚手架的 "DO NOT DELETE" 注释之内：
   ```tsx
   const root = document.getElementById('root')
   if (root) createRoot(root).render(<App />)
   ```
4. **只待在小组件自己的目录（`projectDir`）里。** 绝不编辑或删除 `widget.json`：它是小组件的身份，ShuviX 会自己重写它。
5. **小组件 fetch 的一切都在它自己的 `/w/<id>/` 下**：`db/<table>` 是它的记录（`references/data.md`），`fs/file` 和 `fs/list` 是用户电脑上的文件（`references/files.md`）。绝不写 `shuvix-media://`、`file://` 或 `http://127.0.0.1:<port>`：它们只在桌面端有效，小组件从浏览器打开时就坏了。
6. **持久状态放进数据库**，不放 `localStorage`、`IndexedDB` 或 cookie：从浏览器打开时小组件运行在沙箱里、没有自己的源（origin），这些都不可用。
7. **从 320px 宽起就要能用。** 小组件多半在右侧面板里打开，面板通常只有 300–400px 宽。**暗色模式是必须的。** 这两条和其余外观要求都在 `references/design.md`：写 UI 之前先读它。
8. **绝不汇报一个没构建成功的小组件。** 以一次绿色构建收尾，然后 `shuvix widget open <id>`。

## 新建小组件

1. **Id**：小写 ASCII kebab-case，至少带一个连字符（`/^[a-z0-9]+(-[a-z0-9]+)+$/`），例如 `json-formatter`，不管用户用什么语言。**`name` 和 `description`** 用用户的语言写；它们会原样显示在小组件的卡片和窗口标题上。
2. `shuvix widget init <id> --name "…" --description "…"`。在返回的 `projectDir` 下工作；入口文件是 `index.tsx`。
3. **写代码之前**，先决定它是否存储记录（`references/data.md`；如果存，现在就写好并安装 `schema.sql`），以及它是否读取用户的文件（`references/files.md`）。
4. 按 `references/design.md` 实现它，并画出它在主屏上的图标 `icon.svg`（同一份文件的「图标」一节）。
5. 用 `name` 的语言写一份简短的 `README.md`：它做什么、主要交互、数据模型、读取哪些文件、扩展点。
6. `shuvix widget build <id> --message "<one-line summary>"`。遇到 `buildSuccess: false` 就修好 `buildErrors` 再构建。
7. `shuvix widget open <id>`，然后汇报。

## 修改已有的小组件

1. 用 `shuvix widget list` 找到它的 id 和 `projectDir`。
2. **动任何东西之前**先 `shuvix widget build <id> --message "chore: baseline before <task>"`：它能看出这个小组件能否构建，给本次对话访问它目录的权限，并且（构建成功时）把目录里已有的东西提交掉，让你的改动落成一个独立的提交。
3. 读 `README.md` 和你要改的每一个文件，遵循它们的约定。本技能出现之前写的小组件，可能需要的不止你被要求的那处改动：读 `references/maintenance.md`。
4. 用有针对性的 `edit` 来改，并在 README 的更新日志里加一行，用 README 的语言。
5. `shuvix widget build <id> --message "<what changed>"`，修掉所有错误，然后 `shuvix widget open <id>` 并汇报。

绝不重命名、改作他用、归档或删除用户没问到的小组件。

## 汇报

只回复结果，几行即可：

```
json-formatter ("JSON 格式化") — formats and validates pasted JSON, with error position and copy button. Stateless. Window opened.
```

只有真正的偏离才加一行：你没能构建或实现的东西，或者你不得不打破的一条设计规矩。绝不贴源代码。

## 参考

| 读                              | 什么时候                                                        |
| ------------------------------- | --------------------------------------------------------------- |
| `references/cli.md`             | 你需要某个命令的确切选项、输出字段或错误                        |
| `references/data.md`            | 小组件要存储记录：`schema.sql`、REST API、修改表                |
| `references/files.md`           | 小组件要读取或列出用户电脑上的文件                              |
| `references/design.md`          | 写 UI 或重做样式之前                                            |
| `references/maintenance.md`     | 修改已有的小组件，尤其是本技能出现之前写的                      |
| `references/export.md`          | 用户想把小组件拿成一个独立项目                                  |
| `references/troubleshooting.md` | 构建失败、窗口空白或显示错误、找不到 `shuvix`、某个 fetch 失败 |
