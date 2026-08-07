/**
 * OPFS 版 pi `ExecutionEnv` —— 会话转写文件（JSONL）专用。
 *
 * 只实现 `JsonlSessionStorage` 及其包装层实际用到的方法
 * （readTextFile / writeFile / appendFile / exists / remove + 纯路径运算），
 * 其余与 createStubExecutionEnv 同样返回 not_supported —— 诚实报错优于静默兜底。
 *
 * 读写全部经 dedicated Worker 的 sync access handle（O(1) 尾追加，见 opfsFsWorker.ts）；
 * 本模块是主线程侧的 request/response 桥。二进制内容不支持（会话转写只有文本行）。
 */
import { ExecutionError, FileError } from '@earendil-works/pi-agent-core'
import type { ExecutionEnv, Result } from '@earendil-works/pi-agent-core'
import type { OpfsFsOp, OpfsFsReply } from './opfsFsWorker'

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (reply: OpfsFsReply) => void>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./opfsFsWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<OpfsFsReply>) => {
    const resolve = pending.get(ev.data.id)
    pending.delete(ev.data.id)
    resolve?.(ev.data)
  }
  worker.onerror = (ev) => {
    // Worker 崩溃：在途请求全部回错误，实例弃置 —— 下次调用重新拉起
    console.error('[shuvix] opfs fs worker error', ev.message)
    for (const [id, resolve] of pending) {
      resolve({ id, ok: false, code: 'unknown', message: `worker error: ${ev.message || '?'}` })
    }
    pending.clear()
    worker = null
  }
  return worker
}

function call(req: OpfsFsOp): Promise<OpfsFsReply> {
  const id = ++seq
  return new Promise<OpfsFsReply>((resolve) => {
    pending.set(id, resolve)
    getWorker().postMessage({ ...req, id })
  })
}

/** worker 回复 → pi Result（错误封成 FileError，绝不抛出） */
async function fsCall<T>(
  req: OpfsFsOp,
  pick: (reply: Extract<OpfsFsReply, { ok: true }>) => T
): Promise<Result<T, FileError>> {
  const reply = await call(req)
  if (!reply.ok) {
    return {
      ok: false,
      error: new FileError(
        reply.code as ConstructorParameters<typeof FileError>[0],
        reply.message,
        'path' in req ? req.path : undefined
      )
    }
  }
  return { ok: true, value: pick(reply) }
}

/** 归一成以 / 开头的绝对路径（消解 . / ..；输入均为本模块自己拼的会话路径） */
function normalizePath(path: string, cwd: string): string {
  const raw = path.startsWith('/') ? path : `${cwd}/${path}`
  const out: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function notSupported<T>(method: string): Promise<Result<T, FileError>> {
  return Promise.resolve({
    ok: false,
    error: new FileError(
      'not_supported',
      `OpfsSessionEnv.${method} 未实现 —— 会话转写只需要 readText/write/append/exists/remove。`
    )
  } as Result<T, FileError>)
}

/** 会话转写专用 OPFS ExecutionEnv（进程单例） */
export function createOpfsSessionEnv(cwd = '/'): ExecutionEnv {
  const abs = (p: string): string => normalizePath(p, cwd)
  return {
    cwd,
    absolutePath: async (p: string) => ({ ok: true, value: abs(p) }),
    joinPath: async (parts: string[]) => ({ ok: true, value: abs(parts.join('/')) }),
    readTextFile: (p: string) => fsCall({ op: 'readText', path: abs(p) }, (r) => r.value as string),
    writeFile: (p: string, content: string | Uint8Array) =>
      typeof content === 'string'
        ? fsCall({ op: 'write', path: abs(p), data: content }, () => undefined)
        : notSupported<void>('writeFile(binary)'),
    appendFile: (p: string, content: string | Uint8Array) =>
      typeof content === 'string'
        ? fsCall({ op: 'append', path: abs(p), data: content }, () => undefined)
        : notSupported<void>('appendFile(binary)'),
    exists: (p: string) => fsCall({ op: 'exists', path: abs(p) }, (r) => r.value === true),
    remove: (p: string) => fsCall({ op: 'remove', path: abs(p) }, () => undefined),
    readTextLines: () => notSupported<string[]>('readTextLines'),
    readBinaryFile: () => notSupported<Uint8Array>('readBinaryFile'),
    fileInfo: () => notSupported('fileInfo'),
    listDir: () => notSupported('listDir'),
    canonicalPath: () => notSupported<string>('canonicalPath'),
    createDir: () => notSupported<void>('createDir'),
    createTempDir: () => notSupported<string>('createTempDir'),
    createTempFile: () => notSupported<string>('createTempFile'),
    cleanup: async () => {},
    exec: async () =>
      ({
        ok: false,
        error: new ExecutionError('shell_unavailable', '浏览器端没有 shell。')
      }) as Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
  } as unknown as ExecutionEnv
}
