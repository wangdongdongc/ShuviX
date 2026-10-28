---
name: widget
description: "如何构建、修改、导出和调试 ShuviX 小组件（widget）—— 用户从「Widget 面板」反复打开的 React 小应用，每个都有自己的 SQLite 数据库，以及一套由它的界面和智能体共用的 API：widget 工具的构建类动作、在 api.ts 里定义 API、在界面里用 shuvix/widget 调用它、封闭的依赖集、以从浏览器使用 ShuviX 时也能工作的方式读取用户电脑上的文件、面板、宽窗口和手机三处的设计指南、用截图检查排版，以及升级旧的小组件。用户要一个 widget、mini app、小工具或小组件，或者一个会反复回来用的小工具时加载它；修改或调试已有的小组件之前也要加载。"
---

# ShuviX 小组件

小组件（widget）是一个小型 React 应用，放在 ShuviX 的 widgets 文件夹下属于它自己的目录里。ShuviX 负责打包它、在 `/w/<id>/` 下提供服务。用户在右侧面板的「Widget」标签页里打开它，它在面板里运行，或者在独立窗口里（远程使用 ShuviX 时是一个浏览器标签页）。

存储记录的小组件有一套 **API**：在它的 `api.ts` 里定义的操作，在 ShuviX 这一侧针对小组件自己的 SQLite 数据库运行。它的界面只通过这些操作读写，智能体则用 `widget` 工具的 `call` 调用同样的操作 —— 所以同一件事无论谁来做，效果都相同，而且智能体写入时，打开着的界面会刷新。每个小组件还有自己的 git 仓库；每次构建成功后 ShuviX 都会提交，所以你从不自己运行 git。

本文件就是完整的工作流程。细节在参考文件里；文末索引的每一行都写明了什么时候读哪一份。

## 什么时候该做小组件

- 用户管它叫 widget、mini app、小工具或小组件，或者想要一个会反复打开的小工具：格式化器、转换器、追踪器、基于自己文件的仪表盘。一次性的问题给一个答案或一个脚本，不做小组件。
- 一个用途一个小组件。对已有小组件的改动就是改那个小组件，绝不另做一个。

## 始终成立的规矩

1. **构建一律走 `widget` 工具**（`create`、`build`、`preview`、`sql`、`export`、`open`；`references/tool.md`）。`build` 是唯一的构建：绝不安装包，绝不运行 npm、npx 或打包器，绝不在小组件里运行 git。
2. **封闭的依赖集。** 界面：React 19 加 TypeScript，通过 `className` 使用的 Tailwind CSS v4（`dark:` 跟随应用主题），只在确实是多页面的小组件里使用的 React Router（`react-router` 的 `createHashRouter`），以及用来调用 API 的 `shuvix/widget`。`api.ts`：`shuvix/widget-api` 和 `zod`。别的都解析不了；未知的 import 会让构建失败。图标用内联 SVG，日期用 `Intl` 和 `Date`。
3. **`index.tsx` 以挂载块结尾**，放在脚手架的 "DO NOT DELETE" 注释之内：
   ```tsx
   const root = document.getElementById('root')
   if (root) createRoot(root).render(<App />)
   ```
4. **只待在小组件自己的目录里。** 绝不编辑或删除 `widget.json`：它是小组件的身份，ShuviX 会自己重写它。
5. **记录存在小组件的数据库里，只通过它的 API 改动**（`references/api.md`、`references/data.md`）。界面用 `shuvix/widget` 的 `createClient` 调用 API；它通过 `fs/file` 和 `fs/list` 读取用户电脑上的文件（`references/files.md`）。绝不写 `shuvix-media://`、`file://` 或 `http://127.0.0.1:<port>`：它们只在桌面端有效，小组件从浏览器打开时就坏了。
6. **持久状态放进数据库**（通过一个操作），不放 `localStorage`、`IndexedDB` 或 cookie：从浏览器打开时小组件运行在沙箱里、没有自己的源（origin），这些都不可用。
7. **在面板、宽窗口和手机上都要能用。** 同一个小组件会在右侧面板（300–420px 宽）、它自己的窗口或浏览器标签页（可能全屏）以及手机浏览器（触屏）里打开。**暗色模式是必须的。** 怎么为这三处排版，以及其余外观要求，都在 `references/design.md`：写 UI 之前先读它。
8. **绝不汇报一个没构建成功的小组件。** 以一次绿色构建收尾。**不要替用户打开它**：告诉用户它已经在 Widget 面板里，说出它的名字。小组件在哪里开着，构建就会让它在哪里自动刷新。只有用户要你打开时才用 `open`。

## 新建小组件

1. **Id**：小写 ASCII kebab-case，至少带一个连字符（`/^[a-z0-9]+(-[a-z0-9]+)+$/`），例如 `json-formatter`，不管用户用什么语言。**`name` 和 `description`** 用用户的语言写；它们会原样显示在小组件的卡片和窗口标题上。
2. 用 `create`，带上 `widget`、`name` 和 `description`。在它返回的文件夹里工作；入口文件是 `index.tsx`。本次对话从此可以修改并使用这个小组件。
3. **写代码之前**，先决定它是否存储记录。如果存，写好 `schema.sql` 并用 `sql` 建表（`references/data.md`），然后写 `api.ts`（`references/api.md`）。再决定它是否读取用户的文件（`references/files.md`）。
4. 按 `references/design.md` 实现界面。
5. 用 `name` 的语言写一份简短的 `README.md`：它做什么、主要交互、它的操作和表、读取哪些文件、扩展点。
6. 用 `build`，带一行 `message`。失败了就修好它报出的问题再构建。然后用 `call` 加 `dry_run: true` 把每个操作试一遍（`references/api.md` 的「测试」）。
7. 用 `preview` 并查看截图；修改、构建、再预览，直到每个尺寸都没问题（`references/design.md` 的「检查」）。
8. 汇报它已经在 Widget 面板里（规则 8）。

## 修改已有的小组件

1. 用 `list` 找到它的 id 和文件夹。
2. **动任何东西之前**先用 `build`，带上 `message: "chore: baseline before <task>"`。在一次对话里第一次这样做时，它会请用户允许修改这个小组件；获准之后，这个文件夹就归你编辑。它能看出这个小组件能否构建，并且（构建成功时）把已有的东西提交掉，让你的改动落成一个独立的提交。
3. 读 `README.md`、`api.ts` 和你要改的每一个文件，遵循它们的约定。没有 `api.ts`、却读写 `/db/…` 的小组件早于 API：读 `references/maintenance.md`。
4. 用有针对性的 `edit` 来改，并在 README 的更新日志里加一行，用 README 的语言。没被要求就不要重命名或删除操作：别的会话和用户的 bot 可能在用它。
5. 用 `build`，`message` 写改了什么，修掉所有错误；有操作消失或者它的输入变了时，`build` 会给出警告。如果改了它的样子，用 `preview` 预览一次。然后汇报（规则 8）。

绝不重命名、改作他用、归档或删除用户没问到的小组件。

## 汇报

只回复结果，几行即可：

```
reading-list ("读书清单") — books the user wants to read, is reading or finished, with notes. 4 operations agents can call (listBooks, addBook, setStatus, addNote). Ready in the Widget panel.
```

只有真正的偏离才加一行：你没能构建或实现的东西，或者你不得不打破的一条设计规矩。绝不贴源代码。

## 参考

| 读                              | 什么时候                                                       |
| ------------------------------- | -------------------------------------------------------------- |
| `references/tool.md`            | 你需要某个动作的确切参数、结果或错误                           |
| `references/api.md`             | 小组件要存储记录：写 `api.ts`、在界面里调用它、测试操作        |
| `references/data.md`            | 表：SQLite 方言的 `schema.sql`、修改表、查看数据               |
| `references/files.md`           | 小组件要读取或列出用户电脑上的文件                             |
| `references/design.md`          | 写 UI 或重做样式之前                                           |
| `references/maintenance.md`     | 修改已有的小组件，尤其是在它的 API 出现之前写的                |
| `references/export.md`          | 用户想把小组件拿成一个独立项目                                 |
| `references/troubleshooting.md` | 构建失败、窗口空白或显示错误、某个操作或 fetch 失败            |
