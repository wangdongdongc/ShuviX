/**
 * 应用日志的尾部读取（readAppLogTail）—— 真文件（临时目录），不经 electron-log。
 *
 *   ALS-1 文件不在：fileId ''、空文本、reset
 *   ALS-2 小文件第一次读：整份、start 0、end = 大小、reset、不算截断
 *   ALS-3 大于上限：只读最后一段，扔掉被切断的首行；start 落在行首、truncated
 *   ALS-4 带游标再读：只回新增的完整行，不 reset；没有新增 → 空文本、end 不动
 *   ALS-5 末尾的半行不回（end 停在它前面）；写完之后下一次连同它一起回；多字节字符不被切开
 *   ALS-6 换了文件（改名成 main.old.log、另起一份）→ fileId 变、reset、从新文件开头读
 *   ALS-7 游标超过文件大小（被截短）或落后超过上限 → reset
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger', () => ({ default: { transports: { file: { getFile: () => ({}) } } } }))

import { readAppLogTail } from '../appLogService'

let dir: string
let file: string

const line = (n: number): string =>
  `[2026-10-25 07:38:${String(n % 60).padStart(2, '0')}.000] [info]  line ${n}\n`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-applog-'))
  file = join(dir, 'main.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readAppLogTail', () => {
  it('ALS-1 文件不在', () => {
    expect(readAppLogTail(file)).toEqual({
      path: file,
      fileId: '',
      start: 0,
      end: 0,
      text: '',
      reset: true,
      truncated: false
    })
  })

  it('ALS-2 小文件整份读', () => {
    const text = line(1) + line(2)
    writeFileSync(file, text)
    const tail = readAppLogTail(file)
    expect(tail).toMatchObject({ start: 0, end: Buffer.byteLength(text), text, reset: true })
    expect(tail.truncated).toBe(false)
    expect(tail.fileId).not.toBe('')
  })

  it('ALS-3 大于上限：只读最后一段，首行完整', () => {
    const text = Array.from({ length: 100 }, (_, i) => line(i)).join('')
    writeFileSync(file, text)
    const tail = readAppLogTail(file, null, 200)
    expect(tail.truncated).toBe(true)
    expect(tail.reset).toBe(true)
    expect(tail.end).toBe(Buffer.byteLength(text))
    expect(tail.end - tail.start).toBeLessThanOrEqual(200)
    expect(tail.text.startsWith('[2026-10-25')).toBe(true)
    expect(text.endsWith(tail.text)).toBe(true)
    expect(text.slice(tail.start)).toBe(tail.text)
  })

  it('ALS-4 带游标只回新增', () => {
    writeFileSync(file, line(1))
    const first = readAppLogTail(file)
    appendFileSync(file, line(2) + line(3))
    const next = readAppLogTail(file, { fileId: first.fileId, offset: first.end })
    expect(next).toMatchObject({ reset: false, truncated: false, start: first.end })
    expect(next.text).toBe(line(2) + line(3))
    const idle = readAppLogTail(file, { fileId: next.fileId, offset: next.end })
    expect(idle).toMatchObject({ reset: false, text: '', start: next.end, end: next.end })
  })

  it('ALS-5 半行留到下一次，多字节字符不被切开', () => {
    writeFileSync(file, line(1))
    const first = readAppLogTail(file)
    const zh = '[2026-10-25 07:38:02.000] [warn]  扫描失败\n'
    const bytes = Buffer.from(zh)
    // 写到「扫」字的第二个字节为止
    const cut = bytes.indexOf(Buffer.from('扫')) + 2
    appendFileSync(file, bytes.subarray(0, cut))
    const partial = readAppLogTail(file, { fileId: first.fileId, offset: first.end })
    expect(partial).toMatchObject({ text: '', end: first.end, reset: false })
    appendFileSync(file, bytes.subarray(cut))
    const whole = readAppLogTail(file, { fileId: partial.fileId, offset: partial.end })
    expect(whole.text).toBe(zh)
  })

  it('ALS-6 轮转后换了文件 → reset，从新文件开头读', () => {
    writeFileSync(file, line(1) + line(2))
    const first = readAppLogTail(file)
    renameSync(file, join(dir, 'main.old.log'))
    writeFileSync(file, line(3))
    const next = readAppLogTail(file, { fileId: first.fileId, offset: first.end })
    expect(next.fileId).not.toBe(first.fileId)
    expect(next).toMatchObject({ reset: true, start: 0, text: line(3), truncated: false })
  })

  it('ALS-7 游标越过文件末尾或落后太多 → reset', () => {
    writeFileSync(file, line(1))
    const first = readAppLogTail(file)
    const beyond = readAppLogTail(file, { fileId: first.fileId, offset: first.end + 10 })
    expect(beyond).toMatchObject({ reset: true, start: 0, text: line(1) })

    appendFileSync(file, Array.from({ length: 50 }, (_, i) => line(i)).join(''))
    const behind = readAppLogTail(file, { fileId: first.fileId, offset: first.end }, 200)
    expect(behind.reset).toBe(true)
    expect(behind.truncated).toBe(true)
    expect(behind.end - behind.start).toBeLessThanOrEqual(200)
  })
})
