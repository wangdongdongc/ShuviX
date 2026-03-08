/**
 * Python 工具集成测试
 * 使用真实的 Pyodide WASM 运行时（通过 worker_threads）
 * 测试：基本执行、REPL 模式、多轮共享作用域、文件系统挂载、预装包、并发执行
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---- 测试目录 ----

const TEST_BASE = join(tmpdir(), 'shuvix-python-test-' + Date.now())
const PROJECT_DIR = join(TEST_BASE, 'project')
const REF_RW_DIR = join(TEST_BASE, 'ref-rw')
const REF_RO_DIR = join(TEST_BASE, 'ref-ro')

const SESSION_ID = 'test-python-session'
const SESSION_ID_2 = 'test-python-session-2'

// ---- Mocks ----

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('../types', () => ({
  BaseTool: class {
    async securityCheck(..._args: unknown[]): Promise<void> {}
    async executeInternal(..._args: unknown[]): Promise<unknown> {
      return {}
    }
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown
    ): Promise<unknown> {
      await this.securityCheck(toolCallId, params, signal)
      return this.executeInternal(toolCallId, params, signal, onUpdate)
    }
  },
  resolveProjectConfig: () => ({
    workingDirectory: PROJECT_DIR,
    sandboxEnabled: true,
    referenceDirs: [
      { path: REF_RW_DIR, access: 'readwrite' },
      { path: REF_RO_DIR, access: 'readonly' }
    ]
  }),
  TOOL_ABORTED: 'Aborted'
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// ---- Import after mocks ----

import { pythonWorkerManager } from '../../services/pythonWorkerManager'
import type { WorkerResponse } from '../utils/pythonWorker'

// Patch private methods to use correct paths in test environment
const WORKER_PATH = resolve(__dirname, '../../../../out/main/pythonWorker.js')
const WHEELS_DIR = resolve(__dirname, '../../../../resources/pyodide-wheels')

vi.spyOn(pythonWorkerManager as any, 'getWorkerPath').mockReturnValue(WORKER_PATH)
vi.spyOn(pythonWorkerManager as any, 'getWheelsDir').mockReturnValue(
  existsSync(WHEELS_DIR) ? WHEELS_DIR : undefined
)

// ---- Helpers ----

async function exec(
  sessionId: string,
  code: string,
  packages?: string[],
  timeoutMs = 30_000
): Promise<WorkerResponse> {
  const id = 'tc-' + Math.random().toString(36).slice(2, 8)
  return pythonWorkerManager.execute(sessionId, id, code, packages, timeoutMs)
}

function getOutput(r: WorkerResponse): string {
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout)
  if (r.stderr) parts.push(r.stderr)
  if (r.error) parts.push(r.error)
  return parts.join('\n')
}

// ---- Setup / Teardown ----

beforeAll(async () => {
  // Create test directory structure
  mkdirSync(PROJECT_DIR, { recursive: true })
  mkdirSync(REF_RW_DIR, { recursive: true })
  mkdirSync(REF_RO_DIR, { recursive: true })

  writeFileSync(join(PROJECT_DIR, 'data.txt'), 'hello from project')
  writeFileSync(join(REF_RW_DIR, 'rw.txt'), 'readwrite ref')
  writeFileSync(join(REF_RO_DIR, 'ro.txt'), 'readonly ref')

  // Initialize the Pyodide worker (this takes ~5-15s)
  const config = {
    workingDirectory: PROJECT_DIR,
    sandboxEnabled: true,
    referenceDirs: [
      { path: REF_RW_DIR, access: 'readwrite' as const },
      { path: REF_RO_DIR, access: 'readonly' as const }
    ]
  }
  await pythonWorkerManager.ensureReady(SESSION_ID, config)
}, 120_000)

afterAll(() => {
  pythonWorkerManager.terminateAll()
  rmSync(TEST_BASE, { recursive: true, force: true })
})

// ---- Tests ----

describe('基本执行', () => {
  it('print 输出', async () => {
    const r = await exec(SESSION_ID, 'print("hello")')
    expect(r.type).toBe('result')
    expect(r.stdout).toContain('hello')
  })

  it('REPL 自动输出表达式', async () => {
    const r = await exec(SESSION_ID, '1 + 1')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('2')
  })

  it('多行语句', async () => {
    const r = await exec(SESSION_ID, 'x = 10\ny = 20\nx + y')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('30')
  })

  it('语法错误', async () => {
    const r = await exec(SESSION_ID, 'def foo(')
    expect(r.type).toBe('error')
    expect(r.error).toContain('SyntaxError')
  })

  it('运行时错误', async () => {
    const r = await exec(SESSION_ID, '1 / 0')
    expect(r.type).toBe('error')
    expect(r.error).toContain('ZeroDivisionError')
  })
})

describe('REPL 交互模式', () => {
  it('字符串表达式自动输出 repr', async () => {
    const r = await exec(SESSION_ID, '"hello"')
    expect(getOutput(r)).toContain("'hello'")
  })

  it('_ 引用上一个结果', async () => {
    await exec(SESSION_ID, '42')
    const r = await exec(SESSION_ID, '_ * 2')
    expect(getOutput(r)).toContain('84')
  })

  it('print 不重复输出', async () => {
    const r = await exec(SESSION_ID, 'print("hi")')
    const output = getOutput(r)
    // "hi" should appear only once (from print), not twice (from print + REPL)
    const count = output.split('hi').length - 1
    expect(count).toBe(1)
  })
})

describe('多轮共享作用域', () => {
  it('变量在后续轮次保留', async () => {
    await exec(SESSION_ID, 'shared_var = 42')
    const r = await exec(SESSION_ID, 'shared_var * 2')
    expect(getOutput(r)).toContain('84')
  })

  it('import 在后续轮次保留', async () => {
    await exec(SESSION_ID, 'import json')
    const r = await exec(SESSION_ID, 'json.dumps({"a": 1})')
    expect(getOutput(r)).toContain('"a"')
  })

  it('函数定义在后续轮次可用', async () => {
    await exec(SESSION_ID, 'def greet(name): return f"Hello, {name}!"')
    const r = await exec(SESSION_ID, 'greet("World")')
    expect(getOutput(r)).toContain('Hello, World!')
  })
})

describe('文件系统挂载 — 项目目录 (readwrite)', () => {
  it('工作目录为项目目录', async () => {
    const r = await exec(SESSION_ID, 'import os; os.getcwd()')
    expect(getOutput(r)).toContain(PROJECT_DIR)
  })

  it('相对路径读取项目文件', async () => {
    const r = await exec(SESSION_ID, `open('data.txt').read()`)
    expect(getOutput(r)).toContain('hello from project')
  })

  it('读取项目目录文件', async () => {
    const r = await exec(SESSION_ID, `open('${PROJECT_DIR}/data.txt').read()`)
    expect(getOutput(r)).toContain('hello from project')
  })

  it('写入项目目录文件', async () => {
    const newFile = join(PROJECT_DIR, 'new_from_python.txt')
    await exec(SESSION_ID, `f = open('${newFile}', 'w')\nf.write('written by python')\nf.close()`)
    // Verify file exists on host
    expect(existsSync(newFile)).toBe(true)
    expect(readFileSync(newFile, 'utf-8')).toBe('written by python')
  })
})

describe('文件系统挂载 — 引用目录 (readwrite)', () => {
  it('读取 readwrite 引用目录', async () => {
    const r = await exec(SESSION_ID, `open('${REF_RW_DIR}/rw.txt').read()`)
    expect(getOutput(r)).toContain('readwrite ref')
  })

  it('写入 readwrite 引用目录', async () => {
    const newFile = join(REF_RW_DIR, 'new_rw.txt')
    await exec(SESSION_ID, `f = open('${newFile}', 'w')\nf.write('rw written')\nf.close()`)
    expect(existsSync(newFile)).toBe(true)
    expect(readFileSync(newFile, 'utf-8')).toBe('rw written')
  })
})

describe('文件系统挂载 — 引用目录 (readonly)', () => {
  it('读取 readonly 引用目录', async () => {
    const r = await exec(SESSION_ID, `open('${REF_RO_DIR}/ro.txt').read()`)
    expect(getOutput(r)).toContain('readonly ref')
  })

  it('写入 readonly 引用目录被拒绝', async () => {
    const r = await exec(SESSION_ID, `open('${REF_RO_DIR}/forbidden.txt', 'w')`)
    expect(r.type).toBe('error')
    expect(r.error).toContain('PermissionError')
  })
})

describe('预装包验证', () => {
  const preinstalledPackages = [
    ['yaml', 'pyyaml'],
    ['bs4', 'beautifulsoup4'],
    ['soupsieve', 'soupsieve'],
    ['dateutil', 'python-dateutil'],
    ['pytz', 'pytz'],
    ['regex', 'regex']
  ]

  for (const [importName, pkgName] of preinstalledPackages) {
    it(`${pkgName} 可直接 import`, async () => {
      const r = await exec(SESSION_ID, `import ${importName}\nprint("${importName} ok")`)
      expect(r.type).toBe('result')
      expect(r.stdout).toContain(`${importName} ok`)
    })
  }
})

describe('并发执行', () => {
  it('同一 session 串行处理多个请求', async () => {
    // Send 3 requests without awaiting — worker processes them in order
    // Use expressions (not print) to avoid stdout batching issues
    const p1 = exec(SESSION_ID, '"first_val"')
    const p2 = exec(SESSION_ID, '"second_val"')
    const p3 = exec(SESSION_ID, '"third_val"')
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    expect(getOutput(r1)).toContain('first_val')
    expect(getOutput(r2)).toContain('second_val')
    expect(getOutput(r3)).toContain('third_val')
  })

  it('不同 session 并行执行互不影响', async () => {
    // Create a second session
    const config2 = {
      workingDirectory: PROJECT_DIR,
      sandboxEnabled: false,
      referenceDirs: []
    }
    await pythonWorkerManager.ensureReady(SESSION_ID_2, config2)

    // Execute in both sessions in parallel
    const [r1, r2] = await Promise.all([
      exec(SESSION_ID, 'session_id = "s1"\nsession_id'),
      exec(SESSION_ID_2, 'session_id = "s2"\nsession_id')
    ])

    expect(getOutput(r1)).toContain("'s1'")
    expect(getOutput(r2)).toContain("'s2'")

    // Verify isolation — session 1's variable doesn't leak
    const r3 = await exec(SESSION_ID_2, 'session_id')
    expect(getOutput(r3)).toContain("'s2'")

    pythonWorkerManager.terminate(SESSION_ID_2)
  }, 120_000)
})

describe('终止与重建', () => {
  it('terminate 后 isActive 返回 false', () => {
    // Session 1 should still be active
    expect(pythonWorkerManager.isActive(SESSION_ID)).toBe(true)
    pythonWorkerManager.terminate(SESSION_ID)
    expect(pythonWorkerManager.isActive(SESSION_ID)).toBe(false)
  })

  it('terminate 后重新 ensureReady 可再次执行', async () => {
    // Small delay to let the old worker's exit event fire before creating a new one
    await new Promise((r) => setTimeout(r, 200))
    const config = {
      workingDirectory: PROJECT_DIR,
      sandboxEnabled: true,
      referenceDirs: [
        { path: REF_RW_DIR, access: 'readwrite' as const },
        { path: REF_RO_DIR, access: 'readonly' as const }
      ]
    }
    await pythonWorkerManager.ensureReady(SESSION_ID, config)
    const r = await exec(SESSION_ID, 'print("reborn")')
    expect(r.type).toBe('result')
    expect(r.stdout).toContain('reborn')
  }, 120_000)
})
