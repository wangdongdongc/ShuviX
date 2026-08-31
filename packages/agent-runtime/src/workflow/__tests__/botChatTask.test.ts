/**
 * **真 bot-chat.md 的真脚本端到端** —— 内置管线的行为面。
 *
 * 与 builtinWorkflows.test.ts 的分工是刻意的：那边钉的是 md 的**结构**（有哪些块、
 * 缺省值是多少），这边跑的是它的**行为**（哪条分支在什么条件下走、提示词里到底拼进了
 * 什么、失败怎么出声）。管线是一份 md 而不是 TS 编排，所以它的逻辑没有别的地方可测：
 * 不在这里跑真脚本，改坏一个 `if` 只会在某次真实会话里表现为「bot 忽然不说话了」。
 *
 * 假的只有三样：脚本引擎（AsyncFunction，语义等价于宿主的 node:vm 包装）、
 * SubAgentManager（不起真 agent）、以及宿主装配进来的 `say`/`claim`/`turn`
 * （生产里它们由 botService 提供，其自身的表在 botServicePipeline.test.ts）。
 * 引擎、md 解析、提示词渲染、契约透传、超时/中止的 code 归类全是真代码。
 *
 * 分组：
 *   OC 场合分流 · P 提示词组装 · S 结构化直出（gate 就能答的） · T 任务段派发 ·
 *   RC 出队复核 · F 故障出声 · A 中止要安静 · W wrapProse 的退化输入 · AT attach 转交
 */
import { describe, expect, it, vi } from 'vitest'
import { buildBuiltinWorkflows } from '../builtinWorkflows'
import {
  createWorkflowEngine,
  type WorkflowEngineDeps,
  type WorkflowRegistryEntry
} from '../engine'
import { scriptEngine } from './harness'
import type { ParsedWorkflowFile } from '../workflowFile'
import type { RunTaskParams, SubAgentManager } from '../../subagent/manager'
import type { InProcessAgentType } from '../../subagent/types'

const BOT_CHAT = (): ParsedWorkflowFile =>
  buildBuiltinWorkflows({}).find((w) => w.name === 'bot-chat')!

/** bot 的笔记 —— 它住在 bot 自己的 systemPrompt 里（正文含笔记区），也单独喂给门控段 */
const NOTES = '用户偏好简答；项目根在 ~/work/api。'

/** 内置门控段：无工具，靠 next 交结构化结果 */
/** 笔记段：共享内置件，声明的工具比脚本给的宽 —— 用来验证脚本确实把它收窄了 */
const NOTES_AGENT: InProcessAgentType = {
  name: 'bot-notes',
  displayName: 'bot-notes',
  description: 'notes stage',
  tools: ['read', 'edit', 'bash'],
  systemPrompt: 'notes stage',
  instructionFiles: [],
  projectAwareness: false
}

const INTENT: InProcessAgentType = {
  name: 'bot-intent',
  displayName: 'Intent',
  description: '',
  tools: [],
  systemPrompt: 'You decide whether this bot should speak.'
}

/** 任务段 agent **就是 bot 自己**：正文（含笔记）即系统提示词，工具即它自己声明的那些 */
const SELF: InProcessAgentType = {
  name: 'scout',
  displayName: '侦察兵',
  description: '负责代码侦察',
  tools: ['read', 'grep', 'bash'],
  systemPrompt: `你是侦察兵。\n\n---\n\n${NOTES}`
}

// ── 阶段回复的三种形态 ──────────────────────────────────────────────────

type StageOutcome =
  /** 正常交回结构化结果 */
  | { structured: Record<string, unknown> }
  /** 跑完了却没调 next；`prose` 成为 e.finalText */
  | { prose: string }
  /** 一直挂到被中止/超时为止（step_timeout 与 step_aborted 都走这条） */
  | { hang: true; partial?: string }

const HANG_PARTIAL = '（半截的散文）'

function stageRun(
  outcome: StageOutcome,
  params: RunTaskParams
): Promise<{ result: string; structured?: unknown }> {
  if ('structured' in outcome) {
    return Promise.resolve({
      result: JSON.stringify(outcome.structured),
      structured: outcome.structured
    })
  }
  if ('prose' in outcome) return Promise.resolve({ result: outcome.prose })
  // 挂到中止为止 —— 真 manager 也是这么收的：拿到 abort 之后交回已产出的散文
  return new Promise((resolve) => {
    const signal = params.parentAbortSignal
    const done = (): void => resolve({ result: outcome.partial ?? HANG_PARTIAL })
    if (signal?.aborted) return done()
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 一次派发属于哪一段 —— 复核与门控用同一个 agent，只有提示词分得开 */
function stageOf(p: RunTaskParams): 'gate' | 'recheck' | 'task' {
  if (p.prompt.includes('This request was queued while the bot was busy')) return 'recheck'
  return p.agentType.name === INTENT.name ? 'gate' : 'task'
}

const GATE_REPLY = { decision: 'reply', relevance: 5, reason: '寒暄', reply: '你好，我在。' }
const GATE_TASK = {
  decision: 'task',
  relevance: 7,
  reason: '要动手查',
  task: { objective: '查一下 auth 中间件', boundaries: '只读，不要改文件' }
}
const TASK_REPLY = {
  headline: '查完了，两处可疑',
  body: '鉴权中间件的空值判断没跟上。',
  points: ['auth.ts:42', 'router 顺序'],
  status: 'ok'
}

interface SayCall {
  raw: unknown
  opts: Record<string, unknown> | undefined
}

interface BotChatOpts {
  gate?: StageOutcome
  task?: StageOutcome
  recheck?: StageOutcome
  /** claim 的裁决；缺省「赢了」 */
  claim?: { won: boolean; reason?: string; winner?: string }
  /** turn 授予的时隙 */
  slot?: Partial<{ superseded: string[]; selfReplied: boolean; queuedMs: number; since: string[] }>
  /** 任务段 ref 解析不出来（配置错） */
  taskAgentMissing?: boolean
  /** 笔记段 ref 解析不出来 */
  notesAgentMissing?: boolean
  /** 宿主没有附件回读能力 */
  noAttachmentResolver?: boolean
  /** say 抛出（宿主的仲裁强制点挡下） */
  sayThrows?: string
}

type Input = Record<string, unknown>

function makeBotChat(opts: BotChatOpts = {}): {
  invoke: (over?: Input) => Promise<{ ok?: boolean; output?: unknown; error?: string }>
  invokeWith: (over: Input, signal?: AbortSignal) => Promise<{ ok?: boolean; output?: unknown }>
  /** 不铺 baseInput —— 入参闸的用例要能少传一个键 */
  invokeRaw: (input: Input) => Promise<{ started?: boolean; reason?: string; error?: string }>
  says: SayCall[]
  claims: unknown[]
  turns: number
  runs: RunTaskParams[]
  of: (stage: 'gate' | 'recheck' | 'task') => RunTaskParams[]
  logs: string[]
  attachCalls: Array<{ refs: unknown[]; sessionId?: string }>
  prompts: Record<string, string>
} {
  const says: SayCall[] = []
  const claims: unknown[] = []
  const runs: RunTaskParams[] = []
  const logs: string[] = []
  const attachCalls: Array<{ refs: unknown[]; sessionId?: string }> = []
  const state = { turns: 0 }

  const runTask = vi.fn(async (p: RunTaskParams) => {
    runs.push(p)
    const stage = stageOf(p)
    const outcome =
      stage === 'gate'
        ? (opts.gate ?? { structured: GATE_REPLY })
        : stage === 'recheck'
          ? (opts.recheck ?? { structured: { verdict: 'proceed' } })
          : (opts.task ?? { structured: TASK_REPLY })
    return await stageRun(outcome, p)
  })

  const resolveAttachments: WorkflowEngineDeps['resolveAttachments'] = async (refs, sessionId) => {
    attachCalls.push({ refs, sessionId })
    return refs.map(() => ({
      role: 'user',
      content: [{ type: 'image', data: 'BYTES', mimeType: 'image/png' }]
    })) as never
  }

  const entries: WorkflowRegistryEntry[] = [{ file: BOT_CHAT(), source: 'builtin' }]
  const engine = createWorkflowEngine({
    manager: { runTask } as unknown as SubAgentManager,
    script: scriptEngine,
    listWorkflows: () => entries,
    resolveAgentProfile: (ref) => {
      if (ref === 'bot-intent') return INTENT
      if (ref === 'bot-notes') return opts.notesAgentMissing ? null : NOTES_AGENT
      if (ref === 'bot:scout') return opts.taskAgentMissing ? null : SELF
      return null
    },
    resolveRunModel: async () => ({ provider: 'p', model: 'm', capabilities: {} }),
    ...(opts.noAttachmentResolver ? {} : { resolveAttachments }),
    onRecord: (_n, _r, rec) => {
      if (rec.type === 'log') logs.push(String(rec.message))
    },
    env: { host: 'desktop', platform: 'darwin' }
  })

  const extraApi = {
    say: async (raw: unknown, o?: unknown): Promise<{ messageId: string }> => {
      if (opts.sayThrows) throw new Error(opts.sayThrows)
      says.push({ raw, opts: o as Record<string, unknown> | undefined })
      return { messageId: 'm-1' }
    },
    claim: async (intent: unknown): Promise<Record<string, unknown>> => {
      claims.push(intent)
      return { won: true, reason: 'solo', ...(opts.claim ?? {}) }
    },
    turn: async (fn?: unknown): Promise<unknown> => {
      state.turns += 1
      const slot = {
        superseded: [],
        selfReplied: false,
        queuedMs: 12,
        since: [],
        ...(opts.slot ?? {})
      }
      return typeof fn === 'function' ? await (fn as (s: unknown) => Promise<unknown>)(slot) : slot
    }
  }

  const invokeWith = async (
    over: Input,
    signal?: AbortSignal
  ): Promise<{ ok?: boolean; output?: unknown }> =>
    await engine.invoke({
      workflow: 'bot-chat',
      sessionId: 'S1',
      label: 'bt-1',
      extraApi,
      ...(signal ? { signal } : {}),
      input: { ...baseInput(), ...over }
    })

  return {
    invoke: (over = {}) => invokeWith(over),
    invokeWith,
    invokeRaw: (input) =>
      engine.invoke({ workflow: 'bot-chat', sessionId: 'S1', label: 'bt-1', extraApi, input }),
    says,
    claims,
    get turns() {
      return state.turns
    },
    runs,
    of: (stage) => runs.filter((p) => stageOf(p) === stage),
    logs,
    attachCalls,
    prompts: BOT_CHAT().prompts
  }
}

/** 管线信封的最小合法形态（`shuvix-workflow-input` 的四个 required 键齐全） */
function baseInput(): Input {
  return {
    occasion: 'message',
    bot: { name: 'scout', displayName: '侦察兵', description: '负责代码侦察', file: '/b/scout.md' },
    agents: { intent: 'bot-intent', task: 'bot:scout', notes: 'bot-notes' },
    session: { id: 'S1', arbitrated: false, directed: false, members: ['scout'] },
    message: { id: 'e1', seq: 1, text: '帮我看看鉴权那块' },
    window: [],
    notes: ''
  }
}

const outcomeOf = (res: { output?: unknown }): string =>
  String((res.output as { outcome?: unknown } | undefined)?.outcome)

// ────────────────────────────── OC：场合分流 ──────────────────────────────

describe('OC —— 场合分流', () => {
  it("OC-1 occasion:'notes' 只派发笔记段：零 say、零 claim、不碰仲裁", async () => {
    // 笔记是离线的：没人在等，也不该往会话里说任何话。它与消息场合共用一份 md，
    // 但两条路径除了 input 之外没有任何交集
    const h = makeBotChat()
    const res = await h.invoke({ occasion: 'notes', since: ['User: 以后用 pnpm'] })
    expect(outcomeOf(res)).toBe('notes')
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].agentType.name).toBe('bot-notes')
    expect(h.says).toHaveLength(0)
    expect(h.claims).toHaveLength(0)
  })

  it('OC-1b 笔记段拿到的工具恰为 read/edit —— 用户覆盖它也长不出别的', async () => {
    // 与门控段那行 `tools: []` 同一条理由：这是共享内置件，一份用户覆盖不该能在管线
    // 背后给自己添工具
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: ['User: x'] })
    // 声明了三个，脚本只给两个 —— 交集就是脚本说了算的那两个
    expect(h.runs[0].agentType.tools).toEqual(['read', 'edit'])
  })

  it('OC-1c 笔记段派不出去时不出声、不抛 —— 归纳失败是它自己的事', async () => {
    // 检查点只在成功后前进，所以失败的这一轮下次会看到同样的材料，不需要补偿动作。
    // 用「解析不出这个 agent」制造失败：它是唯一一种不依赖计时器的确定性 run 失败
    const h = makeBotChat({ notesAgentMissing: true })
    const res = await h.invoke({ occasion: 'notes', since: ['User: x'] })
    expect(outcomeOf(res)).toBe('notes-failed')
    expect(h.says).toHaveLength(0)
  })

  it('OC-1d 笔记段用 notesTimeoutSec（300s）那把尺：过了门控的 60s 还活着', async () => {
    // 笔记跑在关键路径之外、没人等着，所以它可以慢；门控在首字节路径上，必须快。两处若
    // 共用一个常量，改宽笔记就等于把每条消息的首字节一起放慢，反过来收紧门控又会让笔记
    // 在 60 秒上被腰斩 —— 而那一刀之后这批材料要等下一个门槛才有第二次机会。
    //
    // 观测点是**墙钟到点时那次 abort**：`timeoutSec` 由引擎自己 setTimeout 兑现，
    // 并不进 runTask 的入参，所以断言只能落在「到点之前没被拆、到点之后被拆了」上
    vi.useFakeTimers()
    try {
      const h = makeBotChat({ task: { hang: true } })
      const p = h.invoke({ occasion: 'notes', since: ['User: x'] })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(h.runs).toHaveLength(1)
      expect(h.runs[0].parentAbortSignal?.aborted, '在门控那把尺上就被拆了').toBe(false)

      await vi.advanceTimersByTimeAsync(240_000)
      expect(h.runs[0].parentAbortSignal?.aborted, '到 300s 仍没拆').toBe(true)
      await p
    } finally {
      vi.useRealTimers()
    }
  })

  it('OC-1n 墙钟到点算失败,不算「归纳完了」', async () => {
    // 无契约的一步此前根本报不出超时:整段失败合成都关在 `schema !== undefined` 里,于是
    // 300s 到点之后 run() 正常返回、脚本走到 `return {outcome:'notes'}`、宿主据此推进检查点
    // —— 那批材料就此埋掉。这正是「检查点只在成功后前进」要防的形状,只是走的另一条路
    vi.useFakeTimers()
    try {
      const h = makeBotChat({ task: { hang: true } })
      const p = h.invoke({ occasion: 'notes', since: ['User: x'] })
      await vi.advanceTimersByTimeAsync(301_000)
      expect(outcomeOf(await p)).toBe('notes-failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('OC-1e 笔记段没有结果契约 —— 活儿就是那次 edit，没有第二个读者', async () => {
    // 给它一份 schema 会诱导模型「描述自己改了什么」而不是去改；而那份描述没有任何人读
    // （宿主只看 outcome，脚本一个字都不碰笔记正文）。也因此正文里不该提 next（BA-14）
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: ['User: x'] })
    expect(h.runs[0].resultContract).toBeUndefined()
  })

  it('OC-1f 笔记提示词点名那份文件的路径，并要求就地改', async () => {
    // 宿主传的是 `bot.file` 的绝对路径 —— 笔记段靠它 read/edit，猜不出来也不该猜
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: ['User: x'] })
    const p = h.runs[0].prompt
    expect(p).toContain('/b/scout.md')
    expect(p).toContain('edit it in place')
  })

  it('OC-1g 笔记提示词里「什么都不改是常态」在场（机制侧的对位在 e2e）', async () => {
    // 提示词与 agent md（BA-10）各说一遍是刻意的：agent md 是这个段的长期人格，
    // 而这一句在任务里重复，是因为它恰恰是模型最容易违背的那条 —— 一个被派来「更新笔记」
    // 的 agent 天然倾向于写点什么。**机制上**「一次 edit 都没调」必须算成功，那条在 e2e
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: ['User: x'] })
    expect(h.runs[0].prompt).toContain('Changing nothing is a normal outcome')
  })

  it('OC-1h since 切到 vars.notesWindow 条（给 80 条只出现最后 60 条）', async () => {
    // 与门控窗口同一个理由，但这里更要紧：笔记的材料是**跨会话累积**的，一个忙了半小时的
    // bot 能攒出上千行。宿主侧另有一把尺（NOTES_MAX_LINES），两处都要 —— 一处管提示词，
    // 一处管被原样写进 run journal 的那份 input
    const since = Array.from({ length: 80 }, (_, i) => `User: 第${i}条`)
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since })
    const p = h.runs[0].prompt
    expect(p).not.toContain('第19条')
    expect(p).toContain('第20条')
    expect(p).toContain('第79条')
  })

  it('OC-1i since 为空 → 材料块连标题一起消失（不给一个空标题）', async () => {
    // 认的是**小节标题**而不是散文：notesTask 开头那句「The conversations below have
    // finished」恒在，可选的只有它下面那一段带 `##` 的材料块
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: [] })
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].prompt).not.toContain('## The conversations')
  })

  it('OC-1j 笔记场合用自己的标题「The conversations」，不复用复核那句「等待期间发生了什么」', async () => {
    // 两处都渲染一份 `since` 数组，于是很容易顺手复用同一个块 —— 但复核那句的语境是
    // 「这个 bot 正等着答一条排队的消息」，而笔记场合根本没有谁在等。同一份材料配错标题，
    // 模型会按「我刚才漏了什么」而不是「这些对话教了我什么」去读它
    const h = makeBotChat()
    await h.invoke({ occasion: 'notes', since: ['User: 以后用 pnpm'] })
    const p = h.runs[0].prompt
    expect(p).toContain('## The conversations')
    expect(p).not.toContain('What happened while it waited')
    expect(p).toContain('以后用 pnpm')
  })

  it('OC-1k 被中止 ≠ 归纳失败：step_aborted 原样抛出，run 记为失败且不报 notes-failed', async () => {
    // **这是「检查点只在成功后前进」的兑现处**（宿主那半边在 botServiceNotes）。脚本若把
    // step_aborted 也 catch 成 `{outcome:'notes-failed'}`，一次用户按停止就会被记成一轮
    // 「跑过了的归纳」——而宿主只要认了它，这批材料就永远埋掉了。对照 recheck 的同款处理
    // 笔记段挂住：中止是唯一一种「不是失败、而是根本没跑」的结局
    // （stageOf 把非 bot-intent 的派发都算作 'task'，笔记段的脚本化因此走 opts.task）
    const hung = makeBotChat({ task: { hang: true } })
    const ac = new AbortController()
    const p = hung.invokeWith({ occasion: 'notes', since: ['User: x'] }, ac.signal)
    await vi.waitFor(() => expect(hung.runs).toHaveLength(1))
    ac.abort()
    const res = await p
    expect(res.ok).toBe(false)
    expect(outcomeOf(res)).not.toBe('notes-failed')
    expect(outcomeOf(res)).not.toBe('notes')
  })

  it('OC-1l 归纳失败的一轮 run 本身仍是 ok:true —— 「跑完了」不等于「归纳成功了」', async () => {
    // 脚本 catch 之后是**正常返回**的，所以引擎照例记 ok:true。宿主因此不能只看 result.ok
    // （那正是 D1 那条缺陷的形状）：判据必须是脚本自报的 outcome
    const h = makeBotChat({ notesAgentMissing: true })
    const res = await h.invoke({ occasion: 'notes', since: ['User: x'] })
    expect(res.ok).toBe(true)
    expect(outcomeOf(res)).toBe('notes-failed')
  })

  it('OC-1m 仲裁落败者照样带回 memorable —— 记什么不该由「谁赢了这条消息」决定', async () => {
    // 一条「以后都用 pnpm」是说给整个会话听的。把 memorable 绑到胜者身上，等于一次对话
    // 只教会一个 bot，而落败者下一轮仍然一无所知
    const h = makeBotChat({
      claim: { won: false, reason: 'lost', winner: 'ranger' },
      gate: { structured: { ...GATE_REPLY, memorable: true } }
    })
    const res = await h.invoke()
    expect(res.output).toMatchObject({ outcome: 'yielded', to: 'ranger', memorable: true })
    expect(h.says).toHaveLength(0)
  })

  it.each(['occasion', 'bot', 'agents', 'session'])(
    'OC-2 少了 required 键 %s → invalid-input，脚本一次都没跑',
    async (key) => {
      // 四个键是宿主与管线之间的接线契约，不是模型输出 —— 少一个就是「换了个调用方、
      // 漏传一个字段」，让它跑起来只会在脚本深处炸成一句读不懂的 TypeError
      const h = makeBotChat()
      const res = await h.invokeRaw(withoutKey(baseInput(), key))
      expect(res).toMatchObject({ started: false, reason: 'invalid-input' })
      expect(String((res as { error?: string }).error)).toContain(key)
      expect(h.runs).toHaveLength(0)
    }
  )
})

const withoutKey = (input: Input, key: string): Input => {
  const copy = { ...input }
  delete copy[key]
  return copy
}

// ────────────────────────────── P：提示词组装 ──────────────────────────────

describe('P —— 提示词组装', () => {
  const gatePrompt = async (over: Input = {}, opts: BotChatOpts = {}): Promise<string> => {
    const h = makeBotChat(opts)
    await h.invoke(over)
    return h.of('gate')[0].prompt
  }

  it('P-1 门控提示词带上「我代表谁」与这条新消息的正文', async () => {
    const p = await gatePrompt()
    expect(p).toContain('侦察兵 — 负责代码侦察')
    expect(p).toContain('帮我看看鉴权那块')
  })

  it('P-2 笔记非空 → 笔记块整段出现；为空 → 连标题一起消失', async () => {
    // 「有内容才出现的一整段」必须整体是一个值 —— 模板只有 {{path}}，标题得住在值里面
    const withNotes = await gatePrompt({ notes: NOTES })
    expect(withNotes).toContain('What this bot remembers')
    expect(withNotes).toContain(NOTES)

    const without = await gatePrompt({ notes: '' })
    expect(without).not.toContain('What this bot remembers')
  })

  it('P-3 其它成员非空 → others 块列出各自的显示名与描述；无其他人则整段消失', async () => {
    const many = await gatePrompt({
      session: {
        id: 'S1',
        arbitrated: true,
        directed: false,
        members: ['scout', 'writer'],
        others: [{ displayName: '写手', description: '负责文案' }]
      }
    })
    expect(many).toContain('The other bots in this session')
    expect(many).toContain('- 写手: 负责文案')

    expect(await gatePrompt()).not.toContain('The other bots in this session')
  })

  it('P-4 solo（无仲裁或被点名）→ addressed 段出现；多 bot 且未点名则不出现', async () => {
    expect(await gatePrompt()).toContain('This message is addressed to this bot')

    const contested = {
      session: { id: 'S1', arbitrated: true, directed: false, members: ['scout', 'writer'] }
    }
    expect(await gatePrompt(contested)).not.toContain('This message is addressed to this bot')

    // 被点名 → 即使仲裁中也按 solo 待遇
    const named = {
      session: { id: 'S1', arbitrated: true, directed: true, members: ['scout', 'writer'] }
    }
    expect(await gatePrompt(named)).toContain('This message is addressed to this bot')
  })

  it('P-5 契约随 solo 切换：solo 用 intentSolo（没有 ignore），有竞争才给 ignore', async () => {
    // 1:1 会话里沉默与坏掉长得一模一样 —— 所以那里根本不提供 ignore 这个选项
    const solo = makeBotChat()
    await solo.invoke()
    expect(JSON.stringify(solo.of('gate')[0].resultContract?.schema)).not.toContain('ignore')

    const contested = makeBotChat()
    await contested.invoke({
      session: { id: 'S1', arbitrated: true, directed: false, members: ['scout', 'writer'] }
    })
    expect(JSON.stringify(contested.of('gate')[0].resultContract?.schema)).toContain('ignore')
  })

  it('P-6 门控窗口切到 vars.gateWindow 条（给 12 条只出现最后 8 条）', async () => {
    const window = Array.from({ length: 12 }, (_, i) => `User: 第${i}条`)
    const p = await gatePrompt({ window })
    expect(p).toContain('Recent conversation')
    expect(p).not.toContain('第3条')
    expect(p).toContain('第4条')
    expect(p).toContain('第11条')
  })

  it('P-7 窗口为空 → Recent conversation 整段消失', async () => {
    expect(await gatePrompt({ window: [] })).not.toContain('Recent conversation')
  })

  it('P-8 笔记超预算 → 在段落边界回退并以 … 收尾（切在半句上会被读成一个说到一半的事实）', async () => {
    const head = 'A'.repeat(1500)
    const tail = 'B'.repeat(1000)
    const p = await gatePrompt({ notes: `${head}\n\n${tail}` })
    expect(p).toContain('…')
    expect(p).not.toContain(tail)
    // 回退到段落边界：截点之前那一整段仍是完整的
    expect(p).toContain(head)
  })

  it('P-9 任务段提示词带 objective；boundaries 有则出现、无则整段消失', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    const p = h.of('task')[0].prompt
    expect(p).toContain('查一下 auth 中间件')
    expect(p).toContain('Stay inside')
    expect(p).toContain('只读，不要改文件')

    const bare = makeBotChat({
      gate: { structured: { decision: 'task', relevance: 7, reason: '就查一下', task: {} } }
    })
    await bare.invoke()
    const p2 = bare.of('task')[0].prompt
    expect(p2).not.toContain('Stay inside')
    // objective 缺省回落 intent.reason —— 没有目标的任务段等于让它自己猜
    expect(p2).toContain('就查一下')
  })

  it('P-10 【笔记只在 systemPrompt】任务段 prompt 不带笔记块，门控 prompt 才带', async () => {
    // 任务段 agent **就是 bot 自己**，笔记已在它的正文里。再发一遍等于每条消息多抄一份，
    // 而且是截断过的那一份 —— 模型于是看到同一批事实两次、还互相打架
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke({ notes: NOTES })

    const gate = h.of('gate')[0].prompt
    const task = h.of('task')[0]
    expect(gate).toContain(NOTES)
    expect(task.prompt).not.toContain(NOTES)
    expect(task.prompt).not.toContain('What this bot remembers')
    // 但它当然知道自己学过什么 —— 那是它的系统提示词的一部分
    expect(task.agentType.systemPrompt).toContain(NOTES)
  })

  it('P-11 任务段窗口切到 vars.taskWindow 条（比门控宽：干活要更多上下文）', async () => {
    const window = Array.from({ length: 25 }, (_, i) => `User: 第${i}条`)
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke({ window })
    const p = h.of('task')[0].prompt
    expect(p).not.toContain('第4条')
    expect(p).toContain('第5条')
    // 门控只拿最后 8 条，任务段拿 20 条 —— 两个窗口是各自切的
    expect(h.of('gate')[0].prompt).not.toContain('第16条')
    expect(p).toContain('第16条')
  })

  it('P-12 slot.since 非空 → 「等待期间发生的事」块进任务段提示词；为空则消失', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { since: ['User: 顺便也看看日志'] }
    })
    await h.invoke()
    const p = h.of('task')[0].prompt
    expect(p).toContain('What happened while it waited')
    expect(p).toContain('顺便也看看日志')

    const none = makeBotChat({ gate: { structured: GATE_TASK } })
    await none.invoke()
    expect(none.of('task')[0].prompt).not.toContain('What happened while it waited')
  })
})

// ─────────────────────── S：门控就能答的（结构化直出） ───────────────────────

describe('S —— gate 一句话答完，不开任务段', () => {
  it('S-1 decision:reply → 直接说出 intent.reply，任务段零派发', async () => {
    const h = makeBotChat()
    const res = await h.invoke()
    expect(h.says).toHaveLength(1)
    expect(h.says[0].raw).toBe('你好，我在。')
    expect(h.says[0].opts).toEqual({ decision: 'reply' })
    expect(h.of('task')).toHaveLength(0)
    expect(h.turns).toBe(0)
    expect(outcomeOf(res)).toBe('reply')
  })

  it('S-2 decision:clarify → 同一条路径，outcome 与 decision 都是 clarify', async () => {
    // clarify 的 decision 会写进署名侧车，下一条无提及消息据此硬路由回来 —— 传丢了
    // 这个字段，回连就成了永不触发的死代码
    const h = makeBotChat({
      gate: {
        structured: { decision: 'clarify', relevance: 6, reason: '有歧义', reply: '哪一个？' }
      }
    })
    const res = await h.invoke()
    expect(h.says[0]).toEqual({ raw: '哪一个？', opts: { decision: 'clarify' } })
    expect(outcomeOf(res)).toBe('clarify')
  })

  it('S-3 说要开口却写了空串 → 按门控破损出声（与从不调 next 同一类故障）', async () => {
    const h = makeBotChat({
      gate: { structured: { decision: 'reply', relevance: 5, reason: 'x', reply: '   ' } }
    })
    const res = await h.invoke()
    expect(h.says).toHaveLength(1)
    expect(h.says[0].raw).toContain('shape I could not read')
    expect(h.says[0].opts).toEqual({ error: true })
    expect(outcomeOf(res)).toBe('gate-broken')
  })

  it('S-4 memorable 透传到返回值（M9′ 的笔记场合据此排期）', async () => {
    const h = makeBotChat({
      gate: { structured: { ...GATE_REPLY, memorable: true } }
    })
    const res = await h.invoke()
    expect((res.output as { memorable?: unknown }).memorable).toBe(true)
  })

  it('S-5 claim 输了 → 一个字都不说，outcome 分清「我判定不接」与「别人更合适」', async () => {
    const ignored = makeBotChat({ claim: { won: false, reason: 'ignored' } })
    expect(outcomeOf(await ignored.invoke())).toBe('ignored')
    expect(ignored.says).toHaveLength(0)

    const lost = makeBotChat({ claim: { won: false, reason: 'lost', winner: 'writer' } })
    const res = await lost.invoke()
    expect(outcomeOf(res)).toBe('yielded')
    expect((res.output as { to?: unknown }).to).toBe('writer')
    expect(lost.says).toHaveLength(0)
  })

  it('S-6 claim 拿到的是收窄前的完整 intent（宿主自己再校验一遍取值域）', async () => {
    const h = makeBotChat()
    await h.invoke()
    expect(h.claims[0]).toMatchObject({ decision: 'reply', relevance: 5, reason: '寒暄' })
  })
})

// ────────────────────────────── T：任务段派发 ──────────────────────────────

describe('T —— 任务段派发', () => {
  it('T-1 decision:task → 进 turn()，任务段恰派发一次，agent 就是 bot 自己', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    expect(h.turns).toBe(1)
    expect(h.of('task')).toHaveLength(1)
    expect(h.of('task')[0].agentType.name).toBe('scout')
  })

  it('T-2 【无 tools 选项】任务段拿到 bot 自己声明的全量工具，不被管线收窄', async () => {
    // 收窄会推翻 bot md 关于它自己的说法 —— 与门控段（共享内置件，必须锁成零工具）
    // 是相反的立场：这个 agent 就是为这份活写的
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    expect(h.of('task')[0].agentType.tools).toEqual(SELF.tools)
    // 对照：门控段被显式锁成空
    expect(h.of('gate')[0].agentType.tools).toEqual([])
  })

  it('T-3 结果契约是 schemas.reply，sourceLabel 指回这份管线', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    const contract = h.of('task')[0].resultContract!
    expect(contract.schema).toEqual(BOT_CHAT().schemas.reply)
    expect(contract.sourceLabel).toBe('bot-chat')
  })

  it('T-4 派发归属会话 —— 工具/询问/日志/面板都得落在这条会话上', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    for (const p of h.runs) expect(p.parentSessionId).toBe('S1')
  })

  it('T-5 任务段结果原样交给 say，并带 decision:task', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    expect(h.says).toHaveLength(1)
    expect(h.says[0].raw).toEqual(TASK_REPLY)
    expect(h.says[0].opts).toEqual({ decision: 'task' })
  })

  it('T-6 返回值带 outcome/queuedMs/superseded —— 排队的代价要能在 journal 里看见', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { queuedMs: 4200, superseded: ['bt-9'] }
    })
    const res = await h.invoke()
    expect(res.output).toMatchObject({
      gate: 'ok',
      outcome: 'task',
      queuedMs: 4200,
      superseded: ['bt-9']
    })
  })

  it('T-7 被合并掉的排队请求记一条 log（否则「我发了三条它只答一条」无从解释）', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { superseded: ['bt-7', 'bt-8'] }
    })
    await h.invoke()
    expect(h.logs).toContain('merged bt-7,bt-8')
  })
})

// ────────────────────────────── RC：出队复核 ──────────────────────────────

describe('RC —— 排在自己回复之后的那一条要不要再做一遍', () => {
  it('RC-1 slot.selfReplied 为 false → 不复核，直接干活', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    expect(h.of('recheck')).toHaveLength(0)
    expect(h.of('task')).toHaveLength(1)
  })

  it('RC-2 selfReplied + verdict:skip → 说一句收尾，任务段零派发', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { structured: { verdict: 'skip', reply: '刚才那条已经说过了。' } }
    })
    const res = await h.invoke()
    expect(h.of('task')).toHaveLength(0)
    expect(h.says[0]).toEqual({ raw: '刚才那条已经说过了。', opts: { decision: 'reply' } })
    expect(outcomeOf(res)).toBe('recheck-skipped')
  })

  it('RC-3 skip 但没给收尾语 → 用内置的那句（一句不说的 skip 与丢消息分不开）', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { structured: { verdict: 'skip' } }
    })
    await h.invoke()
    expect(h.says[0].raw).toBe(BOT_CHAT().prompts.recheckSkipped.trim())
  })

  it('RC-4 verdict:proceed → 照常派发任务段', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { structured: { verdict: 'proceed' } }
    })
    expect(outcomeOf(await h.invoke())).toBe('task')
    expect(h.of('task')).toHaveLength(1)
  })

  it('RC-5 复核自己坏了 → 记一条 log 然后照常干活（失败即 proceed）', async () => {
    // 复核只可能省下一次重复，失败的代价必须是「多做一次」而不是「不做」
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { prose: '我也不知道' }
    })
    expect(outcomeOf(await h.invoke())).toBe('task')
    expect(h.logs.some((l) => l.startsWith('recheck skipped'))).toBe(true)
  })

  it('RC-6 复核提示词带 since 块与会话窗口，走的是 recheck 契约', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true, since: ['Assistant: 我刚回了别的'] },
      recheck: { structured: { verdict: 'proceed' } }
    })
    await h.invoke({ window: ['User: 早先那条'] })
    const p = h.of('recheck')[0]
    expect(p.prompt).toContain('What happened while it waited')
    expect(p.prompt).toContain('我刚回了别的')
    expect(p.prompt).toContain('早先那条')
    expect(p.resultContract?.schema).toEqual(BOT_CHAT().schemas.recheck)
    // 复核也是判断不是干活 —— 同样锁成零工具
    expect(p.agentType.tools).toEqual([])
  })

  it('RC-7 复核默认用 agents.intent；显式给了 agents.recheck 就用它', async () => {
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { structured: { verdict: 'proceed' } }
    })
    await h.invoke()
    expect(h.of('recheck')[0].agentType.name).toBe('bot-intent')
  })
})

// ────────────────────────────── F：故障要出声 ──────────────────────────────

describe('F —— 失败与超时：过了 claim 就没人替我兜底', () => {
  it('F-1 门控破损 + 单 bot → 出声说「读不懂自己的判断」，outcome gate-broken', async () => {
    const h = makeBotChat({ gate: { prose: '我觉得应该回答' } })
    const res = await h.invoke()
    expect(h.says).toHaveLength(1)
    expect(h.says[0].raw).toContain('shape I could not read')
    expect(h.says[0].opts).toEqual({ error: true })
    expect(res.output).toMatchObject({ gate: 'broken', outcome: 'gate-broken' })
    // 没走到 claim —— 故障不是判定
    expect(h.claims).toHaveLength(0)
  })

  it('F-2 门控破损 + 多 bot → 一声不吭地让位（别人还能接）', async () => {
    const h = makeBotChat({ gate: { prose: '……' } })
    const res = await h.invoke({
      session: { id: 'S1', arbitrated: true, directed: false, members: ['scout', 'writer'] }
    })
    expect(h.says).toHaveLength(0)
    expect(res.output).toMatchObject({ gate: 'broken', outcome: 'gate-broken' })
  })

  it('F-3 门控超时 + 单 bot → 另一句文案，outcome gate-timeout', async () => {
    vi.useFakeTimers()
    try {
      const h = makeBotChat({ gate: { hang: true } })
      const p = h.invoke()
      await vi.advanceTimersByTimeAsync(61_000)
      const res = await p
      expect(h.says[0].raw).toContain('too long deciding')
      expect(res.output).toMatchObject({ gate: 'timeout', outcome: 'gate-timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('F-4 任务段超时 → 出声，outcome task-timeout 且带 queuedMs', async () => {
    vi.useFakeTimers()
    try {
      const h = makeBotChat({ gate: { structured: GATE_TASK }, task: { hang: true } })
      const p = h.invoke()
      await vi.advanceTimersByTimeAsync(1_801_000)
      const res = await p
      expect(h.says[0].raw).toContain("as long as I'm allowed")
      expect(h.says[0].opts).toEqual({ error: true })
      expect(res.output).toMatchObject({ outcome: 'task-timeout', queuedMs: 12 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('F-5 任务段 agent 不存在 → 说这是配置问题并点名那个 ref，outcome task-no-agent', async () => {
    // 「重试永远不会好」与「跑到一半挂了」是两回事，把人指向错误的方向比不说还糟
    const h = makeBotChat({ gate: { structured: GATE_TASK }, taskAgentMissing: true })
    const res = await h.invoke()
    expect(h.says).toHaveLength(1)
    expect(h.says[0].raw).toContain('bot:scout')
    expect(h.says[0].raw).toContain('configuration problem')
    expect(h.says[0].opts).toEqual({ error: true })
    expect(outcomeOf(res)).toBe('task-no-agent')
  })

  it('F-6 任务段没调 next 但留下散文 → 散文降级成回复，outcome task-unshaped', async () => {
    // 「无形状的回复胜过没有回复」—— 有人在等答案
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      task: { prose: '查完了，两处可疑\n细节在 auth.ts' }
    })
    const res = await h.invoke()
    expect(h.says[0].raw).toEqual({ headline: '查完了，两处可疑', body: '细节在 auth.ts' })
    // 降级的是形状不是身份 —— 它仍是一条正经回复，不是错误气泡
    expect(h.says[0].opts).toEqual({ decision: 'task' })
    expect(outcomeOf(res)).toBe('task-unshaped')
  })

  it('F-7 任务段既没调 next 又没留下散文 → 承认什么都没做成，outcome task-failed', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK }, task: { prose: '   ' } })
    const res = await h.invoke()
    expect(h.says[0].raw).toContain('broke partway through')
    expect(h.says[0].opts).toEqual({ error: true })
    expect(outcomeOf(res)).toBe('task-failed')
  })

  it('F-8 say 自己被挡下（仲裁强制点）→ run 以失败收尾，不吞成一次「成功的沉默」', async () => {
    const h = makeBotChat({ sayThrows: 'another bot won this message' })
    const res = await h.invoke()
    expect(res.ok).toBe(false)
    expect(h.says).toHaveLength(0)
  })
})

// ───────────────────────────── A：中止要安静 ─────────────────────────────

/**
 * **中止的可观测面只有「什么都没发生」。** 引擎在 run 级 abort 上是 `Promise.race`
 * 收尾的（node:vm 无法硬中断异步续体），所以脚本那句 `return {outcome:'aborted'}`
 * 永远赶不上 —— run 记的是 `ok:false / workflow run aborted`，而那句 return 的作用从来
 * 不是给 journal 看的：它是脚本**别再往下走**的方式，让 say/turn/任务段一个都别发生。
 * 这一组因此断言的是缺席（零 say、零后续派发），并在放行之后多等一拍，好让脱手继续跑
 * 的脚本有机会犯错 —— 不等的话「零 say」会是一次不作数的假绿。
 */
describe('A —— 被拆掉不是故障：安静退出', () => {
  /** 让 race 输掉之后仍在脱手运行的脚本把自己跑完 */
  const settleDetached = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('A-1 门控段被中止 → run 记为中止，一个字都不说（被别人赢了 / 会话停了）', async () => {
    const h = makeBotChat({ gate: { hang: true } })
    const ac = new AbortController()
    const p = h.invokeWith({}, ac.signal)
    await vi.waitFor(() => expect(h.of('gate')).toHaveLength(1))
    ac.abort()
    const res = await p
    expect(res).toMatchObject({ ok: false })
    await settleDetached()
    expect(h.says).toHaveLength(0)
  })

  it('A-2 任务段被中止 → 零 say（这个 bot 已经拿了 turn，出声只会是噪音）', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK }, task: { hang: true } })
    const ac = new AbortController()
    const p = h.invokeWith({}, ac.signal)
    await vi.waitFor(() => expect(h.of('task')).toHaveLength(1))
    ac.abort()
    expect(await p).toMatchObject({ ok: false })
    await settleDetached()
    expect(h.says).toHaveLength(0)
  })

  it('A-3 复核被中止 → 不吞（否则会在一条正在关停的会话上继续开任务段）', async () => {
    // recheck 的 catch 对 step_aborted 是 `throw e` 而不是 `return null` —— 吞掉它
    // 就等于把「会话停了」读成「复核没跑成，那就照常干活」
    const h = makeBotChat({
      gate: { structured: GATE_TASK },
      slot: { selfReplied: true },
      recheck: { hang: true }
    })
    const ac = new AbortController()
    const p = h.invokeWith({}, ac.signal)
    await vi.waitFor(() => expect(h.of('recheck')).toHaveLength(1))
    ac.abort()
    await p
    await settleDetached()
    expect(h.of('task')).toHaveLength(0)
    expect(h.says).toHaveLength(0)
  })

  it('A-4 中止把在飞派发的 signal 一并拉下（不留下继续烧钱的 agent）', async () => {
    const h = makeBotChat({ gate: { hang: true } })
    const ac = new AbortController()
    const p = h.invokeWith({}, ac.signal)
    await vi.waitFor(() => expect(h.of('gate')).toHaveLength(1))
    ac.abort()
    await p
    expect(h.of('gate')[0].parentAbortSignal?.aborted).toBe(true)
  })

  it('A-5 中止先于门控返回 → 既不进仲裁也不占 turn', async () => {
    const h = makeBotChat({ gate: { hang: true } })
    const ac = new AbortController()
    const p = h.invokeWith({}, ac.signal)
    await vi.waitFor(() => expect(h.of('gate')).toHaveLength(1))
    ac.abort()
    await p
    await settleDetached()
    expect(h.claims).toHaveLength(0)
    expect(h.turns).toBe(0)
  })
})

// ─────────────────── W：wrapProse —— 降级路径上的最后一道形状 ───────────────────

/**
 * `wrapProse` 只在「任务段跑完了却没调 next、但留下了散文」这一条路径上被调用，所以
 * 它的入参永远是**已经 trim 过的非空串**（脚本里那句 `if (code === 'next_not_called'
 * && prose)`）。这一组因此全部走真管线进去，而不是把函数抠出来单测 —— 抠出来测就等于
 * 自己重述了那条前置条件，而 W-13 的全部价值恰恰在于它成立。
 */
describe('W —— 散文降级的形状', () => {
  const wrapped = async (prose: string): Promise<Record<string, unknown>> => {
    const h = makeBotChat({ gate: { structured: GATE_TASK }, task: { prose } })
    await h.invoke()
    expect(h.says, prose).toHaveLength(1)
    return h.says[0].raw as Record<string, unknown>
  }

  it('W-1 单行散文 → 整句成为结论，不铺空 body', async () => {
    expect(await wrapped('查完了，没问题')).toEqual({ headline: '查完了，没问题' })
  })

  it('W-2 首行 + 余下 → 首行升格为结论，其余成为解释', async () => {
    expect(await wrapped('结论一句\n然后是解释')).toEqual({
      headline: '结论一句',
      body: '然后是解释'
    })
  })

  it('W-3 前导空行被跳过（模型爱在正文前空一行）', async () => {
    expect(await wrapped('\n\n  \n结论一句\n解释')).toEqual({
      headline: '结论一句',
      body: '解释'
    })
  })

  it.each([
    ['# 一级', '# 结论\n正文'],
    ['### 三级', '### 结论\n正文'],
    ['井号后无空格', '#结论\n正文']
  ])('W-4 markdown 标题记号被剥掉（%s）—— 它是家具不是结论', async (_n, prose) => {
    expect(await wrapped(prose)).toEqual({ headline: '结论', body: '正文' })
  })

  it('W-5 body 保留内部换行与空行（散文的段落结构本身就是信息）', async () => {
    const out = await wrapped('结论\n第一段\n\n第二段')
    expect(out.body).toBe('第一段\n\n第二段')
  })

  it('W-6 body 首尾被 trim（首行之后那串空行不该变成正文开头）', async () => {
    expect((await wrapped('结论\n\n\n  正文  \n\n')).body).toBe('正文')
  })

  it('W-7 首行之后全是空白 → 不铺 body（而不是铺一个空串）', async () => {
    expect(await wrapped('结论\n\n   \n')).toEqual({ headline: '结论' })
  })

  it('W-8 只有井号的一行 → 落到兜底，整段 trim 后当结论（不产出空 headline）', async () => {
    expect(await wrapped('###')).toEqual({ headline: '###' })
  })

  it('W-9 兜底路径截到 200 字（一整篇散文塞进 headline 会把气泡撑爆）', async () => {
    const out = await wrapped(`#\n${'x'.repeat(400)}`)
    // 首个非空行是 400 个 x —— 它没有被剥空，所以走的是正常路径
    expect(String(out.headline)).toHaveLength(400)

    const fallback = await wrapped('#'.repeat(300))
    expect(String(fallback.headline)).toHaveLength(200)
  })

  it('W-10 正常路径的首行**不**截断 —— 只有兜底才截（两条路径的口径刻意不同）', async () => {
    const long = 'y'.repeat(500)
    expect((await wrapped(`${long}\n余下`)).headline).toBe(long)
  })

  it('W-11 CRLF 输入：结论行不带残留的回车', async () => {
    expect((await wrapped('结论\r\n正文')).headline).toBe('结论')
  })

  it('W-12 首行是列表项 → 原样当结论（`- ` 不是标题记号，剥掉会改写内容）', async () => {
    expect(await wrapped('- 第一点\n- 第二点')).toEqual({
      headline: '- 第一点',
      body: '- 第二点'
    })
  })

  it.each([
    ['单个井号', '#'],
    ['一串井号', '#####'],
    ['井号 + 空格', '#   '],
    ['空白包着一个井号', '  \n # \n '],
    ['一个标点', '。'],
    ['单字符', 'x'],
    ['只有换行与井号', '\n#\n#\n'],
    ['首行被剥空、次行也被剥空', '#\n##\n真正的内容']
  ])('W-13 【不变量】非空散文（%s）恒产出非空 headline', async (_n, prose) => {
    // 脚本注释亲口声明的那条：wrapProse 若吐出空 headline，`say` 会在**降级路径内部**
    // 抛出，于是「答案没有形状」变成「根本没有答案」——降级路径自己把自己拆了
    const out = await wrapped(prose)
    expect(String(out.headline ?? '').trim(), prose).not.toBe('')
  })

  it('W-14 body 里的 markdown 原样保留（降级只补形状，不改写内容）', async () => {
    const out = await wrapped('结论\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(out.body).toContain('| A | B |')
  })

  it('W-15 降级产物是纯散文形状 —— 没有 points/table/status 被凭空发明出来', async () => {
    expect(Object.keys(await wrapped('结论\n解释')).sort()).toEqual(['body', 'headline'])
  })
})

// ────────────────────────── AT：附件只转交句柄 ──────────────────────────

describe('AT —— attach：脚本转交句柄，宿主在派发那一刻取字节', () => {
  const REFS = [
    { sessionId: 'S1', entryId: 'e1', index: 0, mimeType: 'image/png' },
    { sessionId: 'S1', entryId: 'e1', index: 1, mimeType: 'image/jpeg' }
  ]
  const withImages = (): Input => ({
    message: { id: 'e1', seq: 1, text: '看看这两张图', attachments: REFS }
  })

  it('AT-1 message.attachments 原样转交给 run 的 attach，宿主收到的是句柄不是字节', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke(withImages())
    expect(h.attachCalls).toHaveLength(1)
    expect(h.attachCalls[0].refs).toEqual(REFS)
    expect(h.attachCalls[0].sessionId).toBe('S1')
    // 回读来的字节以 contextMessages 进派生上下文，而不是塞进提示词
    expect(h.of('task')[0].contextMessages).toHaveLength(2)
  })

  it('AT-2 没有附件 → 回读接缝一次都不调（不为每条消息白跑一次读树）', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke()
    expect(h.attachCalls).toHaveLength(0)
    expect(h.of('task')[0].contextMessages).toBeUndefined()
  })

  it('AT-3 【不宣告张数】提示词里没有任何一句在说「上面有几张图」', async () => {
    // 取不到附件时那句话就是在诱导幻觉，而图片本来就以 user 消息的形式在上下文里 ——
    // 需要被告知的是模型的眼睛，不是它的提示词
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke(withImages())
    const p = h.of('task')[0].prompt
    expect(p).not.toMatch(/attach|image|图片|附件/i)
    expect(p).not.toContain('image/png')
  })

  it('AT-4 门控段不带附件 —— 判断该不该接话不需要看图（也省一次读树）', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke(withImages())
    expect(h.of('gate')[0].contextMessages).toBeUndefined()
    expect(h.attachCalls).toHaveLength(1)
  })

  it('AT-5 句柄不含字节 —— 转交出去的对象逐字段就是宿主给的那四个键', async () => {
    // 脚本的 input 会被原样写进 run journal：让 base64 进 input 等于每条带图消息都在
    // 磁盘上留下一份逐 bot 的副本
    const h = makeBotChat({ gate: { structured: GATE_TASK } })
    await h.invoke(withImages())
    for (const ref of h.attachCalls[0].refs as Array<Record<string, unknown>>) {
      expect(Object.keys(ref).sort()).toEqual(['entryId', 'index', 'mimeType', 'sessionId'])
      expect(JSON.stringify(ref)).not.toContain('BYTES')
    }
  })

  it('AT-6 宿主没有回读能力 → 记一条 log 并照常干活（少一张图好过没有回答）', async () => {
    const h = makeBotChat({ gate: { structured: GATE_TASK }, noAttachmentResolver: true })
    const res = await h.invoke(withImages())
    expect(h.logs).toContain('attach ignored: host has no attachment resolver')
    expect(outcomeOf(res)).toBe('task')
  })
})
