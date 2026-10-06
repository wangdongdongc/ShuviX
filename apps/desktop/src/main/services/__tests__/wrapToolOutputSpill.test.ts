/**
 * WTS —— 包装器 + 真 processToolOutput 的整条链（不桩后处理，只桩 electron 的 userData）。
 *
 * W-S* 钉的是「包装器交过去了什么」，这里钉的是「交过去之后盘上、正文里、诊断里到底是什么」：
 *  - `spill:false` 一路走到底 —— 目录都不建，正文里、诊断里都没有那句取不回来的指路；
 *  - 一次调用回好几段超长文本时，**每段有自己的文件**。它们共用一个 toolCallId，曾经后一段
 *    会盖掉前一段：第一段的「全文在这里」指向的是第二段的全文，而模型对此毫无察觉。
 *
 * P1-06 的期望变化：表头 `[Output truncated: …]` 与 `[Full output saved to: …]` 不再写进正文 ——
 * 正文只留截断后的文字 / 预览，说明作为 durable diagnostic 交回（落盘 = code `spilled`，
 * 只在内存里截断 = code `truncated`），每段超长文本一条，durable 把它们渲染在结果末尾的
 * `<harness>` 段里。WTS-1 原来断言正文以表头开头，WTS-2 原来从正文里抠落盘路径。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import type { AnyTool } from '@shuvix/agent-runtime'
import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'
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

import { wrapDurableTool } from '../wrapToolOutput'

const SID = 'wts-session'
const resultsDir = (sessionId: string): string => join(USER_DATA_DIR, 'tool_results', sessionId)

const bigText = (tag: string): string =>
  Array.from({ length: 3000 }, (_, i) => `${tag}-${String(i).padStart(4, '0')}`).join('\n')

const IMAGE_BLOCK = { type: 'image' as const, data: 'AAAABBBBCCCC', mimeType: 'image/png' }

/** details 声明了 truncated / persisted 的工具 —— 包装器只在声明过时才合并 */
function makeTool(content: unknown[]): AnyTool {
  return {
    name: 'probe',
    label: 'probe',
    description: 'test tool',
    parameters: {},
    replay: 'unsafe',
    execute: async () => ({ content, details: { truncated: false, persisted: false } })
  } as unknown as AnyTool
}

const textOf = (result: { content: unknown[] }, i: number): string =>
  (result.content[i] as { text: string }).text

afterAll(() => rmSync(USER_DATA_DIR, { recursive: true, force: true }))

describe('WTS 包装器 + 真 processToolOutput', () => {
  it('WTS-1 spill:false：图片原样、正文是截断后的文字（不带表头）、一条 truncated 诊断、目录不建、details 合并出 truncated', async () => {
    const full = bigText('one')
    const wrapped = wrapDurableTool(makeTool([{ type: 'text', text: full }, IMAGE_BLOCK]), {
      sessionId: SID,
      spill: false
    })

    const result = await executeTool(wrapped, 'wts-1', {} as never)

    expect(result.content[1]).toBe(IMAGE_BLOCK)
    const text = textOf(result as { content: unknown[] }, 0)
    // 正文就是截断后的文字：开头是原文第一行，不再以表头开头
    expect(text.startsWith('one-0000')).toBe(true)
    expect(text).not.toContain('[Output truncated')
    expect(text).not.toContain('Full output saved')
    expect(text).not.toMatch(/Read tool/i)
    // 说明在诊断里：恰一条 truncated，说清截了多少，不指路
    expect(result.diagnostics).toHaveLength(1)
    const [diagnostic] = result.diagnostics!
    expect(diagnostic.severity).toBe('info')
    expect(diagnostic.code).toBe('truncated')
    expect(diagnostic.message).toMatch(/^Output truncated: 3000 lines \//)
    expect(diagnostic.message).not.toMatch(/saved to|read tool/i)
    expect(existsSync(resultsDir(SID))).toBe(false)
    expect(result.details).toEqual({ truncated: true, persisted: false })
  })

  it('WTS-2 spill:true、一次回两段超长文本 → 各自一个文件、各自一条 spilled 诊断，指路指的是自己那一段，正文里没有路径', async () => {
    const sid = 'wts-2-session'
    const first = bigText('alpha')
    const second = bigText('beta')
    const wrapped = wrapDurableTool(
      makeTool([
        { type: 'text', text: first },
        { type: 'text', text: second }
      ]),
      { sessionId: sid, spill: true }
    )

    const result = await executeTool(wrapped, 'wts-2', {} as never)

    const spilled = (result.diagnostics ?? []).filter((d) => d.code === 'spilled')
    expect(spilled).toHaveLength(2)
    const locatorOf = (message: string): string => {
      const m = /full output saved to (.+)\. Use the read tool \(not bash\) to view it\.$/.exec(
        message
      )
      expect(m, `诊断里应有落盘指路：${message}`).not.toBeNull()
      return m![1]
    }
    const a = locatorOf(spilled[0].message)
    const b = locatorOf(spilled[1].message)

    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf-8')).toBe(first)
    expect(readFileSync(b, 'utf-8')).toBe(second)
    expect(a.startsWith(resultsDir(sid))).toBe(true)
    expect(b.startsWith(resultsDir(sid))).toBe(true)
    // 路径只在诊断里：两段正文都只是各自的预览
    expect(textOf(result as { content: unknown[] }, 0)).not.toContain(a)
    expect(textOf(result as { content: unknown[] }, 1)).not.toContain(b)
    expect(textOf(result as { content: unknown[] }, 0).startsWith('alpha-0000')).toBe(true)
    expect(textOf(result as { content: unknown[] }, 1).startsWith('beta-0000')).toBe(true)
    expect(result.details).toEqual({ truncated: true, persisted: true })
  })
})
