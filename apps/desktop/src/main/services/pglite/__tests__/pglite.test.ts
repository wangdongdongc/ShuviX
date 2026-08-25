/**
 * PGLite 运行时集成测试
 * 使用真实的 PGLite WASM 运行时（通过 worker_threads）
 * 覆盖：基本执行、多语句、跨调用状态、结果格式化、扩展、高级特性、并发、多 worker 隔离
 *
 * 寻址方式与生产一致：workerKey + dataDir（会话/项目级入口已移除）。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// ---- 测试目录 ----

const TEST_BASE = join(tmpdir(), 'shuvix-sql-test-' + Date.now())
const DATA_DIR = join(TEST_BASE, 'db')
const DATA_DIR_2 = join(TEST_BASE, 'db2')

const KEY = 'test:main'
const KEY_2 = 'test:second'

// ---- Mocks ----

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

import { PgliteWorkerManager } from '../workerManager'
import type { WorkerResponse } from '../sqlWorker'

const workerManager = new PgliteWorkerManager()

// Patch worker path to use built output in test environment
// __dirname = src/main/services/pglite/__tests__ → repo root 是 5 个 ..
const WORKER_PATH = resolve(__dirname, '../../../../../out/main/sqlWorker.js')
vi.spyOn(
  workerManager as unknown as { getWorkerPath: () => string },
  'getWorkerPath'
).mockReturnValue(WORKER_PATH)

// ---- Helpers ----

async function exec(workerKey: string, sql: string, timeoutMs = 30_000): Promise<WorkerResponse> {
  const id = 'tc-' + Math.random().toString(36).slice(2, 8)
  return workerManager.executeOnWorker(workerKey, id, sql, timeoutMs)
}

function getOutput(r: WorkerResponse): string {
  if (r.type === 'error') return r.error || ''
  return r.output || ''
}

// ---- Setup / Teardown ----

beforeAll(async () => {
  mkdirSync(TEST_BASE, { recursive: true })
  // Initialize the PGLite worker (~3-5s)
  await workerManager.ensureWorkerByKey(KEY, DATA_DIR)
}, 120_000)

afterAll(() => {
  workerManager.terminateAll()
  rmSync(TEST_BASE, { recursive: true, force: true })
})

// ---- Tests ----

describe('基本执行', () => {
  it('基础查询返回结果', async () => {
    const r = await exec(KEY, 'SELECT 1+1 AS result')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('2')
    expect(r.rowCount).toBe(1)
    expect(r.columnCount).toBe(1)
  })

  it('字符串值', async () => {
    const r = await exec(KEY, "SELECT 'hello' AS greeting")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('hello')
  })

  it('语法错误', async () => {
    const r = await exec(KEY, 'SELEC 1')
    expect(r.type).toBe('error')
    expect(r.error).toBeTruthy()
  })

  it('运行时错误 — 除零', async () => {
    const r = await exec(KEY, 'SELECT 1/0')
    expect(r.type).toBe('error')
    expect(r.error).toContain('division by zero')
  })
})

describe('多语句执行', () => {
  it('CREATE + INSERT + SELECT 一次执行', async () => {
    const r = await exec(
      KEY,
      `CREATE TABLE multi_test(id int, name text);
       INSERT INTO multi_test VALUES(1, 'one'), (2, 'two');
       SELECT * FROM multi_test ORDER BY id`
    )
    expect(r.type).toBe('result')
    const output = getOutput(r)
    expect(output).toContain('one')
    expect(output).toContain('two')
    expect(r.rowCount).toBeGreaterThanOrEqual(2)

    // Cleanup
    await exec(KEY, 'DROP TABLE multi_test')
  })

  it('DDL 返回 OK', async () => {
    const r = await exec(KEY, 'CREATE TABLE ddl_test(id int)')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('OK')
    await exec(KEY, 'DROP TABLE ddl_test')
  })

  it('DML 返回 affected rows', async () => {
    await exec(KEY, 'CREATE TABLE dml_test(id int)')
    const rInsert = await exec(KEY, 'INSERT INTO dml_test VALUES(1),(2),(3)')
    expect(rInsert.type).toBe('result')
    expect(getOutput(rInsert)).toMatch(/3/)

    const rUpdate = await exec(KEY, 'UPDATE dml_test SET id = id + 10 WHERE id > 1')
    expect(rUpdate.type).toBe('result')
    expect(getOutput(rUpdate)).toMatch(/2/)

    const rDelete = await exec(KEY, 'DELETE FROM dml_test WHERE id = 1')
    expect(rDelete.type).toBe('result')
    expect(getOutput(rDelete)).toMatch(/1/)

    await exec(KEY, 'DROP TABLE dml_test')
  })
})

describe('多轮共享状态', () => {
  it('表和数据跨调用保留', async () => {
    await exec(KEY, 'CREATE TABLE persist_test(id int, val text)')
    await exec(KEY, "INSERT INTO persist_test VALUES(1, 'a'), (2, 'b')")
    const r = await exec(KEY, 'SELECT * FROM persist_test ORDER BY id')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('a')
    expect(getOutput(r)).toContain('b')
    await exec(KEY, 'DROP TABLE persist_test')
  })

  it('函数跨调用保留', async () => {
    await exec(
      KEY,
      'CREATE FUNCTION test_add(a int, b int) RETURNS int AS $$ SELECT a + b $$ LANGUAGE SQL'
    )
    const r = await exec(KEY, 'SELECT test_add(3, 4) AS sum')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('7')
    await exec(KEY, 'DROP FUNCTION test_add')
  })

  it('视图跨调用保留', async () => {
    await exec(KEY, 'CREATE TABLE view_base(id int)')
    await exec(KEY, 'INSERT INTO view_base VALUES(10),(20)')
    await exec(KEY, 'CREATE VIEW view_test AS SELECT id * 2 AS doubled FROM view_base')
    const r = await exec(KEY, 'SELECT * FROM view_test ORDER BY doubled')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('20')
    expect(getOutput(r)).toContain('40')
    await exec(KEY, 'DROP VIEW view_test')
    await exec(KEY, 'DROP TABLE view_base')
  })
})

describe('结果格式化', () => {
  it('psql 风格表格输出', async () => {
    const r = await exec(KEY, "SELECT 1 AS id, 'Alice' AS name UNION ALL SELECT 2, 'Bob'")
    const output = getOutput(r)
    expect(output).toContain('id')
    expect(output).toContain('name')
    expect(output).toMatch(/[-]+\+[-]+/)
    expect(output).toContain('(2 rows)')
  })

  it('NULL 值显示为空', async () => {
    const r = await exec(KEY, 'SELECT NULL AS empty_col')
    expect(r.type).toBe('result')
    const output = getOutput(r)
    expect(output).toContain('empty_col')
    expect(output).not.toContain('null')
  })

  it('多结果集用空行分隔', async () => {
    const r = await exec(KEY, "SELECT 'first' AS tag; SELECT 'second' AS tag")
    const output = getOutput(r)
    expect(output).toContain('first')
    expect(output).toContain('second')
    expect(output).toMatch(/\(1 rows\)\n\n/)
  })
})

describe('结构化查询（REST 路径）', () => {
  it('参数化 query 返回行数组而非文本', async () => {
    await exec(KEY, 'CREATE TABLE q_test(id int, name text)')
    await exec(KEY, "INSERT INTO q_test VALUES(1, 'x'), (2, 'y')")
    const r = await workerManager.queryOnWorker(
      KEY,
      'q-1',
      'SELECT * FROM q_test WHERE id = $1',
      [2]
    )
    expect(r.type).toBe('result')
    expect(r.rows).toEqual([{ id: 2, name: 'y' }])
    expect(r.fields?.map((f) => f.name)).toEqual(['id', 'name'])
    await exec(KEY, 'DROP TABLE q_test')
  })
})

describe('扩展加载（SQL 层 CREATE EXTENSION —— widget 引导路径）', () => {
  it('pg_trgm — 模糊匹配', async () => {
    await exec(KEY, 'CREATE EXTENSION IF NOT EXISTS "pg_trgm"')
    const r = await exec(KEY, "SELECT similarity('hello', 'helo') AS sim")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toMatch(/0\.\d+/)
  })

  it('uuid-ossp — UUID 生成', async () => {
    await exec(KEY, 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    const r = await exec(KEY, 'SELECT uuid_generate_v4() AS uuid')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('citext — 大小写不敏感比较', async () => {
    await exec(KEY, 'CREATE EXTENSION IF NOT EXISTS "citext"')
    await exec(KEY, 'CREATE TABLE ci_test(name citext)')
    await exec(KEY, "INSERT INTO ci_test VALUES('Hello')")
    const r = await exec(KEY, "SELECT * FROM ci_test WHERE name = 'hello'")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('Hello')
    await exec(KEY, 'DROP TABLE ci_test')
  })
})

describe('PostgreSQL 高级特性', () => {
  it('Window functions', async () => {
    const r = await exec(
      KEY,
      `SELECT val, ROW_NUMBER() OVER(ORDER BY val) AS rn
       FROM (VALUES (30),(10),(20)) AS t(val)`
    )
    expect(r.type).toBe('result')
    const output = getOutput(r)
    expect(output).toContain('rn')
    expect(r.rowCount).toBe(3)
  })

  it('CTE', async () => {
    const r = await exec(
      KEY,
      `WITH nums AS (SELECT generate_series(1, 5) AS n)
       SELECT sum(n) AS total FROM nums`
    )
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('15')
  })

  it('JSON 操作', async () => {
    const r = await exec(KEY, "SELECT '{\"a\":1}'::jsonb -> 'a' AS val")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('1')
  })

  it('Array 操作', async () => {
    const r = await exec(KEY, 'SELECT ARRAY[1,2,3] AS arr')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('1,2,3')
  })
})

describe('并发与隔离', () => {
  it('同一 worker 串行处理多个请求', async () => {
    const p1 = exec(KEY, "SELECT 'first_val' AS tag")
    const p2 = exec(KEY, "SELECT 'second_val' AS tag")
    const p3 = exec(KEY, "SELECT 'third_val' AS tag")
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    expect(getOutput(r1)).toContain('first_val')
    expect(getOutput(r2)).toContain('second_val')
    expect(getOutput(r3)).toContain('third_val')
  })

  it('不同 workerKey 各自独立', async () => {
    await workerManager.ensureWorkerByKey(KEY_2, DATA_DIR_2)

    const [r1, r2] = await Promise.all([
      exec(KEY, "SELECT 'w1' AS which"),
      exec(KEY_2, "SELECT 'w2' AS which")
    ])
    expect(getOutput(r1)).toContain('w1')
    expect(getOutput(r2)).toContain('w2')

    // 在 worker 2 建表 —— worker 1 看不见
    await exec(KEY_2, 'CREATE TABLE w2_only(id int)')
    const r3 = await exec(KEY, 'SELECT * FROM w2_only')
    expect(r3.type).toBe('error')
    expect(r3.error).toContain('w2_only')
  }, 120_000)
})

describe('持久化', () => {
  it('terminateAll 后重新起 worker，数据仍在 dataDir 里', async () => {
    await exec(KEY, 'CREATE TABLE durable(id int)')
    await exec(KEY, 'INSERT INTO durable VALUES(42)')

    workerManager.terminateAll()
    await new Promise((r) => setTimeout(r, 200))
    await workerManager.ensureWorkerByKey(KEY, DATA_DIR)

    const r = await exec(KEY, 'SELECT * FROM durable')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('42')
    await exec(KEY, 'DROP TABLE durable')
  }, 120_000)

  it('worker 未就绪时调用会明确报错', async () => {
    await expect(workerManager.executeOnWorker('nope:missing', 'x', 'SELECT 1')).rejects.toThrow(
      /not ready/
    )
  })
})
