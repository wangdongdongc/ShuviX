# 修改已有的小组件

## 找到它

- `list` 给出 id、文件夹，以及本次对话能对它做什么。已归档的小组件不会被列出：告诉用户先从「设置 → 已归档」恢复它。
- 如果它的文件夹存在、却没被列出，说明它的 `widget.json` 缺失或损坏：如实汇报，不要去修。
- 请求对得上不止一个小组件（widget）时，问用户指的是哪个。

## 第一次编辑之前

用 `build`，带上 `message: "chore: baseline before <task>"`：

- 在一次对话里第一次这样做时，它会请用户允许本次对话修改这个小组件；获准之后，你也可以编辑它的文件夹；
- 它告诉你这个小组件按现状能否构建，这样你不会替一个本来就存在的故障背锅；
- 构建成功时，它把文件夹里已有的东西提交掉（用户自己的编辑、之前某个会话做了一半的工作），让你的改动落成一个独立的提交。早于版本管理的小组件会在这里得到它的仓库。

如果这次构建失败，就什么都不会提交，说明小组件本来就是坏的。只有用户要求修、或者不修你的改动就落不下来时，修它才是任务的一部分；否则就说明这一点。

然后读 `README.md`、`api.ts` 和你要改的每一个文件，遵循它们的约定：命名、文件布局、状态怎么保存。

## 做改动

- 有针对性的 `edit`，不要重写。保留挂载块和它的 "DO NOT DELETE" 注释。
- 操作：新的随便加；已有的只在被要求时才改或删（`api.md`）。表的改动遵循 `data.md`。
- 在 README 的更新日志里加一行，用 README 的语言。
- 用 `build`，`message` 写改了什么；用 `call` 加 `dry_run: true` 调一遍你改过的东西；外观变了就 `preview`。不要替用户打开它（`SKILL.md` 规则 8）。

## API 出现之前写的小组件

旧的小组件没有 `api.ts`：它的界面直接读写 `/w/<id>/db/<table>`，它的数据在一个所有旧小组件共用的数据库里，智能体也用不了它（`list` 显示 `storage="legacy-postgres"`）。用户要求更新这样的小组件，或者你的改动碰到它的数据时，升级它：

1. **基线构建**，同上。
2. **读它的表**，用 `sql` 加 `legacy: true`：`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`，再看看每张表的几行。
3. **一次写好新版本**：SQLite 方言的 `schema.sql`（`data.md`）；`api.ts`，为界面原先通过 `/db` 做的每件事提供操作（`api.md`）；以及改写成用 `shuvix/widget` 调用这些操作的界面（每一处 `fetch('/w/<id>/db/…')` 都要去掉）。
4. **`build`。** 带 `api.ts` 的小组件第一次构建成功时，会被移到它自己的 SQLite 数据库，这个数据库一开始是空的；结果里会说明这一点。构建失败的话，什么都没移：修好再构建。
5. **建表**：用 `sql`，传入 `schema.sql` 的文本。
6. **复制数据行**，一张表一张表地来：用 `sql`、`legacy: true` 和 `SELECT json_agg(t) FROM <table> t` 把它们读成 JSON，再用 `sql` 插入，例如 `INSERT INTO books (id, title, done) SELECT value->>'id', value->>'title', value->>'done' FROM json_each('<the JSON, with every ' doubled>')`。布尔值变成 `0` / `1`，时间戳变成 ISO 8601 文本，数组和对象变成 JSON 文本。大表分批处理。
7. **检查**：行数一致（两边各跑一次 `SELECT count(*) …`），操作能用（`call`），界面能显示数据（`preview`）。
8. 汇报你转换了什么。旧数据会一直留在共享数据库里，直到这个小组件被删除，所以第 6 步出了错可以重做。

从浏览器打开 ShuviX 时会坏掉的东西也要改到合规。在小组件的 `.ts` / `.tsx` 文件里搜索：

```
shuvix-media:|file://|127\.0\.0\.1|localhost:|localStorage|sessionStorage|indexedDB|document\.cookie
```

| 找到的                                                                | 改成                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `shuvix-media:///abs/path`（或构造成 `` `shuvix-media://${p}` ``）    | 来自同一个 URL 模块（`files.md`）的 `fileUrl('/abs/path')` / `fileUrl(p)`；里面的路径是 `shuvix-media://` 之后的部分，解码后使用 |
| `file:///…`                                                           | 同样的 `fileUrl(…)`                                                                                                        |
| `http://127.0.0.1:<port>/w/<id>/…` 或 `localhost:<port>`              | 只留路径：`/w/<id>/…`                                                                                                      |
| `localStorage` / `sessionStorage` / `IndexedDB` / cookie              | 一张表加一个操作（`api.md`）。没有要迁移的东西：小组件地址的端口在每次 ShuviX 启动时都会变，所以浏览器存储从来没活过一次重启 |
| README 里说设计规矩在 Widget Builder 智能体里的那一行                 | 改成一行说它们在内置技能 `builtin:widget` 里                                                                               |

硬编码的主文件夹（`/Users/<name>/…`）可以保留，但 `~/…` 更好（`files.md`）。

很多旧的小组件是按独立窗口的大小排版的。更新这样的小组件时，预览它，并让它在面板、宽窗口和手机上都能用（`design.md` 的「在哪里运行」）。

有主题之前写的小组件用 Tailwind 色板加成对的 `dark:` 上色。它们在浅色和深色下照样能用，但不理会用户选的主题。更新这样的小组件时，把颜色换成主题颜色名（`design.md` 的「颜色跟随应用的主题」）。搜索：

```
\b(bg|text|border|divide|ring|outline|fill|stroke|placeholder)-(white|black|(neutral|gray|slate|zinc|stone|violet|purple|indigo|emerald|rose|red|amber)-[0-9]+)|#[0-9a-fA-F]{3,8}\b
```

| 找到的                                                  | 换成                                              |
| ------------------------------------------------------- | ------------------------------------------------- |
| `bg-white dark:bg-neutral-950`                          | `bg-page`                                         |
| `bg-neutral-50 dark:bg-neutral-900`                     | `bg-surface`                                      |
| `hover:bg-neutral-100 dark:hover:bg-neutral-800`        | `hover:bg-hover`                                  |
| `border-neutral-200 dark:border-neutral-800`            | `border-line`                                     |
| `text-neutral-900 dark:text-neutral-100`                | `text-fg`                                         |
| `text-neutral-600 dark:text-neutral-400`                | `text-fg-muted`                                   |
| `text-neutral-400 dark:text-neutral-500`                | `text-fg-subtle`                                  |
| `text-violet-600 dark:text-violet-400`                  | `text-accent`                                     |
| `bg-violet-600 hover:bg-violet-500 text-white`          | `bg-accent hover:bg-accent-hover text-on-accent`  |
| `ring-violet-500/30`、`focus:border-violet-500`         | `ring-accent/30`、`focus:border-accent`           |
| `text-emerald-600 dark:text-emerald-400`（rose、amber） | `text-success`（`text-danger`、`text-warning`）   |
| 图表配置里的十六进制颜色                                | `themeColor('viz-1')` … 配合 `useTheme()`         |

其他色阶对到最接近的那一行。然后用 `theme: "light"` 和 `"dark"` 各 `preview` 一次：还写死的颜色会在其中一侧露出来。
