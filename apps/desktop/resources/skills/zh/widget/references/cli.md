# `shuvix widget` CLI

每个命令成功时向 stdout 打印 JSON，失败时向 stderr 打印一条消息（退出码 0 / 1）；`db-query` 改为打印 psql 风格的表格。你传入的路径相对于你 shell 的当前目录解析。

| 命令                                                        | 作用                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `shuvix widget list`                                        | 活跃的小组件（widget）：`id`、`name`、`description`、`projectDir`、时间戳。`--archived` 改为列出已归档的。                                 |
| `shuvix widget init <id> --name "…" --description "…"`      | 为新小组件搭好脚手架并运行它的第一次构建。返回 `projectDir`、`url`、`files`、`buildSuccess`，以及可选的 `buildErrors`。                    |
| `shuvix widget build <id> [--message "…"]`                  | 编辑之后重新构建。返回 `id`、`url`、`buildSuccess`、可选的 `buildErrors`，构建为绿且有改动时还有 `commit`。已打开的窗口会重新加载。        |
| `shuvix widget open <id>`                                   | 在运行 ShuviX 的那台电脑上用小组件自己的窗口打开它（已打开则聚焦）。只在用户要你打开时用。                                                                       |
| `shuvix widget preview <id> [--size panel,window,phone] [--theme light\|dark]` | 在看不见的窗口里按这些尺寸（缺省三种都截）渲染小组件，输出 `images`（`size`、`width`、`height`、`path`）和页面报出的 `errors`。屏幕上什么都不会打开。用 `read` 看图。见 `design.md` 的「检查」。 |
| `shuvix widget export <id> --to <dir or file.zip>`          | 把一个独立的 Vite 项目打包成一个 .zip，放在本次对话的工作目录内。见 `export.md`。                                                          |
| `shuvix widget db-init <id> --file <projectDir>/schema.sql` | 安装或更新小组件的 schema；实际应用了的内容会写回 `schema.sql`。`--sql "<DDL>"` 也可以。见 `data.md`。                                     |
| `shuvix widget db-query <id> --sql "<SQL>"`                 | 在小组件自己的 schema 里运行任意 SQL：检查、修数据、修复。`--file <path>` 也可以。它本身不带事务。                                         |

## 要紧的细节

- **访问权限**：`init` 和 `build` 给本次对话对小组件目录的读写权限。对已有的小组件，编辑之前先跑 `build`，否则每次写入都会先问用户。
- **`buildSuccess: false`** 带着 `buildErrors` 是正常、可恢复的结果：修好再构建。
- **提交**：绿色构建之后 ShuviX 会提交整个小组件目录，删除也算在内。`--message` 是这次提交的标题（缺省 `chore(<id>): build`）；写改了什么，一行。没有可提交的内容就没有 `commit` 字段。你从不运行 git，也从不碰 `.git`。
- **`url`** 是小组件在这台电脑上的地址（`http://127.0.0.1:<port>/w/<id>/`）。ShuviX 重启时端口会变，而对从浏览器使用 ShuviX 的人来说这个地址不存在，所以它绝不进入小组件代码。它在你自己的 shell 里有用，例如用 `curl "<url>db/todos?limit=3"` 检查数据库 API。
- **`open`** 在 ShuviX 运行的那台电脑上显示窗口。用户在 ShuviX 的网页上，或者 ShuviX 以无界面（headless）方式运行（此时 `open` 会失败）时，告诉用户改从「Widget 面板」打开小组件；在那里它会在新的浏览器标签页里打开。
- **Id** 是小写 ASCII kebab-case，至少带一个连字符；其他一概拒绝。
- 如果找不到 `shuvix`，或者它连不上 ShuviX，说明你不在 ShuviX 启动的 shell 里，或者应用没在运行：如实汇报，不要绕过去。
