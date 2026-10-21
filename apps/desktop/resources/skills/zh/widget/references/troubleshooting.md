# 故障排查

## 构建失败

`buildSuccess: false` 会带着 `buildErrors`，即带文件、行号和列号的 esbuild 消息。修好再构建。

- `Could not resolve "<package>"`：这个 import 在封闭的依赖集（React、React DOM、React Router；Tailwind 经 `className` 使用，不是 import）之外。用现有的东西来写：内联 SVG 图标、`fetch`、`Intl`、`Date`。
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

用户也会看到这些；只有用户告诉你，你才看得到。汇报之前，确保你改过的代码路径在数据为空时（还没有行、空文件夹、缺失的文件）不会抛异常。

## fetch 失败

- `404 Widget <id> not registered`：小组件没在运行（它的窗口关了，之后也没有任何东西构建过它）。`shuvix widget build <id>` 会启动它。
- `db/` 返回 `{ code, message }`：消息会说明哪个表、列或过滤条件不对。缺表通常意味着 `schema.sql` 从没安装过（`data.md`）。
- `fs/file` 404：路径不存在或是目录；403：ShuviX 无权读取。在 macOS 上，桌面（Desktop）、文稿（Documents）和下载（Downloads）需要在 系统设置（System Settings）→ 隐私与安全性（Privacy & Security）→ 文件与文件夹（Files and Folders）里允许 ShuviX；这只能由用户来授权。
- 在桌面端能用、从浏览器打开就失败：代码用了只在桌面端存在的地址（`shuvix-media://`、`file://`、`http://127.0.0.1:<port>`）。见 `files.md`。

要从你自己的 shell 检查一个端点，就 `curl` `build` 返回的 `url` 加上路由，并在请求头里带上它的 `token`，例如 `curl -H "x-shuvix-widget-token: <token>" "<url>db/todos?limit=3"`。这里返回 403，说明没带令牌，或者令牌是 ShuviX 重启之前的（再 `build` 一次拿新的）；`fs/` 对 shell 一律返回 403。

## CLI

- 找不到 `shuvix`，或者它连不上 ShuviX：你不在 ShuviX 启动的 shell 里，或者应用没在运行。如实汇报，不要绕过去。
- `open` 失败，或者用户看不到窗口：ShuviX 可能以无界面（headless）方式运行，或者用户正从另一台设备使用 ShuviX 的网页。窗口在运行 ShuviX 的那台电脑上打开；在浏览器里，用户从「Widget 面板」打开小组件，它会在新标签页里打开。
