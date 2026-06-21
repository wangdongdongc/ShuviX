/**
 * editDiff 纯函数单测 —— BOM / 行尾 / diff 生成（edit 工具依赖，P2 抽共享前补齐）
 */
import { describe, it, expect } from 'vitest'
import {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  generateDiffString
} from '@shuvix/agent-runtime'

describe('detectLineEnding', () => {
  it('LF 文件返回 \\n', () => {
    expect(detectLineEnding('a\nb\nc')).toBe('\n')
  })
  it('CRLF 文件返回 \\r\\n', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n')
  })
  it('无换行返回 \\n', () => {
    expect(detectLineEnding('single line')).toBe('\n')
  })
  it('CRLF 在 LF 之前才算 CRLF', () => {
    // 先出现裸 \n，则判定为 LF
    expect(detectLineEnding('a\nb\r\nc')).toBe('\n')
  })
})

describe('normalizeToLF / restoreLineEndings', () => {
  it('CRLF/CR → LF 归一', () => {
    expect(normalizeToLF('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
  it('LF → CRLF 还原', () => {
    expect(restoreLineEndings('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })
  it('LF 还原为 LF 时原样', () => {
    expect(restoreLineEndings('a\nb', '\n')).toBe('a\nb')
  })
  it('归一 → 还原 CRLF 往返一致', () => {
    const crlf = 'x\r\ny\r\nz'
    expect(restoreLineEndings(normalizeToLF(crlf), '\r\n')).toBe(crlf)
  })
})

describe('stripBom', () => {
  it('带 BOM 时拆出 bom 与正文', () => {
    const { bom, text } = stripBom('﻿hello')
    expect(bom).toBe('﻿')
    expect(text).toBe('hello')
  })
  it('无 BOM 时 bom 为空', () => {
    const { bom, text } = stripBom('hello')
    expect(bom).toBe('')
    expect(text).toBe('hello')
  })
})

describe('generateDiffString', () => {
  it('单行修改 → diff 含增删 + firstChangedLine', () => {
    const { diff, firstChangedLine } = generateDiffString('a\nb\nc\n', 'a\nB\nc\n')
    expect(firstChangedLine).toBe(2)
    expect(diff).toContain('b') // 被删除的旧行
    expect(diff).toContain('B') // 新增的新行
  })
  it('无变化 → 空 diff + firstChangedLine undefined', () => {
    const { diff, firstChangedLine } = generateDiffString('a\nb\n', 'a\nb\n')
    expect(diff).toBe('')
    expect(firstChangedLine).toBeUndefined()
  })
})
