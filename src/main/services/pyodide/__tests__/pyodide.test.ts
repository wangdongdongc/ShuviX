/**
 * Python Worker 集成测试（新 CLI 协议）
 *
 * 使用真实的 Pyodide WASM 运行时（worker_threads）。
 * 覆盖：去 REPL 化、mode 分发、fresh globals 隔离、argv 注入、PYTHONPATH 动态挂载、
 * 文件系统挂载、只读保护、预装包、并发、终止重建。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_BASE = join(tmpdir(), 'shuvix-python-test-' + Date.now())
const PROJECT_DIR = join(TEST_BASE, 'project')
const REF_RW_DIR = join(TEST_BASE, 'ref-rw')
const REF_RO_DIR = join(TEST_BASE, 'ref-ro')
const EXTRA_LIB_DIR = join(TEST_BASE, 'extra-lib')

const SESSION_ID = 'test-python-session'
const SESSION_ID_2 = 'test-python-session-2'

vi.mock('../../toolContext', () => ({
  resolveProjectConfig: (sessionId: string) => {
    const dirs: Record<
      string,
      {
        workingDirectory: string
        referenceDirs: Array<{ path: string; access: 'readonly' | 'readwrite' }>
      }
    > = {
      [SESSION_ID]: {
        workingDirectory: PROJECT_DIR,
        referenceDirs: [
          { path: REF_RW_DIR, access: 'readwrite' },
          { path: REF_RO_DIR, access: 'readonly' }
        ]
      },
      [SESSION_ID_2]: {
        workingDirectory: PROJECT_DIR,
        referenceDirs: []
      }
    }
    return dirs[sessionId] ?? { workingDirectory: PROJECT_DIR, referenceDirs: [] }
  },
  TOOL_ABORTED: 'Aborted'
}))

import { PyodideWorkerManager, type ExecuteRequest } from '../workerManager'
import type { WorkerResponse } from '../pythonWorker'

const pythonWorkerManager = new PyodideWorkerManager()

const REPO_ROOT = resolve(__dirname, '../../../../..')
vi.spyOn(
  pythonWorkerManager as unknown as { getWorkerPath: () => string },
  'getWorkerPath'
).mockReturnValue(join(REPO_ROOT, 'out/main/pythonWorker.js'))
vi.spyOn(
  pythonWorkerManager as unknown as { getWheelsDir: () => string | undefined },
  'getWheelsDir'
).mockReturnValue(join(REPO_ROOT, 'resources/pyodide/pyodide-wheels'))

let execCounter = 0
async function run(
  sessionId: string,
  request: ExecuteRequest,
  timeoutMs = 30_000
): Promise<WorkerResponse> {
  const id = 'tc-' + ++execCounter
  return pythonWorkerManager.execute(sessionId, id, request, timeoutMs)
}

async function dashC(
  sessionId: string,
  code: string,
  extraArgs: string[] = []
): Promise<WorkerResponse> {
  return run(sessionId, { mode: '-c', code, pythonArgv: ['-c', ...extraArgs] })
}

beforeAll(async () => {
  mkdirSync(PROJECT_DIR, { recursive: true })
  mkdirSync(REF_RW_DIR, { recursive: true })
  mkdirSync(REF_RO_DIR, { recursive: true })
  mkdirSync(EXTRA_LIB_DIR, { recursive: true })

  writeFileSync(join(PROJECT_DIR, 'data.txt'), 'hello from project')
  writeFileSync(join(REF_RW_DIR, 'rw.txt'), 'readwrite ref')
  writeFileSync(join(REF_RO_DIR, 'ro.txt'), 'readonly ref')
  writeFileSync(join(EXTRA_LIB_DIR, 'mylib.py'), 'def hello(): return "from-extra-lib"\n')

  await pythonWorkerManager.ensureReady(SESSION_ID)
}, 120_000)

afterAll(() => {
  pythonWorkerManager.terminateAll()
  rmSync(TEST_BASE, { recursive: true, force: true })
})

describe('-c 模式基本执行', () => {
  it('print 输出到 stdout，exitCode 0', async () => {
    const r = await dashC(SESSION_ID, 'print("hello")')
    expect(r.stdout).toContain('hello')
    expect(r.exitCode).toBe(0)
  })

  it('裸表达式不再自动 print（无 REPL 行为）', async () => {
    const r = await dashC(SESSION_ID, '1 + 1')
    expect(r.stdout ?? '').toBe('')
    expect(r.exitCode).toBe(0)
  })

  it('运行时异常 → exitCode 1，traceback 进 stderr', async () => {
    const r = await dashC(SESSION_ID, '1 / 0')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('ZeroDivisionError')
  })

  it('SyntaxError → exitCode 1', async () => {
    const r = await dashC(SESSION_ID, 'def foo(')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('SyntaxError')
  })

  it('sys.exit(2) 透传退出码', async () => {
    const r = await dashC(SESSION_ID, 'import sys; sys.exit(2)')
    expect(r.exitCode).toBe(2)
  })

  it('sys.exit("msg") → 退出码 1，msg 进 stderr', async () => {
    const r = await dashC(SESSION_ID, 'import sys; sys.exit("bad")')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('bad')
  })
})

describe('sys.argv 注入', () => {
  it('-c 模式后续参数进 sys.argv', async () => {
    const r = await dashC(SESSION_ID, 'import sys; print("|".join(sys.argv))', ['a', 'b'])
    expect(r.stdout).toContain('-c|a|b')
  })

  it('-c 单独时 sys.argv = ["-c"]', async () => {
    const r = await dashC(SESSION_ID, 'import sys; print(len(sys.argv), sys.argv[0])')
    expect(r.stdout).toContain('1 -c')
  })
})

describe('每次调用 fresh globals', () => {
  it('-c 设置的变量不会泄漏到下一次调用', async () => {
    await dashC(SESSION_ID, 'leaky_var = 999')
    const r = await dashC(SESSION_ID, 'print(leaky_var if "leaky_var" in dir() else "absent")')
    expect(r.stdout).toContain('absent')
  })

  it('import 的模块对象不在 globals，但 sys.modules 缓存仍然命中', async () => {
    await dashC(SESSION_ID, 'import json; json.dumps({"a": 1})')
    // 新一轮 globals 是空的，但 import json 走 sys.modules 缓存（同进程内）
    const r = await dashC(SESSION_ID, 'import json; print(json.dumps({"b": 2}))')
    expect(r.stdout).toContain('"b": 2')
  })
})

describe('-m 模式', () => {
  it('runpy 跑标准库模块', async () => {
    // base64 是 stdlib 自带的可执行模块
    const r = await run(SESSION_ID, {
      mode: '-m',
      code: '',
      target: 'base64',
      pythonArgv: ['base64', '-h']
    })
    // base64 -h 打印 usage 到 stdout 或 stderr，并 sys.exit(0)
    expect((r.stdout ?? '') + (r.stderr ?? '')).toMatch(/usage|Usage/i)
  })

  it('未知模块 → exitCode 1，stderr 含 ModuleNotFoundError', async () => {
    const r = await run(SESSION_ID, {
      mode: '-m',
      code: '',
      target: 'no_such_module_xyz',
      pythonArgv: ['no_such_module_xyz']
    })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/ModuleNotFoundError|No module named/)
  })
})

describe('script 模式', () => {
  it('runpy.run_path 跑项目目录里的 .py 文件', async () => {
    const scriptPath = join(PROJECT_DIR, 'hello.py')
    writeFileSync(
      scriptPath,
      'import sys\nprint("script-ran", sys.argv[1] if len(sys.argv) > 1 else "noarg")\n'
    )
    const r = await run(SESSION_ID, {
      mode: 'script',
      code: '',
      target: scriptPath,
      pythonArgv: [scriptPath, 'hi']
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('script-ran hi')
  })
})

describe('stdin 模式', () => {
  it('当 mode=stdin 时，code 字段携带的内容作为 stdin 程序执行', async () => {
    const r = await run(SESSION_ID, {
      mode: 'stdin',
      code: 'print("from-stdin")',
      pythonArgv: ['-']
    })
    expect(r.stdout).toContain('from-stdin')
  })
})

describe('version 模式', () => {
  it('打印 Python 版本号', async () => {
    const r = await run(SESSION_ID, { mode: 'version', code: '', pythonArgv: ['python'] })
    expect(r.stdout).toMatch(/Python \d+\.\d+/)
    expect(r.exitCode).toBe(0)
  })
})

describe('cwd 注入', () => {
  it('execute 传 cwd 时 os.getcwd 返回该路径', async () => {
    const r = await run(SESSION_ID, {
      mode: '-c',
      code: 'import os; print(os.getcwd())',
      pythonArgv: ['-c'],
      cwd: REF_RW_DIR
    })
    expect(r.stdout).toContain(REF_RW_DIR)
  })

  it('未传 cwd 时默认 workingDirectory', async () => {
    const r = await dashC(SESSION_ID, 'import os; print(os.getcwd())')
    expect(r.stdout).toContain(PROJECT_DIR)
  })
})

describe('PYTHONPATH 动态挂载', () => {
  it('挂载 EXTRA_LIB_DIR 后能 import 其中的模块', async () => {
    const r = await run(SESSION_ID, {
      mode: '-c',
      code: 'import mylib; print(mylib.hello())',
      pythonArgv: ['-c'],
      pythonPathDirs: [EXTRA_LIB_DIR]
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('from-extra-lib')
  })
})

describe('文件系统 — 工作目录 (readwrite)', () => {
  it('相对路径读项目文件', async () => {
    const r = await dashC(SESSION_ID, `print(open('data.txt').read())`)
    expect(r.stdout).toContain('hello from project')
  })

  it('绝对路径写项目文件', async () => {
    const newFile = join(PROJECT_DIR, 'new_from_python.txt')
    const code = `f=open(${JSON.stringify(newFile)},'w'); f.write('written by python'); f.close()`
    const r = await dashC(SESSION_ID, code)
    expect(r.exitCode).toBe(0)
    expect(existsSync(newFile)).toBe(true)
    expect(readFileSync(newFile, 'utf-8')).toBe('written by python')
  })
})

describe('文件系统 — 引用目录 (readwrite)', () => {
  it('读 readwrite 引用目录', async () => {
    const r = await dashC(
      SESSION_ID,
      `print(open(${JSON.stringify(join(REF_RW_DIR, 'rw.txt'))}).read())`
    )
    expect(r.stdout).toContain('readwrite ref')
  })

  it('写 readwrite 引用目录成功', async () => {
    const newFile = join(REF_RW_DIR, 'new_rw.txt')
    const code = `f=open(${JSON.stringify(newFile)},'w'); f.write('rw written'); f.close()`
    await dashC(SESSION_ID, code)
    expect(existsSync(newFile)).toBe(true)
    expect(readFileSync(newFile, 'utf-8')).toBe('rw written')
  })
})

describe('文件系统 — 引用目录 (readonly)', () => {
  it('读 readonly 引用目录', async () => {
    const r = await dashC(
      SESSION_ID,
      `print(open(${JSON.stringify(join(REF_RO_DIR, 'ro.txt'))}).read())`
    )
    expect(r.stdout).toContain('readonly ref')
  })

  it('写 readonly 引用目录被拒（PermissionError）', async () => {
    const r = await dashC(
      SESSION_ID,
      `open(${JSON.stringify(join(REF_RO_DIR, 'forbidden.txt'))}, 'w')`
    )
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('PermissionError')
  })
})

describe('预装包验证', () => {
  const preinstalled = [
    ['yaml', 'pyyaml'],
    ['bs4', 'beautifulsoup4'],
    ['dateutil', 'python-dateutil'],
    ['pytz', 'pytz'],
    ['regex', 'regex']
  ]

  for (const [importName, pkgName] of preinstalled) {
    it(`${pkgName} 可直接 import`, async () => {
      const r = await dashC(SESSION_ID, `import ${importName}; print("${importName} ok")`)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain(`${importName} ok`)
    })
  }
})

describe('并发执行（同 session 串行）', () => {
  it('多个 execute 顺序处理', async () => {
    const p1 = dashC(SESSION_ID, 'print("first")')
    const p2 = dashC(SESSION_ID, 'print("second")')
    const p3 = dashC(SESSION_ID, 'print("third")')
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.stdout).toContain('first')
    expect(r2.stdout).toContain('second')
    expect(r3.stdout).toContain('third')
  })

  it('不同 session 并行执行互不影响', async () => {
    await pythonWorkerManager.ensureReady(SESSION_ID_2)
    // 各自 session 内可以独立 import + 用 sys.modules 缓存，不会因为 fresh globals 互相污染
    const [r1, r2] = await Promise.all([
      dashC(SESSION_ID, 'print("S1")'),
      dashC(SESSION_ID_2, 'print("S2")')
    ])
    expect(r1.stdout).toContain('S1')
    expect(r2.stdout).toContain('S2')
    pythonWorkerManager.terminate(SESSION_ID_2)
  }, 120_000)
})

describe('终止与重建', () => {
  it('terminate 后 isActive=false', () => {
    expect(pythonWorkerManager.isActive(SESSION_ID)).toBe(true)
    pythonWorkerManager.terminate(SESSION_ID)
    expect(pythonWorkerManager.isActive(SESSION_ID)).toBe(false)
  })

  it('terminate 后 ensureReady 可再次执行', async () => {
    await new Promise((r) => setTimeout(r, 200))
    await pythonWorkerManager.ensureReady(SESSION_ID)
    const r = await dashC(SESSION_ID, 'print("reborn")')
    expect(r.stdout).toContain('reborn')
  }, 120_000)
})
