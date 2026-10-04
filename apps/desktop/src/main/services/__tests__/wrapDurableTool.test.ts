/**
 * WD（桌面这一半）—— `wrapDurableTool` 是 agent-runtime `wrapDurableOutput` 之上的薄层：桌面落盘口
 * （`tool_results/<sessionId>/`）+ L1 全工具门 + 「已审查」标记。
 *
 * P1-06b：截断 / 落盘走 diagnostics / spill:auto / api.output() / isError / 元数据 / 真 durable 一轮
 * 这些用例随内核搬到 packages/agent-runtime/src/toolOutput/__tests__/wrapDurableOutput.test.ts（编号不变，
 * 落盘口换成内存表）。这里只留桌面才有的那一半 —— 同编号的用例断言的是**真落盘口**的结果：
 * 文件确实写在 tool_results/<sid>/ 下、不该落盘时目录确实没建、两层 Object.create 叠起来之后元数据
 * 与 outputLimits 仍透得出来。L1 门与审查标记在 wrapToolOutput.test.ts / wrapToolOutputReview.test.ts。
 *
 * 只桩 electron 的 userData（落盘走真实的 utils/paths.ts → tool_results/<sid>/）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Type } from 'typebox'
import type { Agent, ToolDiagnostic, ToolExecutionApi } from '@earendil-works/pi-durable'
import { BaseTool, type AnyTool } from '@shuvix/agent-runtime'
import {
  invokeTool,
  resultText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const USER_DATA_DIR = join(tmpdir(), `shuvix-wd-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR, getVersion: () => '9.9.9' }
}))
vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { wrapDurableTool, type WrapDurableToolOptions } from '../wrapToolOutput'

afterAll(() => rmSync(USER_DATA_DIR, { recursive: true, force: true }))

const resultsDir = (sid: string): string => join(USER_DATA_DIR, 'tool_results', sid)

/** 3000 行、每行唯一（`<tag>-0000` …）—— 任何缺省上限下都必然超限 */
const big = (tag = 'L', lines = 3000): string =>
  Array.from({ length: lines }, (_, i) => `${tag}-${String(i).padStart(4, '0')}`).join('\n')

/** 回给定文本块的探针 */
function textProbe(...texts: string[]): AnyTool {
  return {
    name: 'probe',
    label: 'probe',
    description: 'probe tool',
    parameters: Type.Object({}),
    replay: 'unsafe',
    execute: async () => ({ content: texts.map((text) => ({ type: 'text' as const, text })) })
  } as unknown as AnyTool
}

/** api.agent 的替身：交出一张只含这些工具名的工具表 */
function agentWith(names: string[]): ToolExecutionApi['agent'] {
  const agent: Agent = {
    thinkingLevel: 'off',
    extensions: [],
    tools: names.map((name) => ({ name }) as unknown as AnyTool),
    sections: []
  }
  return async () => agent
}

const wrap = (
  tool: AnyTool,
  opts: Partial<WrapDurableToolOptions> & { sessionId: string }
): AnyTool => wrapDurableTool(tool, { spill: true, ...opts })

const run = async (
  tool: AnyTool,
  options: Parameters<typeof invokeTool>[2] = {}
): Promise<InvokedToolResult> => (await invokeTool(tool, {} as never, options)).result

const codes = (result: { diagnostics?: readonly ToolDiagnostic[] }): (string | undefined)[] =>
  (result.diagnostics ?? []).map((d) => d.code)

/** spilled 诊断里的落盘路径 */
const locatorOf = (d: ToolDiagnostic): string => {
  const m = /full output saved to (.+)\. Use the read tool \(not bash\) to view it\.$/.exec(
    d.message
  )
  expect(m, d.message).not.toBeNull()
  return m![1]
}

describe('WD 桌面落盘口（tool_results/<sid>/）', () => {
  it('WD-1 spill:true、一段超长文本 → spilled 诊断里是 tool_results/<sid>/<callId>.txt 的绝对路径，正文里没有它，文件里是全文', async () => {
    const sid = 'wd-1'
    const full = big('one')
    const result = await run(wrap(textProbe(full), { sessionId: sid }), { callId: 'wd-1-call' })

    expect(codes(result)).toEqual(['spilled'])
    const path = locatorOf(result.diagnostics![0])
    expect(path).toBe(join(resultsDir(sid), 'wd-1-call.txt'))
    expect(resultText(result)).not.toContain(resultsDir(sid))
    expect(readFileSync(path, 'utf-8')).toBe(full)
  })

  it('WD-3 spill:false → 内存截断，目录不建', async () => {
    const sid = 'wd-3'
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: false }))
    expect(codes(result)).toEqual(['truncated'])
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('WD-7 spill:auto + 工具表里有 read → 落在 tool_results/<sid>/ 下', async () => {
    const sid = 'wd-7'
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: { agent: agentWith(['read', 'probe']) }
    })
    expect(codes(result)).toEqual(['spilled'])
    expect(locatorOf(result.diagnostics![0]).startsWith(resultsDir(sid))).toBe(true)
  })

  it('WD-8 spill:auto + 没有 read → 内存截断，目录不建', async () => {
    const sid = 'wd-8'
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: { agent: agentWith(['probe', 'ask']) }
    })
    expect(codes(result)).toEqual(['truncated'])
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('WD-11 问工具表失败 → 内存截断，目录不建，调用照常成功', async () => {
    const sid = 'wd-11'
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: {
        agent: async () => {
          throw new Error('agent unavailable')
        }
      }
    })
    expect(result.isError).toBeUndefined()
    expect(codes(result)).toEqual(['truncated'])
    expect(existsSync(resultsDir(sid))).toBe(false)
  })
})

describe('WD 两层叠起来之后的元数据', () => {
  it('WD-16 门这一层叠在内核之上：getter / replay 透得出，outputLimits 是内核按工具声明算的那份，execute 是门这一层自己的', () => {
    class Probe extends BaseTool {
      readonly name = 'probe'
      readonly label = 'Probe'
      readonly parameters = Type.Object({})
      readonly replay = 'safe' as const
      readonly outputStrategy = 'keep-end' as const
      readonly outputMaxBytes = 4096
      readonly outputMaxLines = 100
      get description(): string {
        return 'dynamic description'
      }
      async preExecute(): Promise<void> {}
      protected async securityCheck(): Promise<void> {}
      protected async executeInternal(): Promise<{ content: []; details: undefined }> {
        return { content: [], details: undefined }
      }
    }
    const wrapped = wrapDurableTool(new Probe(), { sessionId: 'wd-16', spill: true })

    expect(wrapped.name).toBe('probe')
    expect(wrapped.description).toBe('dynamic description')
    expect(wrapped.replay).toBe('safe')
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'execute')).toBe(true)
    expect(wrapped.outputLimits).toEqual({ maxBytes: 8192, maxLines: 200, retain: 'tail' })
    // 显式给的上限 / 策略经桌面这一层原样交给内核
    expect(
      wrapDurableTool(new Probe(), {
        sessionId: 'wd-16',
        spill: true,
        strategy: 'middle',
        maxBytes: 1000,
        maxLines: 10
      }).outputLimits
    ).toEqual({ maxBytes: 2000, maxLines: 20, retain: 'head' })
  })
})
