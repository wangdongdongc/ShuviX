/**
 * Python Worker —— 在 worker_threads 中运行 Pyodide WASM 解释器
 *
 * 行为定位：贴近 `python3` 原生 CLI 的子集
 *   - 每次 execute 全新 globals 命名空间（无 REPL 持久态，无 `_` 自动回显）
 *   - 支持 mode 分发：script / -c / -m / stdin / version
 *   - sys.argv 由调用方完整提供
 *   - PYTHONPATH / cwd 路径按需 NODEFS 挂载（只读）
 *
 * 仍由 worker 长驻：Pyodide 冷启动 ~3s，per-session 复用规避重复冷启。
 */

import { parentPort } from 'worker_threads'
import { platform } from 'process'
import { resolve as resolvePath, sep as pathSep } from 'path'

function toEmscriptenPath(hostPath: string): string {
  if (platform !== 'win32') return hostPath
  return '/' + hostPath.replace(/\\/g, '/').replace(':', '')
}

// ---- 消息协议 ----

interface InitMessage {
  type: 'init'
  mounts: MountConfig[]
  /** 工作目录默认值（execute 未传 cwd 时回退到这里） */
  workingDirectory: string
  /** 预装 wheel 文件的目录路径 */
  wheelsDir?: string
}

export type ExecMode = 'script' | '-c' | '-m' | 'stdin' | 'version'

export interface ExecuteMessage {
  type: 'execute'
  id: string
  mode: ExecMode
  /** mode='-c' / 'stdin' 时承载源码 */
  code: string
  /** mode='script' 时为脚本路径；mode='-m' 时为模块名 */
  target?: string
  /** 注入 Python 端的 sys.argv */
  pythonArgv: string[]
  /** 调用方 cwd（pyodide 内 chdir 目标）；不传则用 init 阶段的 workingDirectory */
  cwd?: string
  /** PYTHONPATH 已切分后的列表，每项为宿主机绝对路径 */
  pythonPathDirs?: string[]
}

export interface MountConfig {
  /** 宿主机路径 */
  hostPath: string
  /** 访问模式 */
  access: 'readonly' | 'readwrite'
}

export interface WorkerResponse {
  type: 'ready' | 'result' | 'error'
  id?: string
  stdout?: string
  stderr?: string
  /** Python 进程退出码：0 成功，非 0 表示错误（含 SystemExit code） */
  exitCode?: number
  /** 严重错误时（wrapper 自身崩了 / 启动失败）携带的错误描述 */
  error?: string
}

// ---- Pyodide 运行时状态 ----

type PyodideInstance = Awaited<ReturnType<typeof import('pyodide').loadPyodide>>

let pyodide: PyodideInstance | null = null

/** 已挂载的宿主机绝对路径集合（init 阶段挂载 + execute 时动态挂载） */
const mountedHostPaths = new Set<string>()
/** Emscripten 侧只读挂载点列表，写保护用 */
const readonlyMountPoints: string[] = []
/** init 阶段确定的默认 cwd（POSIX 形态，pyodide 内可用） */
let defaultPosixCwd = '/'

// ---- 工具函数 ----

function mkdirRecursive(fs: { stat(p: string): void; mkdir(p: string): void }, path: string): void {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current += '/' + part
    try {
      fs.stat(current)
    } catch {
      try {
        fs.mkdir(current)
      } catch {
        // 已存在
      }
    }
  }
}

function isUnderMountedHostPath(absHostPath: string): boolean {
  for (const existing of mountedHostPaths) {
    if (absHostPath === existing) return true
    if (absHostPath.startsWith(existing + pathSep)) return true
  }
  return false
}

/** 把当前 readonlyMountPoints 同步到 Python 侧的 builtins._shuvix_readonly_paths */
function syncReadonlyPathsToPython(): void {
  if (!pyodide) return
  const json = JSON.stringify(readonlyMountPoints)
  pyodide.runPython(`import builtins; builtins._shuvix_readonly_paths = ${json}`)
}

function mountOne(hostPath: string, access: 'readonly' | 'readwrite'): void {
  if (!pyodide) return
  const abs = resolvePath(hostPath)
  if (mountedHostPaths.has(abs)) return
  const mountPoint = toEmscriptenPath(abs)
  const FS = pyodide.FS
  mkdirRecursive(FS, mountPoint)
  FS.mount(FS.filesystems.NODEFS, { root: abs }, mountPoint)
  mountedHostPaths.add(abs)
  if (access === 'readonly') {
    readonlyMountPoints.push(mountPoint)
  }
}

/** execute 时按需挂载 PYTHONPATH / cwd 路径，避免 Python `import` 找不到文件 */
async function ensureDynamicMounts(paths: string[]): Promise<void> {
  if (!pyodide) return
  let needSync = false
  for (const p of paths) {
    if (!p) continue
    const abs = resolvePath(p)
    if (isUnderMountedHostPath(abs)) continue
    // 用 fs 检查是否真实存在；不存在的目录跳过（让 Python 报真实错误）
    const { existsSync } = await import('fs')
    if (!existsSync(abs)) continue
    mountOne(abs, 'readonly')
    needSync = true
  }
  if (needSync) syncReadonlyPathsToPython()
}

// ---- 初始化 ----

async function init(
  mounts: MountConfig[],
  workingDirectory: string,
  wheelsDir?: string
): Promise<void> {
  const { loadPyodide } = await import('pyodide')
  pyodide = await loadPyodide({})

  // 挂载工作目录 + 引用目录
  for (const mount of mounts) {
    mountOne(mount.hostPath, mount.access)
  }

  defaultPosixCwd = toEmscriptenPath(resolvePath(workingDirectory))
  pyodide.runPython(`import os; os.chdir(${JSON.stringify(defaultPosixCwd)})`)

  // 安装写保护 hook：拦截 builtins.open；只读路径表存到 builtins._shuvix_readonly_paths，
  // 这样 fresh globals 也能命中（不依赖 persistent globals）
  pyodide.runPython(`
import builtins as _b
import os as _os

_b._shuvix_readonly_paths = []
_original_open = _b.open

def _guarded_open(file, mode='r', *args, **kwargs):
    if isinstance(file, str) and any(c in mode for c in 'wxa+'):
        abs_path = _os.path.abspath(file)
        for rp in _b._shuvix_readonly_paths:
            if abs_path == rp or abs_path.startswith(rp + _os.sep):
                raise PermissionError(f"Write denied: {abs_path} is inside a read-only directory")
    return _original_open(file, mode, *args, **kwargs)

_b.open = _guarded_open
`)

  syncReadonlyPathsToPython()

  // 预装本地 wheel 包（离线加载，无需联网）
  if (wheelsDir) {
    const fs = await import('fs')
    try {
      const files = fs.readdirSync(wheelsDir).filter((f: string) => f.endsWith('.whl'))
      if (files.length > 0) {
        const wheelPaths = files.map((f: string) => `${wheelsDir}/${f}`)
        await pyodide.loadPackage(wheelPaths)
      }
    } catch (err) {
      parentPort!.postMessage({
        type: 'error',
        error: `Warning: failed to load pre-bundled packages: ${err instanceof Error ? err.message : String(err)}`
      } satisfies WorkerResponse)
    }
  }

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerResponse)
}

// ---- 执行 ----

function buildBody(msg: ExecuteMessage): string {
  switch (msg.mode) {
    case '-c': {
      return `exec(compile(${JSON.stringify(msg.code)}, '<string>', 'exec'), _ns)`
    }
    case 'stdin': {
      return `exec(compile(${JSON.stringify(msg.code)}, '<stdin>', 'exec'), _ns)`
    }
    case '-m': {
      // runpy 会自己处理 sys.argv[0]（alter_sys=True）；这里只需保证 module 名称正确
      return `import runpy; runpy.run_module(${JSON.stringify(msg.target ?? '')}, run_name='__main__', alter_sys=True)`
    }
    case 'script': {
      const posix = toEmscriptenPath(resolvePath(msg.target ?? ''))
      return `import runpy; runpy.run_path(${JSON.stringify(posix)}, run_name='__main__')`
    }
    case 'version': {
      return `import sys; _pyver = sys.version.split()[0]; print(f'Python {_pyver} (Pyodide WebAssembly runtime)')`
    }
  }
}

async function execute(msg: ExecuteMessage): Promise<void> {
  if (!pyodide) {
    parentPort!.postMessage({
      type: 'error',
      id: msg.id,
      error: 'Pyodide runtime not initialized',
      exitCode: 1
    } satisfies WorkerResponse)
    return
  }

  // 1. 动态挂载 PYTHONPATH 目录 + cwd 父目录 + script 父目录
  const dynamicPaths: string[] = []
  if (msg.pythonPathDirs) dynamicPaths.push(...msg.pythonPathDirs)
  if (msg.cwd) dynamicPaths.push(msg.cwd)
  if (msg.mode === 'script' && msg.target) {
    const { dirname } = await import('path')
    dynamicPaths.push(dirname(resolvePath(msg.target)))
  }
  try {
    await ensureDynamicMounts(dynamicPaths)
  } catch (err) {
    parentPort!.postMessage({
      type: 'error',
      id: msg.id,
      error: `Failed to mount dynamic paths: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1
    } satisfies WorkerResponse)
    return
  }

  // 2. 合成 wrapper
  const argvJson = JSON.stringify(msg.pythonArgv)
  const cwdPosix = msg.cwd ? toEmscriptenPath(resolvePath(msg.cwd)) : defaultPosixCwd
  const cwdLit = JSON.stringify(cwdPosix)
  const pythonPathPosix = (msg.pythonPathDirs ?? []).map((p) => toEmscriptenPath(resolvePath(p)))
  const pathsJson = JSON.stringify(pythonPathPosix)
  const body = buildBody(msg)

  const wrapper = `
import sys as _sys, os as _os, builtins as _b, traceback as _tb

_sys.argv = ${argvJson}
try:
    _os.chdir(${cwdLit})
except OSError:
    pass

for _p in ${pathsJson}:
    if _p and _p not in _sys.path:
        _sys.path.insert(0, _p)

_ns = {'__name__': '__main__', '__file__': '<input>', '__builtins__': _b.__dict__}
_shuvix_exit_code = 0
try:
    ${body}
except SystemExit as _e:
    _c = _e.code
    if _c is None:
        _shuvix_exit_code = 0
    elif isinstance(_c, int):
        _shuvix_exit_code = _c
    else:
        _sys.stderr.write(str(_c) + '\\n')
        _shuvix_exit_code = 1
except BaseException:
    _tb.print_exc()
    _shuvix_exit_code = 1
`

  // 3. stdout/stderr 捕获（每次 execute 重置）
  const stdoutBuf: string[] = []
  const stderrBuf: string[] = []
  pyodide.setStdout({ batched: (m: string) => stdoutBuf.push(m) })
  pyodide.setStderr({ batched: (m: string) => stderrBuf.push(m) })

  // 4. 在全新的 globals 字典里执行 wrapper
  const freshGlobals = pyodide.globals.get('dict')()
  try {
    await pyodide.runPythonAsync(wrapper, { globals: freshGlobals })
    let exitCode = 0
    try {
      const v = freshGlobals.get('_shuvix_exit_code') as unknown
      if (typeof v === 'number') exitCode = v
    } catch {
      // ignore
    }
    parentPort!.postMessage({
      type: exitCode === 0 ? 'result' : 'error',
      id: msg.id,
      stdout: stdoutBuf.join('\n'),
      stderr: stderrBuf.join('\n'),
      exitCode
    } satisfies WorkerResponse)
  } catch (err: unknown) {
    // wrapper 本身报错（极少见，通常是语法错误塞进 wrapper / pyodide 崩溃）
    parentPort!.postMessage({
      type: 'error',
      id: msg.id,
      stdout: stdoutBuf.join('\n'),
      stderr: stderrBuf.join('\n'),
      error: err instanceof Error ? err.message : String(err),
      exitCode: 1
    } satisfies WorkerResponse)
  } finally {
    try {
      ;(freshGlobals as unknown as { destroy(): void }).destroy()
    } catch {
      // ignore
    }
  }
}

// ---- 执行队列 ----

let execQueue: Promise<void> = Promise.resolve()

parentPort!.on('message', (msg: InitMessage | ExecuteMessage) => {
  if (msg.type === 'init') {
    execQueue = execQueue.then(async () => {
      try {
        await init(msg.mounts, msg.workingDirectory, msg.wheelsDir)
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'error',
          error: `Failed to initialize Pyodide: ${err instanceof Error ? err.message : typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err)}`
        } satisfies WorkerResponse)
      }
    })
  } else if (msg.type === 'execute') {
    execQueue = execQueue.then(() => execute(msg))
  }
})
