/**
 * OPFS 文件读写专用 dedicated Worker。
 *
 * 为什么必须是 Worker：真 O(1) 尾追加只有 `createSyncAccessHandle`（原地写）能给，
 * 而它只暴露在 dedicated Worker 里。主线程的异步 `createWritable` 是「写临时副本 +
 * 原子换入」语义 —— 每追加一行都是 O(文件) 拷贝（实测 8MB 文件 ~28ms/次 vs 本实现
 * ~0.04ms/次，见 OPFS 探针）。
 *
 * 设计：
 *  - 所有读写（含整读）统一经 sync handle —— handle 持有排它锁，混用
 *    `getFile()` 等第二通路会撞锁；
 *  - 句柄按路径缓存（会话文件数量级小），remove 时关闭；
 *  - 协议为 request/response（id 对号），错误以 {code, message} 回传，不抛出。
 */

/** FileSystemSyncAccessHandle 的最小类型面（TS dom lib 不含 worker-only API） */
interface SyncHandle {
  getSize(): number
  read(buffer: Uint8Array, options?: { at?: number }): number
  write(buffer: Uint8Array, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

export type OpfsFsOp =
  | { op: 'readText'; path: string }
  | { op: 'write'; path: string; data: string }
  | { op: 'append'; path: string; data: string }
  | { op: 'exists'; path: string }
  | { op: 'remove'; path: string }

export type OpfsFsRequest = OpfsFsOp & { id: number }

export type OpfsFsReply =
  | { id: number; ok: true; value?: string | boolean }
  | { id: number; ok: false; code: string; message: string }

const handles = new Map<string, SyncHandle>()
const enc = new TextEncoder()
const dec = new TextDecoder()

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 定位父目录 + 文件名（create 时逐级建目录） */
async function locate(
  path: string,
  create: boolean
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = segments(path)
  if (parts.length === 0) throw new Error(`invalid path: ${path}`)
  let dir = await navigator.storage.getDirectory()
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return { dir, name: parts[parts.length - 1] }
}

async function handleFor(path: string, create: boolean): Promise<SyncHandle> {
  const cached = handles.get(path)
  if (cached) return cached
  const { dir, name } = await locate(path, create)
  const fh = await dir.getFileHandle(name, { create })
  const h = await (
    fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
  ).createSyncAccessHandle()
  handles.set(path, h)
  return h
}

function readAll(h: SyncHandle): string {
  const size = h.getSize()
  const buf = new Uint8Array(size)
  let got = 0
  while (got < size) {
    const n = h.read(buf.subarray(got), { at: got })
    if (n <= 0) break
    got += n
  }
  return dec.decode(got === size ? buf : buf.subarray(0, got))
}

function errCode(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === 'NotFoundError') return 'not_found'
    if (e.name === 'NotAllowedError' || e.name === 'NoModificationAllowedError') {
      return 'permission_denied'
    }
  }
  return 'unknown'
}

async function handle(req: OpfsFsRequest): Promise<OpfsFsReply> {
  try {
    switch (req.op) {
      case 'readText': {
        const h = await handleFor(req.path, false)
        return { id: req.id, ok: true, value: readAll(h) }
      }
      case 'write': {
        const h = await handleFor(req.path, true)
        const buf = enc.encode(req.data)
        h.truncate(0)
        h.write(buf, { at: 0 })
        h.flush()
        return { id: req.id, ok: true }
      }
      case 'append': {
        const h = await handleFor(req.path, true)
        const buf = enc.encode(req.data)
        h.write(buf, { at: h.getSize() })
        h.flush()
        return { id: req.id, ok: true }
      }
      case 'exists': {
        if (handles.has(req.path)) return { id: req.id, ok: true, value: true }
        try {
          const { dir, name } = await locate(req.path, false)
          await dir.getFileHandle(name, { create: false })
          return { id: req.id, ok: true, value: true }
        } catch (e) {
          if (errCode(e) === 'not_found') return { id: req.id, ok: true, value: false }
          throw e
        }
      }
      case 'remove': {
        handles.get(req.path)?.close()
        handles.delete(req.path)
        try {
          const { dir, name } = await locate(req.path, false)
          await dir.removeEntry(name)
        } catch (e) {
          // 幂等：文件/目录本就不存在视为成功
          if (errCode(e) !== 'not_found') throw e
        }
        return { id: req.id, ok: true }
      }
    }
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      code: errCode(e),
      message: e instanceof Error ? e.message : String(e)
    }
  }
}

self.onmessage = (ev: MessageEvent<OpfsFsRequest>) => {
  void handle(ev.data).then((reply) => {
    ;(self as unknown as { postMessage(m: OpfsFsReply): void }).postMessage(reply)
  })
}
