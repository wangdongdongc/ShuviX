/**
 * WTS —— 包装器 + 真 processToolOutput 的整条链（不桩后处理，只桩 electron 的 userData）。
 *
 * W-S* 钉的是「包装器交过去了什么」，这里钉的是「交过去之后盘上和正文里到底是什么」：
 *  - `spill:false` 一路走到底 —— 目录都不建，正文里没有那句取不回来的指路；
 *  - 一次调用回好几段超长文本时，**每段有自己的文件**。它们共用一个 toolCallId，曾经后一段
 *    会盖掉前一段：第一段预览里写的「全文在这里」指向的是第二段的全文，而模型对此毫无察觉。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 假 userData —— 落盘走真实的 utils/paths.ts */
const USER_DATA_DIR = join(tmpdir(), `shuvix-wts-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR, getVersion: () => '9.9.9' }
}))
vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { wrapToolOutput } from '../wrapToolOutput'

const SID = 'wts-session'
const resultsDir = (sessionId: string): string => join(USER_DATA_DIR, 'tool_results', sessionId)

const bigText = (tag: string): string =>
  Array.from({ length: 3000 }, (_, i) => `${tag}-${String(i).padStart(4, '0')}`).join('\n')

const IMAGE_BLOCK = { type: 'image' as const, data: 'AAAABBBBCCCC', mimeType: 'image/png' }

/** details 声明了 truncated / persisted 的工具 —— 包装器只在声明过时才合并 */
function makeTool(content: unknown[]): AgentTool {
  return {
    name: 'probe',
    label: 'probe',
    description: 'test tool',
    parameters: {},
    execute: async () => ({ content, details: { truncated: false, persisted: false } })
  } as unknown as AgentTool
}

const textOf = (result: { content: unknown[] }, i: number): string =>
  (result.content[i] as { text: string }).text

afterAll(() => rmSync(USER_DATA_DIR, { recursive: true, force: true }))

describe('WTS 包装器 + 真 processToolOutput', () => {
  it('WTS-1 spill:false：图片原样、正文只有表头、目录不建、details 合并出 truncated', async () => {
    const full = bigText('one')
    const wrapped = wrapToolOutput(
      makeTool([{ type: 'text', text: full }, IMAGE_BLOCK]),
      SID,
      'middle',
      {
        spill: false
      }
    )

    const result = await wrapped.execute('wts-1', {} as never)

    expect(result.content[1]).toBe(IMAGE_BLOCK)
    const text = textOf(result as { content: unknown[] }, 0)
    expect(text.startsWith('[Output truncated: 3000 lines /')).toBe(true)
    expect(text).not.toContain('Full output saved')
    expect(text).not.toMatch(/Read tool/i)
    expect(existsSync(resultsDir(SID))).toBe(false)
    expect(result.details).toEqual({ truncated: true, persisted: false })
  })

  it('WTS-2 spill:true、一次回两段超长文本 → 各自一个文件，指路指的是自己那一段', async () => {
    const sid = 'wts-2-session'
    const first = bigText('alpha')
    const second = bigText('beta')
    const wrapped = wrapToolOutput(
      makeTool([
        { type: 'text', text: first },
        { type: 'text', text: second }
      ]),
      sid,
      'middle',
      { spill: true }
    )

    const result = await wrapped.execute('wts-2', {} as never)

    const locatorOf = (text: string): string => {
      const m = /\[Full output saved to: (.+)\]/.exec(text)
      expect(m, `正文里应有落盘指路：${text.slice(0, 80)}`).not.toBeNull()
      return m![1]
    }
    const a = locatorOf(textOf(result as { content: unknown[] }, 0))
    const b = locatorOf(textOf(result as { content: unknown[] }, 1))

    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf-8')).toBe(first)
    expect(readFileSync(b, 'utf-8')).toBe(second)
    expect(a.startsWith(resultsDir(sid))).toBe(true)
    expect(b.startsWith(resultsDir(sid))).toBe(true)
    expect(result.details).toEqual({ truncated: true, persisted: true })
  })
})
