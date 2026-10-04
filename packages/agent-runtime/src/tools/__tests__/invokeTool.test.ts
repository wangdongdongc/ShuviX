/**
 * invokeTool —— 单测里调一次 durable 工具的辅助（tools/testing/invokeTool.ts）。
 *
 * 契约（文件头）：假 api 带调用身份与给定 signal 的 chord context；记下 output() / diagnostic() /
 * details()；结果按 durable 结算口径补齐（缺 content 用 output 文本、缺 details 用最后一次 details()、
 * api 记下的诊断排在结果自带的之前）；只收显式声明了 replay 的 durable 注册项（旧形状在调用前就拒收）；
 * 兑现不了的 api 成员一调就抛；调用结束后 api 失效。
 *
 *   IT-1 缺省身份：callId 自动生成且每次不同，taskId 1，conversationId 根对话，context 不带 signal
 *   IT-2 给定的 callId / taskId / conversationId / signal 原样到达 api 与 context
 *   IT-3 output（字符串与 Uint8Array）/ diagnostic / details 按顺序记下
 *   IT-4 结果原样交回；缺 content / details 时按 durable 口径补齐，诊断合并
 *   IT-5 工具抛错（durable 形状 —— 不经 BaseTool 的裸注册项）→ invokeTool 原样 reject
 *   IT-6 调用结算之后再碰 api → 抛
 *   IT-7 兑现不了的成员一调就抛并指路 options.api；options.api 可以补上 / 替换；memo 先到者胜
 *   IT-8 旧形状工具（没有 replay，`execute(toolCallId, params, signal)`）：类型上不收；运行时在调用
 *        execute 之前以 TypeError 拒收（P1-05 删掉了 fromAgentTool 桥）
 *   IT-9 守卫：产品代码不 import 这个辅助
 */
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from '@earendil-works/pi-durable'
import type { TSchema } from 'typebox'
import type { AnyTool, ToolContent } from '../toolResult'
import { executeTool, invokeTool, resultText } from '../testing/invokeTool'

/** 一个裸的 durable 注册项（不经 BaseTool）：execute 由用例给 */
function rawTool(execute: AnyTool['execute']): AnyTool {
  return {
    name: 'raw',
    description: 'raw tool',
    parameters: {},
    replay: 'unsafe',
    execute
  } as AnyTool
}

describe('IT 调用身份与 context', () => {
  it('IT-1 缺省：callId 自动生成且两次不同；taskId 1；conversationId 是根对话；context 不带 signal', async () => {
    const seen: ToolExecutionApi[] = []
    const tool = rawTool(async (_args, api) => {
      seen.push(api)
      return { content: [] }
    })
    const first = await invokeTool(tool, {})
    const second = await invokeTool(tool, {})

    expect(seen[0].callId).toEqual(expect.any(String))
    expect(seen[0].callId).not.toBe(seen[1].callId)
    expect(seen[0].taskId).toBe(1)
    expect(seen[0].conversationId).toBe(ROOT_CONVERSATION_ID)
    expect(first.context.abortSignal).toBeUndefined()
    expect(second.api).toBe(seen[1])
  })

  it('IT-2 给定的身份与 signal 原样到达', async () => {
    const tool = rawTool(async (_args, api, context) => ({
      content: [{ type: 'text', text: `${api.callId}/${api.taskId}/${api.conversationId}` }],
      details: { aborted: context.abortSignal?.aborted ?? null }
    }))
    const ac = new AbortController()
    const run = await invokeTool(
      tool,
      {},
      { callId: 'c-7', taskId: 9, conversationId: 3, signal: ac.signal }
    )

    expect(resultText(run.result)).toBe('c-7/9/3')
    expect(run.result.details).toEqual({ aborted: false })
    expect(run.context.abortSignal).toBe(ac.signal)
  })
})

describe('IT 记录与结算', () => {
  it('IT-3 output（字符串与 Uint8Array）/ diagnostic / details 按顺序记下', async () => {
    const tool = rawTool(async (_args, api, context) => {
      api.output('hello ')
      api.output(new TextEncoder().encode('wörld'))
      api.diagnostic({ severity: 'info', message: 'first', code: undefined })
      await api.details({ step: 1 }, context)
      api.diagnostic({ severity: 'warn', message: 'second' })
      await api.details({ step: 2 }, context)
      return { content: [{ type: 'text', text: 'final' }] }
    })
    const run = await invokeTool(tool, {})

    expect(run.output).toBe('hello wörld')
    // undefined 的键丢掉（durable 记诊断时也这么收）
    expect(run.diagnostics).toStrictEqual([
      { severity: 'info', message: 'first' },
      { severity: 'warn', message: 'second' }
    ])
    expect(run.details).toEqual([{ step: 1 }, { step: 2 }])
  })

  it('IT-4 结果给全了 → 原样交回，记下的诊断排在结果自带的之前', async () => {
    const tool = rawTool(async (_args, api) => {
      api.diagnostic({ severity: 'info', message: 'from api' })
      return {
        content: [{ type: 'text', text: 'body' }],
        details: { own: true },
        control: { terminate: true },
        diagnostics: [{ severity: 'warn', message: 'from result' }]
      }
    })
    const { result } = await invokeTool(tool, {})
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'body' }],
      details: { own: true },
      control: { terminate: true },
      diagnostics: [
        { severity: 'info', message: 'from api' },
        { severity: 'warn', message: 'from result' }
      ]
    })
  })

  it('IT-4 缺 content → 用 output 文本；缺 details → 用最后一次 details()；什么都没报 → 空 content', async () => {
    const reported = rawTool(async (_args, api, context) => {
      api.output('streamed')
      await api.details({ v: 1 }, context)
      await api.details({ v: 2 }, context)
      return {}
    })
    const { result } = await invokeTool(reported, {})
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'streamed' }],
      details: { v: 2 }
    })

    const silent = rawTool(async () => ({}))
    expect((await invokeTool(silent, {})).result).toStrictEqual({ content: [] })
  })

  it('IT-5 裸注册项抛错 → invokeTool 原样 reject（模板收口是 BaseTool 的事，辅助不替工具兜）', async () => {
    const err = new Error('raw failure')
    await expect(
      invokeTool(
        rawTool(async () => Promise.reject(err)),
        {}
      )
    ).rejects.toBe(err)
  })

  it('IT-6 调用结算之后再碰 api → 抛', async () => {
    let held: ToolExecutionApi | undefined
    const tool = rawTool(async (_args, api) => {
      held = api
      return { content: [] }
    })
    const run = await invokeTool(tool, {}, { callId: 'late' })
    expect(() => held!.output('too late')).toThrow(/late has settled/)
    expect(() => held!.diagnostic({ severity: 'info', message: 'x' })).toThrow(/has settled/)
    await expect(held!.details({}, run.context)).rejects.toThrow(/has settled/)
  })
})

describe('IT 假 api 的边界', () => {
  it('IT-7 兑现不了的成员一调就抛，并指路 options.api', async () => {
    const tool = rawTool(async (_args, api, context) => {
      await api.commit(() => undefined, context)
      return { content: [] }
    })
    await expect(invokeTool(tool, {})).rejects.toThrow(/api\.commit\(\).*options\.api/)
  })

  it('IT-7 options.api 补上的成员被工具用到；agent() 缺省回只装着这个工具的 agent', async () => {
    const commit = vi.fn(async () => 'committed')
    const tool = rawTool(async (_args, api, context) => {
      const agent = await api.agent(context)
      const out = await api.commit(() => undefined, context)
      return {
        content: [
          { type: 'text', text: `${String(out)}:${agent.tools.map((t) => t.name).join(',')}` }
        ]
      }
    })
    const { result } = await invokeTool(
      tool,
      {},
      {
        api: { commit: commit as unknown as ToolExecutionApi['commit'] }
      }
    )
    expect(commit).toHaveBeenCalledTimes(1)
    expect(resultText(result)).toBe('committed:raw')
  })

  it('IT-7 memo：先到的候选值胜出，读到的是存下的那个', async () => {
    const tool = rawTool(async (_args, api, context) => {
      const before = await api.memo<string>('k', context)
      const first = await api.memo('k', 'one', context)
      const second = await api.memo('k', 'two', context)
      return { content: [{ type: 'text', text: `${String(before)}|${first}|${second}` }] }
    })
    expect(resultText((await invokeTool(tool, {})).result)).toBe('undefined|one|one')
  })
})

/** pi 0.80 的旧形状（P1-05 之前 ask / git / MCP 的样子）：没有 replay，execute 按 (toolCallId, params, signal) */
interface LegacyShapedTool {
  name: string
  label: string
  description: string
  parameters: TSchema
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<{ content: ToolContent[]; details: unknown; terminate?: boolean }>
}

describe('IT 旧形状工具不再被收', () => {
  function legacy(execute: LegacyShapedTool['execute']): LegacyShapedTool {
    return {
      name: 'legacy',
      label: 'Legacy',
      description: 'legacy tool',
      parameters: {} as TSchema,
      execute
    }
  }

  it('IT-8 类型上：旧形状不是 durable 注册项（execute 的第三个参数是 signal，不是 context）', () => {
    const tool = legacy(async () => ({ content: [], details: undefined }))
    // @ts-expect-error —— 旧形状交不进来：P1-05 删掉了 fromAgentTool 桥
    const work = (): unknown => invokeTool(tool, {})
    expect(typeof work).toBe('function')
  })

  it('IT-8 运行时：没声明 replay → 调用 execute 之前就以 TypeError 拒收，并说明原因', async () => {
    const execute = vi.fn(async () => ({ content: [], details: undefined }))
    const tool = legacy(execute) as unknown as AnyTool

    await expect(invokeTool(tool, {})).rejects.toThrow(TypeError)
    await expect(executeTool(tool, 'lc-1', {})).rejects.toThrow(
      /tool "legacy" declares no replay policy.*legacy execute\(toolCallId, params, signal\) shape is gone/
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('IT-8 replay 不是 safe / unsafe 也拒收（durable 只认这两个值）', async () => {
    const execute = vi.fn(async () => ({ content: [] }))
    const tool = { ...rawTool(execute), replay: 'sometimes' } as unknown as AnyTool
    await expect(invokeTool(tool, {})).rejects.toThrow(/declares no replay policy/)
    expect(execute).not.toHaveBeenCalled()
  })

  it('IT-8 声明了 replay 的裸注册项照常调（safe 与 unsafe 都收）', async () => {
    for (const replay of ['safe', 'unsafe'] as const) {
      const tool = {
        ...rawTool(async () => ({ content: [{ type: 'text', text: replay }] })),
        replay
      }
      expect(resultText((await invokeTool(tool as AnyTool, {})).result)).toBe(replay)
    }
  })
})

// ─── 守卫：测试辅助不进产品代码 ────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../../../..')
const SCANNED = ['packages', 'apps'].map((dir) => join(REPO_ROOT, dir))

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.'))
      continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

describe('IT-9 守卫', () => {
  it('产品代码（非 __tests__ / *.test.* / testing/ 本身 / vitest 配置的别名）不 import tools/testing/invokeTool', () => {
    const all = SCANNED.flatMap((dir) => sourceFiles(dir))
    // 扫描本身没扫空（路径算错时这条守卫会静默通过）
    expect(all.some((path) => path.endsWith(join('tools', 'baseTool.ts')))).toBe(true)
    const offenders = all
      .filter(
        (path) =>
          !/[\\/]__tests__[\\/]|\.test\.tsx?$|[\\/]tools[\\/]testing[\\/]|vitest\.config[^\\/]*\.ts$/.test(
            path
          )
      )
      .filter((path) =>
        /tools\/testing\/invokeTool|testing\/invokeTool['"]/.test(readFileSync(path, 'utf8'))
      )
      .map((path) => relative(REPO_ROOT, path))
    expect(offenders).toEqual([])
  })

  it('旧形状桥已删干净：仓库里（本文件之外）没有一处再提 fromAgentTool / asToolRegistration 等名字', () => {
    const removed =
      /\b(fromAgentTool|fromAgentToolResult|asToolRegistration|isLegacyAgentTool|AnyLegacyAgentTool|AgentToolResult|AgentToolUpdateCallback|McpAgentToolMeta|getAgentToolsByServerName|serverToAgentTools|mcpContentToAgentContent)\b/
    const self = resolve(__filename)
    const offenders = SCANNED.flatMap((dir) => sourceFiles(dir))
      .filter((path) => resolve(path) !== self)
      .filter((path) => removed.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path))
    expect(offenders).toEqual([])
  })
})
