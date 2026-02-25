import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  recordRead,
  getReadTime,
  assertNotModifiedSinceRead,
  withFileLock,
  clearSession,
  _resetAll
} from '../utils/fileTime'

const TEST_DIR = join(tmpdir(), 'shuvix-filetime-test-' + Date.now())
const TEST_FILE = join(TEST_DIR, 'test.txt')
const SESSION_ID = 'test-session-1'

beforeEach(() => {
  _resetAll()
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(TEST_FILE, 'hello')
})

afterAll(() => {
  _resetAll()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('recordRead + getReadTime', () => {
  it('记录后能查到时间', () => {
    recordRead(SESSION_ID, TEST_FILE)
    const time = getReadTime(SESSION_ID, TEST_FILE)
    expect(time).toBeInstanceOf(Date)
    expect(time!.getTime()).toBeGreaterThan(0)
  })

  it('未记录的文件返回 undefined', () => {
    expect(getReadTime(SESSION_ID, '/nonexistent')).toBeUndefined()
  })

  it('未记录的 session 返回 undefined', () => {
    expect(getReadTime('unknown-session', TEST_FILE)).toBeUndefined()
  })
})

describe('assertNotModifiedSinceRead', () => {
  it('未读取过文件时抛错', () => {
    expect(() => assertNotModifiedSinceRead(SESSION_ID, TEST_FILE)).toThrowError(
      /must read file/i
    )
  })

  it('文件未修改时通过（不抛错）', () => {
    recordRead(SESSION_ID, TEST_FILE)
    // 文件未修改，应通过
    expect(() => assertNotModifiedSinceRead(SESSION_ID, TEST_FILE)).not.toThrow()
  })

  it('文件被修改后抛错', async () => {
    recordRead(SESSION_ID, TEST_FILE)
    // 等待一段时间后修改文件（确保 mtime 变化）
    await new Promise((r) => setTimeout(r, 100))
    // 将文件 mtime 设置为未来时间
    const future = new Date(Date.now() + 5000)
    utimesSync(TEST_FILE, future, future)
    expect(() => assertNotModifiedSinceRead(SESSION_ID, TEST_FILE)).toThrowError(
      /modified since/i
    )
  })

  it('文件被删除后允许写入（不抛错）', () => {
    const deletedFile = '/tmp/shuvix-nonexistent-file-' + Date.now()
    recordRead(SESSION_ID, deletedFile)
    // 文件已被删除，statSync 会失败，函数应 catch 并允许写入
    expect(() => assertNotModifiedSinceRead(SESSION_ID, deletedFile)).not.toThrow()
  })
})

describe('withFileLock', () => {
  it('串行化并发写操作', async () => {
    const order: number[] = []

    const p1 = withFileLock(TEST_FILE, async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push(1)
      return 'a'
    })

    const p2 = withFileLock(TEST_FILE, async () => {
      order.push(2)
      return 'b'
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('a')
    expect(r2).toBe('b')
    // p1 先拿到锁，p2 等待 p1 完成后才执行
    expect(order).toEqual([1, 2])
  })

  it('不同文件不互相阻塞', async () => {
    const order: string[] = []

    const p1 = withFileLock('/file1', async () => {
      await new Promise((r) => setTimeout(r, 50))
      order.push('file1')
    })

    const p2 = withFileLock('/file2', async () => {
      order.push('file2')
    })

    await Promise.all([p1, p2])
    // file2 不等 file1，应先完成
    expect(order[0]).toBe('file2')
  })
})

describe('clearSession', () => {
  it('清理后 getReadTime 返回 undefined', () => {
    recordRead(SESSION_ID, TEST_FILE)
    expect(getReadTime(SESSION_ID, TEST_FILE)).toBeDefined()
    clearSession(SESSION_ID)
    expect(getReadTime(SESSION_ID, TEST_FILE)).toBeUndefined()
  })
})
