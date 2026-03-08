/**
 * Python Worker — 在 worker_threads 中运行 Pyodide WASM Python 运行时
 * 支持 REPL 交互模式、多轮共享作用域、NODEFS 文件系统挂载
 */

import { parentPort } from 'worker_threads'
import { toEmscriptenPath } from './emscriptenPaths'

// ---- 消息协议 ----

interface InitMessage {
  type: 'init'
  mounts: MountConfig[]
  /** 项目工作目录（用于设置 Python 的 cwd） */
  workingDirectory: string
  /** 预装 wheel 文件的目录路径 */
  wheelsDir?: string
}

interface ExecuteMessage {
  type: 'execute'
  id: string
  code: string
  packages?: string[]
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
  returnValue?: string
  error?: string
}

// ---- Pyodide 运行时 ----

type PyodideInstance = Awaited<ReturnType<typeof import('pyodide').loadPyodide>>
type PyProxy = PyodideInstance['globals']

let pyodide: PyodideInstance | null = null
let persistentGlobals: PyProxy | null = null
let readonlyPaths: string[] = []

/** 递归创建目录 */
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

async function init(
  mounts: MountConfig[],
  workingDirectory: string,
  wheelsDir?: string
): Promise<void> {
  const { loadPyodide } = await import('pyodide')
  pyodide = await loadPyodide({})

  // 挂载文件系统（Windows 路径需转换为 POSIX 挂载点）
  const FS = pyodide.FS
  readonlyPaths = []
  for (const mount of mounts) {
    const mountPoint = toEmscriptenPath(mount.hostPath)
    mkdirRecursive(FS, mountPoint)
    FS.mount(FS.filesystems.NODEFS, { root: mount.hostPath }, mountPoint)
    if (mount.access === 'readonly') {
      readonlyPaths.push(mountPoint)
    }
  }

  // 设置工作目录为项目目录（使用 POSIX 挂载点路径）
  const posixWorkDir = toEmscriptenPath(workingDirectory)
  pyodide.runPython(`import os; os.chdir(${JSON.stringify(posixWorkDir)})`)

  // 创建持久化全局作用域
  persistentGlobals = pyodide.globals.get('dict')()
  pyodide.runPython(
    `
import sys
sys.path.insert(0, '')
`,
    { globals: persistentGlobals as PyProxy }
  )

  // 注入只读路径保护（hook builtins.open）
  if (readonlyPaths.length > 0) {
    const pathsRepr = readonlyPaths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(', ')
    pyodide.runPython(
      `
import builtins as _builtins
import os as _os

_readonly_paths = [${pathsRepr}]
_original_open = _builtins.open

def _guarded_open(file, mode='r', *args, **kwargs):
    if isinstance(file, str) and any(c in mode for c in 'wxa+'):
        abs_path = _os.path.abspath(file)
        for rp in _readonly_paths:
            if abs_path == rp or abs_path.startswith(rp + _os.sep):
                raise PermissionError(f"Write denied: {abs_path} is inside a read-only directory")
    return _original_open(file, mode, *args, **kwargs)

_builtins.open = _guarded_open
`,
      { globals: persistentGlobals as PyProxy }
    )
  }

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
      // 预装失败不阻塞初始化，仅记录
      parentPort!.postMessage({
        type: 'error',
        error: `Warning: failed to load pre-bundled packages: ${err instanceof Error ? err.message : String(err)}`
      } satisfies WorkerResponse)
    }
  }

  parentPort!.postMessage({ type: 'ready' } satisfies WorkerResponse)
}

async function execute(id: string, code: string, packages?: string[]): Promise<void> {
  if (!pyodide || !persistentGlobals) {
    parentPort!.postMessage({
      type: 'error',
      id,
      error: 'Pyodide runtime not initialized'
    } satisfies WorkerResponse)
    return
  }

  // 安装请求的包
  if (packages && packages.length > 0) {
    try {
      await pyodide.loadPackage('micropip')
      const micropip = pyodide.pyimport('micropip')
      for (const pkg of packages) {
        await micropip.install(pkg)
      }
    } catch (err: unknown) {
      parentPort!.postMessage({
        type: 'error',
        id,
        stdout: '',
        stderr: '',
        error: `Failed to install packages: ${err instanceof Error ? err.message : String(err)}`
      } satisfies WorkerResponse)
      return
    }
  }

  // 捕获 stdout/stderr
  const stdout: string[] = []
  const stderr: string[] = []
  pyodide.setStdout({ batched: (msg: string) => stdout.push(msg) })
  pyodide.setStderr({ batched: (msg: string) => stderr.push(msg) })

  try {
    // REPL 交互模式：将代码按 'single' 模式编译（最后一个表达式自动输出）
    // 策略：先尝试 exec 模式编译整体代码，提取最后一个表达式单独用 single 模式
    const replCode = `
import ast as _ast, sys as _sys

_code = ${JSON.stringify(code)}
try:
    _tree = _ast.parse(_code, mode='exec')
except SyntaxError:
    # 语法错误让后面的 exec 报出
    exec(_code)
    _result = None
else:
    _result = None
    if _tree.body and isinstance(_tree.body[-1], _ast.Expr):
        # 最后一条是表达式 → 拆分：前面用 exec，最后一条用 eval
        _last_expr = _tree.body.pop()
        if _tree.body:
            exec(compile(_ast.Module(body=_tree.body, type_ignores=[]), '<input>', 'exec'))
        _result = eval(compile(_ast.Expression(body=_last_expr.value), '<input>', 'eval'))
        if _result is not None:
            _repr = repr(_result)
            print(_repr)
            _ = _result
    else:
        exec(compile(_tree, '<input>', 'exec'))
`

    await pyodide.runPythonAsync(replCode, { globals: persistentGlobals as PyProxy })

    // 获取返回值
    let returnValue: string | undefined
    try {
      const result = persistentGlobals!.get('_result')
      if (result !== undefined && result !== null) {
        returnValue = String(result)
      }
    } catch {
      // _result 可能不存在
    }

    parentPort!.postMessage({
      type: 'result',
      id,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      returnValue
    } satisfies WorkerResponse)
  } catch (err: unknown) {
    parentPort!.postMessage({
      type: 'error',
      id,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      error: err instanceof Error ? err.message : String(err)
    } satisfies WorkerResponse)
  }
}

// ---- 执行队列（确保同一 worker 内串行执行，避免 stdout/stderr handler 竞争） ----

let execQueue: Promise<void> = Promise.resolve()

// ---- 消息处理 ----

parentPort!.on('message', (msg: InitMessage | ExecuteMessage) => {
  if (msg.type === 'init') {
    execQueue = execQueue.then(async () => {
      try {
        await init(msg.mounts, msg.workingDirectory, msg.wheelsDir)
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'error',
          error: `Failed to initialize Pyodide: ${err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err))}`
        } satisfies WorkerResponse)
      }
    })
  } else if (msg.type === 'execute') {
    execQueue = execQueue.then(() => execute(msg.id, msg.code, msg.packages))
  }
})
