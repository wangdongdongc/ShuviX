/**
 * SQL 工具集成测试
 * 使用真实的 PGLite WASM 运行时（通过 worker_threads）
 * 测试：基本执行、多语句、多轮共享状态、结果格式化、文件系统挂载、扩展加载、高级特性、并发执行
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---- 测试目录 ----

const TEST_BASE = join(tmpdir(), 'shuvix-sql-test-' + Date.now())
const PROJECT_DIR = join(TEST_BASE, 'project')
const REF_RW_DIR = join(TEST_BASE, 'ref-rw')
const REF_RO_DIR = join(TEST_BASE, 'ref-ro')

const SESSION_ID = 'test-sql-session'
const SESSION_ID_2 = 'test-sql-session-2'

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

import { sqlWorkerManager } from '../../services/sqlWorkerManager'
import type { WorkerResponse } from '../utils/sqlWorker'

// Patch private methods to use correct paths in test environment
const WORKER_PATH = resolve(__dirname, '../../../../out/main/sqlWorker.js')

vi.spyOn(sqlWorkerManager as any, 'getWorkerPath').mockReturnValue(WORKER_PATH)

// ---- Helpers ----

async function exec(
  sessionId: string,
  sql: string,
  extensions?: string[],
  timeoutMs = 30_000
): Promise<WorkerResponse> {
  const id = 'tc-' + Math.random().toString(36).slice(2, 8)
  return sqlWorkerManager.execute(sessionId, id, sql, extensions, timeoutMs)
}

function getOutput(r: WorkerResponse): string {
  if (r.type === 'error') return r.error || ''
  return r.output || ''
}

// ---- Setup / Teardown ----

beforeAll(async () => {
  // Create test directory structure
  mkdirSync(PROJECT_DIR, { recursive: true })
  mkdirSync(REF_RW_DIR, { recursive: true })
  mkdirSync(REF_RO_DIR, { recursive: true })

  // Create test CSV files
  writeFileSync(
    join(PROJECT_DIR, 'data.csv'),
    'id,name,score\n1,Alice,95.5\n2,Bob,87.3\n3,Carol,91.0\n'
  )
  writeFileSync(join(REF_RW_DIR, 'rw_data.csv'), 'id,value\n10,aaa\n20,bbb\n')
  writeFileSync(join(REF_RO_DIR, 'ro_data.csv'), 'id,label\n100,x\n200,y\n')

  // Initialize the PGLite worker (~3-5s)
  const config = {
    workingDirectory: PROJECT_DIR,
    referenceDirs: [
      { path: REF_RW_DIR, access: 'readwrite' as const },
      { path: REF_RO_DIR, access: 'readonly' as const }
    ]
  }
  await sqlWorkerManager.ensureReady(SESSION_ID, config)
}, 120_000)

afterAll(() => {
  sqlWorkerManager.terminateAll()
  rmSync(TEST_BASE, { recursive: true, force: true })
})

// ---- Tests ----

describe('基本执行', () => {
  it('基础查询返回结果', async () => {
    const r = await exec(SESSION_ID, 'SELECT 1+1 AS result')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('2')
    expect(r.rowCount).toBe(1)
    expect(r.columnCount).toBe(1)
  })

  it('字符串值', async () => {
    const r = await exec(SESSION_ID, "SELECT 'hello' AS greeting")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('hello')
  })

  it('语法错误', async () => {
    const r = await exec(SESSION_ID, 'SELEC 1')
    expect(r.type).toBe('error')
    expect(r.error).toBeTruthy()
  })

  it('运行时错误 — 除零', async () => {
    const r = await exec(SESSION_ID, 'SELECT 1/0')
    expect(r.type).toBe('error')
    expect(r.error).toContain('division by zero')
  })
})

describe('多语句执行', () => {
  it('CREATE + INSERT + SELECT 一次执行', async () => {
    const r = await exec(
      SESSION_ID,
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
    await exec(SESSION_ID, 'DROP TABLE multi_test')
  })

  it('DDL 返回 OK', async () => {
    const r = await exec(SESSION_ID, 'CREATE TABLE ddl_test(id int)')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('OK')
    await exec(SESSION_ID, 'DROP TABLE ddl_test')
  })

  it('DML 返回 affected rows', async () => {
    await exec(SESSION_ID, 'CREATE TABLE dml_test(id int)')
    const rInsert = await exec(SESSION_ID, 'INSERT INTO dml_test VALUES(1),(2),(3)')
    expect(rInsert.type).toBe('result')
    expect(getOutput(rInsert)).toMatch(/3/) // affected rows count

    const rUpdate = await exec(SESSION_ID, 'UPDATE dml_test SET id = id + 10 WHERE id > 1')
    expect(rUpdate.type).toBe('result')
    expect(getOutput(rUpdate)).toMatch(/2/) // 2 rows updated

    const rDelete = await exec(SESSION_ID, 'DELETE FROM dml_test WHERE id = 1')
    expect(rDelete.type).toBe('result')
    expect(getOutput(rDelete)).toMatch(/1/) // 1 row deleted

    await exec(SESSION_ID, 'DROP TABLE dml_test')
  })
})

describe('多轮共享状态', () => {
  it('表和数据跨调用保留', async () => {
    await exec(SESSION_ID, 'CREATE TABLE persist_test(id int, val text)')
    await exec(SESSION_ID, "INSERT INTO persist_test VALUES(1, 'a'), (2, 'b')")
    const r = await exec(SESSION_ID, 'SELECT * FROM persist_test ORDER BY id')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('a')
    expect(getOutput(r)).toContain('b')
    await exec(SESSION_ID, 'DROP TABLE persist_test')
  })

  it('函数跨调用保留', async () => {
    await exec(
      SESSION_ID,
      'CREATE FUNCTION test_add(a int, b int) RETURNS int AS $$ SELECT a + b $$ LANGUAGE SQL'
    )
    const r = await exec(SESSION_ID, 'SELECT test_add(3, 4) AS sum')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('7')
    await exec(SESSION_ID, 'DROP FUNCTION test_add')
  })

  it('视图跨调用保留', async () => {
    await exec(SESSION_ID, 'CREATE TABLE view_base(id int)')
    await exec(SESSION_ID, 'INSERT INTO view_base VALUES(10),(20)')
    await exec(SESSION_ID, 'CREATE VIEW view_test AS SELECT id * 2 AS doubled FROM view_base')
    const r = await exec(SESSION_ID, 'SELECT * FROM view_test ORDER BY doubled')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('20')
    expect(getOutput(r)).toContain('40')
    await exec(SESSION_ID, 'DROP VIEW view_test')
    await exec(SESSION_ID, 'DROP TABLE view_base')
  })
})

describe('结果格式化', () => {
  it('psql 风格表格输出', async () => {
    const r = await exec(SESSION_ID, "SELECT 1 AS id, 'Alice' AS name UNION ALL SELECT 2, 'Bob'")
    const output = getOutput(r)
    // 表头
    expect(output).toContain('id')
    expect(output).toContain('name')
    // 分隔线
    expect(output).toMatch(/[-]+\+[-]+/)
    // 行数统计
    expect(output).toContain('(2 rows)')
  })

  it('NULL 值显示为空', async () => {
    const r = await exec(SESSION_ID, 'SELECT NULL AS empty_col')
    expect(r.type).toBe('result')
    // NULL should render as empty (not the string "null")
    const output = getOutput(r)
    expect(output).toContain('empty_col')
    expect(output).not.toContain('null')
  })

  it('多结果集用空行分隔', async () => {
    const r = await exec(SESSION_ID, "SELECT 'first' AS tag; SELECT 'second' AS tag")
    const output = getOutput(r)
    expect(output).toContain('first')
    expect(output).toContain('second')
    // 两个结果集之间有空行
    expect(output).toMatch(/\(1 rows\)\n\n/)
  })
})

describe('文件系统挂载 — 项目目录', () => {
  it('COPY FROM 导入 CSV 文件', async () => {
    const csvPath = join(PROJECT_DIR, 'data.csv')
    await exec(SESSION_ID, 'CREATE TABLE csv_import(id int, name text, score float)')
    const r = await exec(
      SESSION_ID,
      `COPY csv_import FROM '${csvPath}' WITH (FORMAT csv, HEADER true);
       SELECT * FROM csv_import ORDER BY id`
    )
    expect(r.type).toBe('result')
    const output = getOutput(r)
    expect(output).toContain('Alice')
    expect(output).toContain('Bob')
    expect(output).toContain('Carol')
    expect(r.rowCount).toBeGreaterThanOrEqual(3)
    await exec(SESSION_ID, 'DROP TABLE csv_import')
  })

  it('COPY TO 写出文件到项目目录', async () => {
    await exec(SESSION_ID, 'CREATE TABLE csv_export(id int, msg text)')
    await exec(SESSION_ID, "INSERT INTO csv_export VALUES(1, 'exported')")
    const outPath = join(PROJECT_DIR, 'export_out.csv')
    await exec(SESSION_ID, `COPY csv_export TO '${outPath}' WITH (FORMAT csv, HEADER true)`)
    // Verify file exists on host
    expect(existsSync(outPath)).toBe(true)
    const content = readFileSync(outPath, 'utf-8')
    expect(content).toContain('exported')
    await exec(SESSION_ID, 'DROP TABLE csv_export')
  })
})

describe('文件系统挂载 — 引用目录', () => {
  it('读取 readwrite 引用目录中的 CSV', async () => {
    const csvPath = join(REF_RW_DIR, 'rw_data.csv')
    await exec(SESSION_ID, 'CREATE TABLE rw_import(id int, value text)')
    const r = await exec(
      SESSION_ID,
      `COPY rw_import FROM '${csvPath}' WITH (FORMAT csv, HEADER true);
       SELECT * FROM rw_import ORDER BY id`
    )
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('aaa')
    expect(getOutput(r)).toContain('bbb')
    await exec(SESSION_ID, 'DROP TABLE rw_import')
  })

  it('读取 readonly 引用目录中的 CSV', async () => {
    const csvPath = join(REF_RO_DIR, 'ro_data.csv')
    await exec(SESSION_ID, 'CREATE TABLE ro_import(id int, label text)')
    const r = await exec(
      SESSION_ID,
      `COPY ro_import FROM '${csvPath}' WITH (FORMAT csv, HEADER true);
       SELECT * FROM ro_import ORDER BY id`
    )
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('x')
    expect(getOutput(r)).toContain('y')
    await exec(SESSION_ID, 'DROP TABLE ro_import')
  })
})

describe('扩展加载', () => {
  it('pg_trgm — 模糊匹配', async () => {
    const r = await exec(SESSION_ID, "SELECT similarity('hello', 'helo') AS sim", ['pg_trgm'])
    expect(r.type).toBe('result')
    const output = getOutput(r)
    // similarity returns a float between 0 and 1
    expect(output).toMatch(/0\.\d+/)
  })

  it('uuid-ossp — UUID 生成', async () => {
    const r = await exec(SESSION_ID, 'SELECT uuid_generate_v4() AS uuid', ['uuid-ossp'])
    expect(r.type).toBe('result')
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(getOutput(r)).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('citext — 大小写不敏感比较', async () => {
    await exec(SESSION_ID, 'CREATE TABLE ci_test(name citext)', ['citext'])
    await exec(SESSION_ID, "INSERT INTO ci_test VALUES('Hello')")
    const r = await exec(SESSION_ID, "SELECT * FROM ci_test WHERE name = 'hello'")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('Hello')
    await exec(SESSION_ID, 'DROP TABLE ci_test')
  })
})

describe('PostgreSQL 高级特性', () => {
  it('Window functions', async () => {
    const r = await exec(
      SESSION_ID,
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
      SESSION_ID,
      `WITH nums AS (SELECT generate_series(1, 5) AS n)
       SELECT sum(n) AS total FROM nums`
    )
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('15')
  })

  it('JSON 操作', async () => {
    const r = await exec(SESSION_ID, "SELECT '{\"a\":1}'::jsonb -> 'a' AS val")
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('1')
  })

  it('Array 操作', async () => {
    const r = await exec(SESSION_ID, 'SELECT ARRAY[1,2,3] AS arr')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('1,2,3')
  })
})

describe('并发执行', () => {
  it('同一 session 串行处理多个请求', async () => {
    const p1 = exec(SESSION_ID, "SELECT 'first_val' AS tag")
    const p2 = exec(SESSION_ID, "SELECT 'second_val' AS tag")
    const p3 = exec(SESSION_ID, "SELECT 'third_val' AS tag")
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    expect(getOutput(r1)).toContain('first_val')
    expect(getOutput(r2)).toContain('second_val')
    expect(getOutput(r3)).toContain('third_val')
  })

  it('不同 session 并行执行互不影响', async () => {
    const config2 = {
      workingDirectory: PROJECT_DIR,
      referenceDirs: []
    }
    await sqlWorkerManager.ensureReady(SESSION_ID_2, config2)

    // Execute in both sessions in parallel
    const [r1, r2] = await Promise.all([
      exec(SESSION_ID, "SELECT 's1' AS sid"),
      exec(SESSION_ID_2, "SELECT 's2' AS sid")
    ])

    expect(getOutput(r1)).toContain('s1')
    expect(getOutput(r2)).toContain('s2')

    // Create table in session 2 — should not be visible in session 1
    await exec(SESSION_ID_2, 'CREATE TABLE s2_only(id int)')
    const r3 = await exec(SESSION_ID, 'SELECT * FROM s2_only')
    expect(r3.type).toBe('error')
    expect(r3.error).toContain('s2_only')

    sqlWorkerManager.terminate(SESSION_ID_2)
  }, 120_000)
})

describe('终止与重建', () => {
  it('terminate 后 getStatus 返回 null', () => {
    expect(sqlWorkerManager.getStatus(SESSION_ID)).not.toBeNull()
    sqlWorkerManager.terminate(SESSION_ID)
    expect(sqlWorkerManager.getStatus(SESSION_ID)).toBeNull()
  })

  it('terminate 后重新 ensureReady 可再次执行', async () => {
    await new Promise((r) => setTimeout(r, 200))
    const config = {
      workingDirectory: PROJECT_DIR,
      referenceDirs: [
        { path: REF_RW_DIR, access: 'readwrite' as const },
        { path: REF_RO_DIR, access: 'readonly' as const }
      ]
    }
    await sqlWorkerManager.ensureReady(SESSION_ID, config)
    const r = await exec(SESSION_ID, 'SELECT 42 AS answer')
    expect(r.type).toBe('result')
    expect(getOutput(r)).toContain('42')
  }, 120_000)
})
