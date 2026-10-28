# 读取用户电脑上的文件

小组件（widget）通过它自己地址下的两条路由读取本地文件。它们是只读的：小组件要写的东西通过它的 API 进它的数据库（`api.md`）。

| 请求                             | 应答                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /w/<id>/fs/file?path=<p>`   | 文件的字节，`Content-Type` 按扩展名给出，支持 `Range`（视频和音频可以拖动进度）。             |
| `HEAD /w/<id>/fs/file?path=<p>`  | 只有响应头：`Content-Length`、`Content-Type`。把它当作一个廉价的「这个文件存在吗」。          |
| `GET /w/<id>/fs/list?path=<dir>` | 以 JSON 表示的目录（见下）。                                                                  |

**只有这些地址在哪里都能用。** 在桌面端，小组件由这台电脑提供；用户从另一台设备打开 ShuviX 的网页时，同样的 `/w/<id>/…` 路径会被转发到这台电脑。`shuvix-media://…`、`file://…` 和 `http://127.0.0.1:<port>/…` 只在桌面端存在：用了它们的小组件在浏览器里什么都显示不出来。

## 路径

- `path` 是绝对路径，或者以 `~` 开头，表示运行 ShuviX 的那个用户的主文件夹（`~/Pictures/2024`）。优先用 `~/…`，而不是把主文件夹写全：小组件被复制到另一个账户时仍能用。
- 用 `encodeURIComponent` 把整个路径编码一次。
- 在 Windows 上，带盘符的路径是绝对路径：`C:\Users\me\Pictures`。
- 用户能读的任何路径都允许。只读小组件用途需要的东西，让用户选择它处理的文件夹（通过一个操作存下的一项设置），而不是扫描用户的主文件夹。

把两个 URL 构造函数放在一个模块里，到处都用它们：

```ts
const WIDGET = 'photo-wall'
export const fileUrl = (path: string) => `/w/${WIDGET}/fs/file?path=${encodeURIComponent(path)}`
export const listUrl = (path: string) => `/w/${WIDGET}/fs/list?path=${encodeURIComponent(path)}`
```

## 使用文件

```tsx
// Images, video and audio load directly; seeking works
<img src={fileUrl('~/Pictures/cat.jpg')} alt="" />
<video src={fileUrl('~/Movies/clip.mp4')} controls />

// Text and JSON through fetch
const res = await fetch(fileUrl('~/notes/todo.md'))
if (!res.ok) throw new Error(await res.text())
const text = await res.text()
```

图片、PDF、音频和视频扩展名有各自的 `Content-Type`；其余一律是 `application/octet-stream`，`fetch().text()`、`.json()` 和 `.arrayBuffer()` 都能正常读取。要把图片画到 `<canvas>` 上再读回像素，就在 `<img>` 上设 `crossOrigin="anonymous"`，否则小组件从浏览器打开时 canvas 会被污染（tainted）。

`fs/file` 的错误是纯文本：`path` 缺失、是相对路径或格式不对时为 400，文件不存在或是目录时为 404，ShuviX 无权读取时为 403。

## 列出目录

```ts
interface DirListing {
  path: string // the absolute path, with ~ expanded
  entries: { name: string; kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number }[]
  truncated: boolean // more than 10,000 entries: only the first 10,000 by name are listed
}

const res = await fetch(listUrl('~/Pictures'))
const body = await res.json()
if (!res.ok) throw new Error(body.message)
const listing = body as DirListing
const images = listing.entries.filter((e) => e.kind === 'file' && /\.(jpe?g|png|gif|webp)$/i.test(e.name))
```

条目按名称排序，包含隐藏文件。`kind` 会跟随符号链接；断开的链接，或者 ShuviX 无法检查的条目，是 `other`。除文件外 `size` 都是 0。子项的路径是 `listing.path` + 平台分隔符 + `name`；构造 `path` 参数时，`/` 分隔符在所有平台上都能用。

`fs/list` 的错误是 JSON `{ code, message }`，和数据库的一样：`BAD_PATH`（400）、`NOT_FOUND` 和 `NOT_A_DIRECTORY`（404）、`FORBIDDEN`（403）。

## 不提供的

- 写入、重命名或删除文件：小组件对磁盘是只读的。
- 监听变化：用户要求刷新时再列一次，或者在小组件可见时定时列。
- 导出项目里的这些路由（`export.md`）。
