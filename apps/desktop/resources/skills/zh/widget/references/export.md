# 导出小组件

`shuvix widget export <id> --to <dir or file.zip>` 写出一个 .zip：一个放在顶层 `<id>/` 文件夹里的独立 Vite 项目，包含小组件（widget）的源文件，但不含 `widget.json`、`.git` 或 `node_modules`。

- 目标必须在本次对话的工作目录内；其他位置一概拒绝（这条路径上没有审批提示）。
- 它从不覆盖。遇到 `[TARGET_EXISTS]` 就换个名字。
- 汇报压缩包的路径，告诉用户解压后在 `<id>` 文件夹里运行 `npm install` 和 `npm run dev`，并指出里面的 `EXPORT_NOTES.md`。

## 不会带过去的东西

导出的项目是一个分叉：在那里做的修改不会回流到 ShuviX。`EXPORT_NOTES.md` 列出了标准 Vite 与 ShuviX 构建的不同之处。会改变行为的是这些：

- **`/w/<id>/db/…` 和 `/w/<id>/fs/…` 由 ShuviX 提供**，在导出的项目里不存在。调用它们的代码需要用户自己的一个后端来应答同样的路径，或者换一个数据源。汇报一个用到其中任何一个的小组件的导出时，要说明这一点。
- 小组件的数据留在 ShuviX 的数据库里；导出带着 `schema.sql`，但不带任何数据行。如果用户也要数据，用 `db-query` 导出（例如 `SELECT json_agg(t) FROM todos t`），存在压缩包旁边。
- 被 import 的图片在 Vite 下会变成 URL，而不是内联 data URL。`<img src={x}>` 两种情况下都能用。
