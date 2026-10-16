/**
 * widget 的文件路由（`/w/<id>/fs/file`、`/w/<id>/fs/list`，路由表与理由见 `shared/widgetRoutes.ts`）——
 * widget 代码读本机文件的写法，桌面直连与远程转发是同一个地址。只读：要存东西用 widget 的数据库。
 *
 *  - `fs/file?path=`：回文件字节（`utils/httpFile.ts`，与网络服务的 `/files/media` 同一段：按扩展名给 MIME、
 *    Range → 206 / 416、HEAD 只回头；不在 / 不是文件 → 404，没权限 → 403）；
 *  - `fs/list?path=`：回 `WidgetDirListing`（JSON，按名字排序、跟随符号链接看类型，超过上限截断）；出错也回
 *    JSON `{ code, message }`，与 `db/` 的错误同一个形状，widget 照样 `res.json()`。
 *
 * `path` 绝对路径或 `~` 开头；不限路径。谁能调由 widgetServer 的两道门管（Host、不带 CORS 头）。
 */
import { readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  WIDGET_FILE_ROUTE,
  WIDGET_LIST_LIMIT,
  WIDGET_LIST_ROUTE,
  type WidgetDirEntry,
  type WidgetDirListing
} from '../../../shared/widgetRoutes'
import { plainResponse, sendFileResponse } from '../../utils/httpFile'

/**
 * 查询参数里的路径 → 绝对路径：`~` / `~/…` 展开成主目录，其余必须是绝对路径；归一（`..` 消掉）。
 * 缺 / 空 / 带 NUL / 相对路径 → undefined
 */
export function resolveWidgetFilePath(
  raw: string | null | undefined,
  home: string = homedir()
): string | undefined {
  if (!raw || raw.includes('\0')) return undefined
  let path = raw
  if (path === '~') path = home
  else if (path.startsWith('~/') || path.startsWith('~\\')) path = join(home, path.slice(2))
  if (!isAbsolute(path)) return undefined
  return resolve(path)
}

/** JSON 应答（HEAD 的正文由 node:http 自己丢掉） */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}

function errnoOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** 列一个目录（已解析的绝对路径）；出错按 errno 回 403 / 404 */
async function listDirectory(res: ServerResponse, path: string): Promise<void> {
  let names: string[]
  try {
    const info = await stat(path)
    if (!info.isDirectory()) {
      respondJson(res, 404, { code: 'NOT_A_DIRECTORY', message: `Not a directory: ${path}` })
      return
    }
    names = (await readdir(path)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch (error) {
    const code = errnoOf(error)
    if (code === 'EACCES' || code === 'EPERM') {
      respondJson(res, 403, { code: 'FORBIDDEN', message: `Permission denied: ${path}` })
    } else {
      respondJson(res, 404, { code: 'NOT_FOUND', message: `No such directory: ${path}` })
    }
    return
  }
  const truncated = names.length > WIDGET_LIST_LIMIT
  const entries = await Promise.all(
    names.slice(0, WIDGET_LIST_LIMIT).map(async (name): Promise<WidgetDirEntry> => {
      try {
        const info = await stat(join(path, name))
        const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
        return { name, kind, size: kind === 'file' ? info.size : 0, mtimeMs: info.mtimeMs }
      } catch {
        return { name, kind: 'other', size: 0, mtimeMs: 0 }
      }
    })
  )
  const listing: WidgetDirListing = { path, entries, truncated }
  respondJson(res, 200, listing)
}

/**
 * 回一次 `/w/<id>/fs/…` 请求。`route` 是 `/w/<id>` 之后的那段（不含查询串），`search` 是查询参数。
 * 认不出的 `fs/` 子路径 → 404
 */
export async function serveWidgetFiles(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  search: URLSearchParams
): Promise<void> {
  const isList = route === WIDGET_LIST_ROUTE
  if (route !== WIDGET_FILE_ROUTE && !isList) {
    plainResponse(res, 404, 'Not found.')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    if (isList) respondJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or HEAD.' })
    else plainResponse(res, 405, 'Method not allowed.')
    return
  }
  const path = resolveWidgetFilePath(search.get('path'))
  if (path === undefined) {
    const message = 'path must be an absolute path or start with ~'
    if (isList) respondJson(res, 400, { code: 'BAD_PATH', message })
    else plainResponse(res, 400, 'Bad request: path must be an absolute path or start with ~.')
    return
  }
  if (isList) await listDirectory(res, path)
  else await sendFileResponse(req, res, path)
}
