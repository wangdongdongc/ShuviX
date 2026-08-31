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
// 会话域埋点的事实构造器会拉进 sessionDao / messageService / i18n —— 这些用例不测埋点，
// 桩掉比给 paths mock 补一串无关导出干净
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({ sessionService: { getById: vi.fn() } }))

import { DEFAULT_BOT_PIPELINE } from '@shuvix/agent-runtime'
import {
  asClaimIntent,
  asSayContent,
  botSelfRef,
  cohortSilence,
  resolvePipeline
} from '../botService'

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
    ['两者以空行相连', { headline: '标题', body: '正文' }, '标题\n\n正文']
  ])('对象形态：%s', (_n, raw, expected) => {
    expect(asSayContent(raw)).toBe(expected)
  })

  it('只有 body 没有 headline —— M8′ 收窄之后不再放行', () => {
    // BotReply 的 headline 是必填的「结论先行」。没有结论的散文该走脚本里那条降级
    // （`{headline: 首行, body: 余下}`），而不是让宿主替它把无形状的一坨认成合法回复 ——
    // 宿主一放行，脚本那条降级就永远不会被写出来
    expect(() => asSayContent({ body: '正文' })).toThrow(/non-empty string or carry a headline/)
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

/**
 * 「这一轮 cohort 一个字都没换来」的定性 —— 又一张**表**，所以摆在这一层而不是 e2e。
 *
 * 它要答的是两个用户能读懂的问题：会话里到底有没有多出东西（第一问），以及这次沉默
 * 是正常的（大家都判定这条不归自己）还是坏掉了（没有一个走到判定）。两者对用户的意味
 * 完全相反 —— 前者不必管，后者要去看日志。端到端能验的是链路，这张表的每一格只能在
 * 这里逐条摆开。
 */
describe('cohortSilence —— 全体沉默的定性表', () => {
  let seq = 0
  /** 一个成员的结局：只有「说没说话」与「怎么收的」两个自由度 */
  const o = (
    said: boolean,
    outcome: string
  ): { botName: string; displayName: string; said: boolean; outcome: string } => {
    seq += 1
    return { botName: `b${seq}`, displayName: `B${seq}`, said, outcome }
  }

  it('任一成员开了口就没有沉默可言（哪怕另一个坏掉了）', () => {
    expect(cohortSilence([o(true, 'ok'), o(false, 'failed')])).toBeNull()
  })

  it('全员自判不接 → all_ignored（沉默白名单里唯一的正常项）', () => {
    expect(cohortSilence([o(false, 'claim_ignored'), o(false, 'claim_ignored')])).toEqual({
      reason: 'all_ignored'
    })
  })

  it('没有一个走到判定 → all_failed', () => {
    expect(cohortSilence([o(false, 'failed'), o(false, 'pipeline_error')])).toEqual({
      reason: 'all_failed'
    })
  })

  it('一个判定不接、一个坏掉 → mixed（不能说成「大家都不接」）', () => {
    expect(cohortSilence([o(false, 'claim_ignored'), o(false, 'failed')])).toEqual({
      reason: 'mixed'
    })
  })

  it.each([
    ['claim_timeout 是慢不是判定', 'claim_ignored', 'claim_timeout', 'mixed'],
    ['claim_lost 与 claim_timeout 都不是判定', 'claim_lost', 'claim_timeout', 'all_failed']
  ])('%s', (_n, a, b, reason) => {
    // 白名单只有 claim_ignored 一项 —— 「输了」「太慢了」都意味着本该有人说话却没说，
    // 把它们算进正常项，一次真正的故障就会被写成「大家都判定这条不归自己」
    expect(cohortSilence([o(false, a), o(false, b)])).toEqual({ reason })
  })

  it('空列表 → null（没有 cohort 就没有结局可言）', () => {
    expect(cohortSilence([])).toBeNull()
  })

  it('said 问的是「会话里多出了东西吗」，不是「脚本调过 say 吗」', () => {
    // 管线不存在时宿主自己落了一条可见失败并把 said 记为 true —— 一条已经显形的失败
    // 不该再触发一次沉默提示
    expect(cohortSilence([o(true, 'pipeline_not_found'), o(false, 'claim_ignored')])).toBeNull()
  })

  it('单成员数组照样被定性 —— 「多 bot 才提示」的纪律住在调用点', () => {
    // cohort.length > 1 的判断刻意留在 dispatchCohort：单 bot 的沉默只可能是失败，
    // 那里要的是一条留痕的失败消息而不是一次转瞬即逝的提示。这个函数不替它做主
    expect(cohortSilence([o(false, 'failed')])).toEqual({ reason: 'all_failed' })
  })
})
