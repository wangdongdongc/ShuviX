# 导出小组件

用 `export`，带上 `widget` 和 `path`，写出一个 .zip：一个放在顶层 `<id>/` 文件夹里的独立 Vite 项目，包含小组件（widget）的源文件，但不含 `widget.json`、`.git` 或 `node_modules`。`path` 是一个文件夹或一个 `.zip` 路径；相对路径落在本次对话的工作目录内，写到其他任何地方都会先问用户。

- 它从不覆盖。遇到 `[TARGET_EXISTS]` 就换个名字。
- 汇报压缩包的路径，告诉用户解压后在 `<id>` 文件夹里运行 `npm install` 和 `npm run dev`，并指出里面的 `EXPORT_NOTES.md`。

## 不会带过去的东西

导出的项目是一个分叉：在那里做的修改不会回流到 ShuviX。`EXPORT_NOTES.md` 列出了标准 Vite 与 ShuviX 构建的不同之处。会改变行为的是这些：

- **API 在那里不运行。** `api.ts` 会带过去，但没有东西执行它：在 ShuviX 里，它的操作在小组件数据库旁边的一个沙箱里运行。`shuvix/widget` 解析到客户端的一份副本，它发送 `POST api/<operation>`，并期待 `{ "result": … }` 这样的应答；用户需要自己的一个后端，以同样的方式应答。汇报一个带 API 的小组件的导出时，要说明这一点。
- **`/w/<id>/fs/…`（以及旧小组件的 `/w/<id>/db/…`）由 ShuviX 提供**，在那里也不存在。
- **数据留在 ShuviX 里。** 导出带着 `schema.sql`，但不带任何数据行。如果用户也要数据，用 `sql` 读出来（例如 `SELECT json_group_array(json_object('id', id, 'title', title)) FROM books`），存在压缩包旁边。
- 被 import 的图片在 Vite 下会变成 URL，而不是内联 data URL。`<img src={x}>` 两种情况下都能用。
