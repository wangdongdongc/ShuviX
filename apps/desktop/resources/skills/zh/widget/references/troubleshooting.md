# 故障排查

## 构建失败

失败的 `build` 会列出带文件、行号和列号的 esbuild 消息。修好再构建。

- `Could not resolve "<package>"`：这个 import 在封闭的依赖集（界面：React、React DOM、React Router、`shuvix/widget`；`api.ts`：`shuvix/widget-api`、`zod`）之外。用现有的东西来写：内联 SVG 图标、`Intl`、`Date`。
- `"shuvix/widget-api" runs on ShuviX's side, not in the widget's screen`：界面把 `api.ts`（或 zod）当作值 import 了。写成 `import type Api from './api'`。
- `api.ts: …`：API 没通过检查：某个操作缺 `description` 或 `input`、名称不合规、智能体读不懂的 schema（`z.date()`、`z.bigint()`、`z.map()`）。消息会指明是哪一处；界面也没有重新构建。
- `No loader is configured for ".<ext>" files`：除了代码，只有 `.css`、`.json`、`.txt` 和图片 `.svg`、`.png`、`.jpg`、`.gif` 能 import。其他文件通过 `fs/file` 从磁盘读取（`files.md`）。
- `Build already in progress`：同一个小组件（widget）的另一次构建正在进行；再构建一次。

## 窗口空白或显示一条消息

小组件页面自己可能显示的：

| 屏幕上                                                          | 含义                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Build Error** 以及 esbuild 输出                               | 上一次构建失败了；下一次绿色构建之后窗口会自己重新加载                                       |
| **Widget did not mount anything to #root.**                     | 打包产物加载了，但什么都没渲染：把挂载块放回 `index.tsx` 的末尾                              |
| **Runtime Error** / **Unhandled Promise Rejection** 以及调用栈 | 运行时的异常；调用栈指明了出错的位置                                                         |
| 空白页面，没有消息                                              | 应用什么都没渲染：一个没有文字的空状态、一个什么都匹配不上的路由，或者把一切都藏起来的 CSS   |

`preview` 会让你看到同样的页面和它报出的错误。汇报之前，确保你改过的代码路径在数据为空时（还没有行、空文件夹、缺失的文件）不会抛异常。

## 某个操作失败

自己用 `call` 调它，看完整的错误和它的 `logs`：

| 错误                           | 含义                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `invalid_args`                 | 输入不符合随错误一起给出的 schema                                                                                        |
| `[<code>] <message>`           | 处理函数调用了 `ctx.fail`：操作是有意拒绝的                                                                              |
| `Widget operation failed: …`   | 处理函数抛了异常。`no such table`：表从没建过（`data.md`）。`A read operation cannot change data`：一个会写入的 `op.read`。`Widget operations can only run …` / `cannot use …`：一条既不是查询、也不是行改动的语句（`api.md`） |
| `timeout` / `out_of_memory`    | 处理函数超出了它的限制（`api.md`）：一个停不下来的循环、一个返回全部数据的查询                                           |
| `no_api` / `unknown_op`        | 没有构建好的 API，或者没有这个操作：编辑 `api.ts` 之后要 `build`                                                         |
| `changed`                      | 在你检查和你调用之间，小组件被重新构建了；再 `describe` 它一次                                                           |

在界面里，`WidgetError` 带着同样的 `code` 和 `message`。

## fetch 失败

- `404 Widget <id> not registered`：小组件没在运行（它的窗口关了，之后也没有任何东西构建过它）。`build` 会启动它。
- `fs/file` 404：路径不存在或是目录；403：ShuviX 无权读取。在 macOS 上，桌面（Desktop）、文稿（Documents）和下载（Downloads）需要在 系统设置（System Settings）→ 隐私与安全性（Privacy & Security）→ 文件与文件夹（Files and Folders）里允许 ShuviX；这只能由用户来授权。在 `preview` 里，`fs/` 只能读到本次对话不经询问就能读的东西。
- 在桌面端能用、从浏览器打开就失败：代码用了只在桌面端存在的地址（`shuvix-media://`、`file://`、`http://127.0.0.1:<port>`）。见 `files.md`。

## 打开它

`open` 失败，或者用户看不到窗口：ShuviX 可能以无界面（headless）方式运行，或者用户正从另一台设备使用 ShuviX 的网页。窗口在运行 ShuviX 的那台电脑上打开；在浏览器里，用户从「Widget 面板」打开小组件，它会在新标签页里打开。
