/**
 * botService 管线半边（M4′）的接线与两个跨 realm 校验器。
 *
 * 这里测的三件事都是**表**，不是流程：管线/角色的回落表（`resolvePipeline`）、
 * claim intent 的取值表（`asClaimIntent`）、say 正文的投影表（`asSayContent`）。
 * 后两个是脚本值进入宿主的信任边界 —— 值跨 vm realm 到达，`instanceof` 不可靠，
 * 逐字段 typeof 是唯一防线，因此每一格都值得单独摆一条。
 *
 * mock 面沿用 botServiceMessages 那套（botService 是模块级单例，构造时就读 paths）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ParsedBotFile } from '@shuvix/agent-runtime'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botpipe-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({ hasWorkflow: vi.fn(() => false) }))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: vi.fn(async () => ({ started: false, reason: 'not-found' })),
    abortSessionRuns: vi.fn(() => 0),
    hasWorkflow: mocks.hasWorkflow,
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: vi.fn() } }))
vi.mock('../sessionService', () => ({ sessionService: { getById: vi.fn() } }))

import { DEFAULT_BOT_PIPELINE } from '@shuvix/agent-runtime'
import { asClaimIntent, asSayContent, botSelfRef, resolvePipeline } from '../botService'

function stubBot(p: Partial<ParsedBotFile> & { name: string }): ParsedBotFile {
  return {
    displayName: p.name,
    description: `stub ${p.name}`,
    systemPrompt: '',
    tools: [],
    instructionFiles: [],
    projectAwareness: false,
    pipeline: '',
    pipelineInput: {},
    respond: 'auto',
    notesEnabled: true,
    agents: {},
    greeting: '',
    suggestions: [],
    notes: null,
    ...p
  }
}

beforeEach(() => {
  mocks.hasWorkflow.mockReset()
  mocks.hasWorkflow.mockReturnValue(false)
})

describe('botSelfRef —— 任务段指向 bot 自己', () => {
  it('是全局可寻址的 bot:<name>，不是 bot:self', () => {
    // 引擎的 resolveAgentProfile 是无 run 上下文的全局 dep，相对 ref 在那里永远解析不出来
    expect(botSelfRef('scout')).toBe('bot:scout')
    expect(botSelfRef('scout')).not.toBe('bot:self')
  })

  it('CJK / 含空格的名字原样拼接', () => {
    expect(botSelfRef('研究员')).toBe('bot:研究员')
    expect(botSelfRef('my bot')).toBe('bot:my bot')
  })
})

describe('resolvePipeline —— 管线与角色的回落表', () => {
  it('未声明 pipeline 时回落 bot-chat', () => {
    expect(resolvePipeline(stubBot({ name: 'a' })).workflow).toBe(DEFAULT_BOT_PIPELINE)
  })

  it('声明了 pipeline 就用它', () => {
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'my-flow' })).workflow).toBe('my-flow')
  })

  it.each([[true], [false]])('exists 取自 hasWorkflow(回落后的名字) = %s', (found) => {
    mocks.hasWorkflow.mockReturnValue(found)
    expect(resolvePipeline(stubBot({ name: 'a' })).exists).toBe(found)
    expect(mocks.hasWorkflow).toHaveBeenLastCalledWith(DEFAULT_BOT_PIPELINE)

    resolvePipeline(stubBot({ name: 'a', pipeline: 'my-flow' }))
    expect(mocks.hasWorkflow).toHaveBeenLastCalledWith('my-flow')
  })

  it('默认角色表：intent / recheck / notes 走内置件，task 自指', () => {
    expect(resolvePipeline(stubBot({ name: 'scout' })).agents).toEqual({
      intent: 'bot-intent',
      recheck: 'bot-intent',
      notes: 'bot-notes',
      task: 'bot:scout'
    })
  })

  it('bot.agents 逐键覆盖（只给 intent 时其余不动）', () => {
    const r = resolvePipeline(stubBot({ name: 'scout', agents: { intent: 'my-intent' } }))
    expect(r.agents).toEqual({
      intent: 'my-intent',
      recheck: 'bot-intent',
      notes: 'bot-notes',
      task: 'bot:scout'
    })
  })

  it('bot.agents 可以覆盖 task（用户值胜过 botSelfRef）', () => {
    // 解析期已就此 warn 过，这里只钉运行期语义：铺在最后的就是赢家
    const r = resolvePipeline(stubBot({ name: 'scout', agents: { task: 'coding' } }))
    expect(r.agents.task).toBe('coding')
  })

  it('未知角色键透传（角色表是开放的，不做过滤）', () => {
    const r = resolvePipeline(stubBot({ name: 'scout', agents: { verify: 'explore' } }))
    expect(r.agents).toMatchObject({ verify: 'explore', intent: 'bot-intent' })
  })
})

describe('asClaimIntent —— 跨 realm 的取值表', () => {
  it.each([
    ['reply', 0],
    ['reply', 9],
    ['task', 0],
    ['task', 9],
    ['clarify', 0],
    ['clarify', 9],
    ['ignore', 0],
    ['ignore', 9]
  ])('%s @ relevance %i 通过，reason 原样保留', (decision, relevance) => {
    expect(asClaimIntent({ decision, relevance, reason: '因为我管这块' })).toEqual({
      decision,
      relevance,
      reason: '因为我管这块'
    })
  })

  it.each([[undefined], [42], [null], [{ nested: true }]])(
    'reason 缺省或非字符串（%s）→ undefined',
    (reason) => {
      expect(asClaimIntent({ decision: 'reply', relevance: 5, reason }).reason).toBeUndefined()
    }
  )

  it.each([[null], [undefined], ['reply'], [42], [true]])('非对象入参 %s 一律抛', (raw) => {
    expect(() => asClaimIntent(raw)).toThrow(/must be an object/)
  })

  it.each([['respond'], [''], [undefined], [['reply']]])(
    'decision 为 %s 时抛，且带上原值',
    (decision) => {
      expect(() => asClaimIntent({ decision, relevance: 5 })).toThrow(/unknown decision/)
    }
  )

  it.each([['5'], [NaN], [null], [undefined]])('relevance 非 number（%s）抛', (relevance) => {
    expect(() => asClaimIntent({ decision: 'reply', relevance })).toThrow(/integer in 0\.\.9/)
  })

  it.each([[-1], [10], [3.5]])('relevance 越界或非整数（%s）抛', (relevance) => {
    expect(() => asClaimIntent({ decision: 'reply', relevance })).toThrow(/integer in 0\.\.9/)
  })

  it('多余的键被丢弃（跨 realm 的投影纪律）', () => {
    const out = asClaimIntent({
      decision: 'reply',
      relevance: 5,
      reason: 'ok',
      say: 'anything',
      __proto__: { evil: true }
    })
    expect(Object.keys(out).sort()).toEqual(['decision', 'reason', 'relevance'])
  })
})

describe('asSayContent —— say 的正文投影', () => {
  it('非空字符串原样返回', () => {
    expect(asSayContent('侦察完毕')).toBe('侦察完毕')
  })

  it.each([
    ['只有 headline', { headline: '标题' }, '标题'],
    ['只有 body', { body: '正文' }, '正文'],
    ['两者以空行相连', { headline: '标题', body: '正文' }, '标题\n\n正文']
  ])('对象形态：%s', (_n, raw, expected) => {
    expect(asSayContent(raw)).toBe(expected)
  })

  it.each([[{}], [{ headline: 1 }], [null], [42], [[]], [{ body: undefined }]])(
    '没有可用文本（%s）一律抛',
    (raw) => {
      expect(() => asSayContent(raw)).toThrow(/non-empty string or carry a headline/)
    }
  )

  it('纯空白的对象也抛（.trim() 闸）', () => {
    expect(() => asSayContent({ headline: '  ' })).toThrow(/non-empty string or carry a headline/)
  })

  it.each([[''], ['   ']])('空字符串 %s 也抛，不留静默空操作', (raw) => {
    // 放行的话空串会一路走到 appendBotMessage，那里因 !content.trim() 返回 null 并只打
    // 一条 warn —— 脚本拿到 {messageId: null}、journal 里没有失败记录、会话里什么都没有，
    // 正是「可见结局」不变式点名要杜绝的形态
    expect(() => asSayContent(raw)).toThrow(/non-empty string/)
  })
})
