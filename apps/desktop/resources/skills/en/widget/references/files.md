# Reading files on the user's computer

A widget reads local files through two routes under its own address. They are read-only: what a widget writes goes into its database (`data.md`).

| Request                          | Answer                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /w/<id>/fs/file?path=<p>`   | The file's bytes, with a `Content-Type` from its extension and `Range` support (seekable video and audio). |
| `HEAD /w/<id>/fs/file?path=<p>`  | Only the headers: `Content-Length`, `Content-Type`. Use it as a cheap "does this file exist".              |
| `GET /w/<id>/fs/list?path=<dir>` | The directory as JSON (below).                                                                             |

**These are the only addresses that work everywhere.** On the desktop the widget is served from this computer; when the user opens ShuviX's web page from another device, the same `/w/<id>/…` path is forwarded to it. `shuvix-media://…`, `file://…` and `http://127.0.0.1:<port>/…` only exist on the desktop: a widget that uses them shows nothing in a browser.

## Paths

- `path` is an absolute path, or starts with `~` for the home folder of the user running ShuviX (`~/Pictures/2024`). Prefer `~/…` over a spelled-out home folder: the widget keeps working if it is copied to another account.
- Encode the whole path once, with `encodeURIComponent`.
- On Windows, drive paths are absolute: `C:\Users\me\Pictures`.
- Any path the user can read is allowed. Read only what the widget's purpose needs, and let the user choose the folder it works on (a setting stored in the database) rather than scanning their home folder.

Put the two URL builders in one module and use them everywhere:

```ts
const WIDGET = 'photo-wall'
export const fileUrl = (path: string) => `/w/${WIDGET}/fs/file?path=${encodeURIComponent(path)}`
export const listUrl = (path: string) => `/w/${WIDGET}/fs/list?path=${encodeURIComponent(path)}`
```

## Using a file

```tsx
// Images, video and audio load directly; seeking works
<img src={fileUrl('~/Pictures/cat.jpg')} alt="" />
<video src={fileUrl('~/Movies/clip.mp4')} controls />

// Text and JSON through fetch
const res = await fetch(fileUrl('~/notes/todo.md'))
if (!res.ok) throw new Error(await res.text())
const text = await res.text()
```

Image, PDF, audio and video extensions get their own `Content-Type`; everything else is `application/octet-stream`, which `fetch().text()`, `.json()` and `.arrayBuffer()` read fine. To draw an image onto a `<canvas>` and read its pixels back, set `crossOrigin="anonymous"` on the `<img>`, or the canvas is tainted when the widget is opened from a browser.

Errors on `fs/file` are plain text: 400 for a missing, relative or malformed `path`, 404 when the file does not exist or is a directory, 403 when ShuviX may not read it.

## Listing a directory

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

Entries are sorted by name and include hidden files. `kind` follows symbolic links; a broken link or an entry ShuviX cannot inspect is `other`. `size` is 0 for anything but a file. The child's path is `listing.path` + the platform separator + `name`; the `/` separator works on every platform for building `path` parameters.

Errors on `fs/list` are JSON `{ code, message }`, like the database's: `BAD_PATH` (400), `NOT_FOUND` and `NOT_A_DIRECTORY` (404), `FORBIDDEN` (403).

## Not available

- Writing, renaming or deleting files: the widget is read-only toward the disk.
- Watching for changes: list again when the user asks to refresh, or on a timer while the widget is visible.
- These routes in an exported project (`export.md`).
