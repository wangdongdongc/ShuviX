/**
 * botService 管线半边的接线：两张**表**、一个跨 realm 校验器、以及一次派发的**票面**。
 *
 *  - `resolvePipeline`：管线名原样（**没有回落** —— `workflow` 必填由解析器保证）、槽位表
 *    （来自管线自己的输入 schema）、槽位 → agent 的映射（bot 自己填的表 + 回落覆盖，没有缺省行）；
 *  - `asSayContent`：say 正文的投影表 —— 脚本值进入宿主的信任边界，值跨 vm realm 到达，
 *    `instanceof` 不可靠，逐字段 typeof 是唯一防线，因此每一格都值得单独摆一条；
 *  - DP：一次 invoke 带了什么 —— input 的键集、`systemContext` 里那一块正文围栏、派发前替
 *    会话记的那笔读取，以及 `started:false` 的两种收场在会话里各长什么样。
 *
 * mock 面沿用其它 botService 用例那套（botService 是模块级单例，构造时就读 paths）。
 * DP 那组打真 fs：bot md 得有一个真路径 —— `input.bot.file`、围栏的 `file` 属性、
 * `recordRead` 记的那条，三处写的都必须是它。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  ParsedBotFile,
  PipelineAgentSlot,
  WorkflowErrorStep,
  WorkflowInvokeResult
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botpipe-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({
  hasWorkflow: vi.fn((_name: string) => false),
  agentSlots: vi.fn(
    (_name: string) => [] as Array<{ role: string; required: boolean; description?: string }>
  ),
  invoke: vi.fn(),
  getById: vi.fn(),
  recordRead: vi.fn(),
  t: vi.fn((key: string, _params?: Record<string, unknown>) => key),
  broadcast: vi.fn()
}))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: mocks.invoke,
    abortSessionRuns: vi.fn(() => 0),
    hasWorkflow: mocks.hasWorkflow,
    agentSlots: mocks.agentSlots,
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => `${dirs.base}/data`,
  // 真件是 ensureDir(...)：建目录后才返回。不建的话 saveChatAttachments 会逐张写失败
  // （它只丢那一张，不抛），带图的用例看到的就是「一个附件句柄也没有」
  getChatAttachmentsDir: (sid: string) => {
    const dir = `${dirs.base}/data/chat-attachments/${sid}`
    mkdirSync(dir, { recursive: true })
    return dir
  },
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // botService → agentService 的模块作用域构造器在 import 阶段就要它
  getDefaultAgentsDir: () => `${dirs.base}/agents`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 会话可见文案走 i18n —— 断言用 key 而不是某一种语言的串；插值参数由 spy 记下
vi.mock('../../i18n', () => ({ t: mocks.t }))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: mocks.broadcast } }))
// 会话域埋点的事实构造器会拉进 sessionDao / messageService / i18n —— 这些用例不测埋点，
// 桩掉比给 paths mock 补一串无关导出干净
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({
  // noteUnreadBotReply：appendBotMessage 每次落库都记未读账 —— 本文件不关心它，给 no-op
  sessionService: { getById: mocks.getById, noteUnreadBotReply: () => {} }
}))
// 派发前替会话记的那笔「已读」：只换掉 recordRead，其余导出原样
vi.mock('../../utils/toolUtils/fileTime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/toolUtils/fileTime')>()),
  recordRead: mocks.recordRead
}))

import { renderBotContext } from '@shuvix/agent-runtime'
import {
  asSayContent,
  botService,
  BUILTIN_GATE_AGENT,
  failureCopy,
  gateVerdictOf,
  resolvePipeline
} from '../botService'
import { chatMessageDao, __reset as resetRows } from './fakeChatMessageDao'

function stubBot(p: Partial<ParsedBotFile> & { name: string }): ParsedBotFile {
  return {
    displayName: p.name,
    description: `stub ${p.name}`,
    body: '',
    // 解析器保证 workflow 非空 —— 桩也照此，缺省给模板管线的名字
    pipeline: 'bot-chat',
    pipelineInput: {},
    agents: {},
    ...p
  }
}

beforeEach(() => {
  mocks.hasWorkflow.mockReset()
  mocks.hasWorkflow.mockReturnValue(false)
  mocks.agentSlots.mockReset()
  mocks.agentSlots.mockReturnValue([])
})

describe('resolvePipeline —— 管线名、槽位表与槽位 → agent 的映射', () => {
  it('workflow 就是 bot md 里 shuvix-bot-pipeline.workflow 原样 —— 没有回落', () => {
    // 改制前空串回落 bot-chat；现在「必填」由解析器保证（缺了整份非法），宿主不再兜底：
    // 两层各兜一次，「这次到底跑了谁」就要靠读优先级表才能回答
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'my-flow' })).workflow).toBe('my-flow')
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'bot-chat' })).workflow).toBe('bot-chat')
    // 解析器产不出空串；万一（GUI 直接构造 ParsedBotFile）也原样透传，不替它编一个名字
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: '' })).workflow).toBe('')
  })

  it.each([[true], [false]])('exists 取自 hasWorkflow(workflow) = %s', (found) => {
    mocks.hasWorkflow.mockReturnValue(found)
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'my-flow' })).exists).toBe(found)
    expect(mocks.hasWorkflow).toHaveBeenLastCalledWith('my-flow')
  })

  it('slots 取自管线自己的输入 schema（workflowService.agentSlots），按 workflow 名查', () => {
    const declared: PipelineAgentSlot[] = [
      { role: 'intent', required: true, description: '门控段' },
      { role: 'task', required: true },
      { role: 'recheck', required: false }
    ]
    mocks.agentSlots.mockImplementation((name) => (name === 'bot-chat' ? declared : []))
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'bot-chat' })).slots).toEqual(declared)
    expect(mocks.agentSlots).toHaveBeenLastCalledWith('bot-chat')
    // 管线没声明槽位（或根本不存在）→ 空表：哪些槽位存在、哪些必填，管线文件说了算，宿主不补
    expect(resolvePipeline(stubBot({ name: 'a', pipeline: 'my-flow' })).slots).toEqual([])
    expect(mocks.agentSlots).toHaveBeenLastCalledWith('my-flow')
  })

  it('agents 就是 bot 自己填的表：没填就是空表 —— 没有缺省行，也没有 bot:<self> 自指', () => {
    // v2 的缺省表（intent/recheck/notes 走内置件、task 自指 bot:<name>）随「bot 即一份
    // 绑定」一起退场：槽位由 bot md 逐一填写，漏填必填槽位由管线的输入校验在 invoke 时拦下
    expect(resolvePipeline(stubBot({ name: 'scout' })).agents).toEqual({})
    const r = resolvePipeline(stubBot({ name: 'scout', agents: { intent: 'my-intent' } }))
    expect(r.agents).toEqual({ intent: 'my-intent' })
    expect(JSON.stringify(r)).not.toContain('bot:')
  })

  it('overrides 逐键覆盖，其余键原样保留，且不写回 bot 的解析产物', () => {
    const bot = stubBot({ name: 'scout', agents: { intent: 'my-intent', task: 'coding' } })
    expect(resolvePipeline(bot, { intent: BUILTIN_GATE_AGENT }).agents).toEqual({
      intent: BUILTIN_GATE_AGENT,
      task: 'coding'
    })
    // 覆盖只存在于这一次解析里：bot.agents 是设置页读数条要显示的「你配置了什么」
    expect(bot.agents).toEqual({ intent: 'my-intent', task: 'coding' })
    // 不传 overrides 与传空表等价
    expect(resolvePipeline(bot, {}).agents).toEqual(resolvePipeline(bot).agents)
  })

  it('overrides 可以补 bot 没填的键（回落给一个空的 intent 槽位塞内置件同样成立）', () => {
    expect(resolvePipeline(stubBot({ name: 'a' }), { intent: BUILTIN_GATE_AGENT }).agents).toEqual({
      intent: BUILTIN_GATE_AGENT
    })
  })

  it('未知槽位键透传（槽位表是开放的，宿主不按管线声明过滤）', () => {
    const r = resolvePipeline(stubBot({ name: 'scout', agents: { verify: 'explore' } }))
    expect(r.agents).toEqual({ verify: 'explore' })
  })

  it('载荷形状封口：恰 workflow / exists / slots / agents 四键', () => {
    expect(Object.keys(resolvePipeline(stubBot({ name: 'a' }))).sort()).toEqual([
      'agents',
      'exists',
      'slots',
      'workflow'
    ])
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

  it.each([
    ['只有 body', { body: '第一句\n\n余下' }, '第一句\n\n余下'],
    ['只有 points', { points: ['要点一', '要点二'] }, '要点一\n\n- 要点二'],
    ['headline 是纯空白但别处有内容', { headline: '  ', body: '完整分析' }, '完整分析']
  ])('缺结论时从已有内容里提一句当结论：%s', (_n, raw, expected) => {
    // headline 确实是必填项，但「有形状、缺一句结论」离「没有回复」差得很远 —— 严格作废
    // 会让 say 抛在脚本的 try 之外，用户拿到的是一句内部错误串，而那串还会成为模型可见的
    // 会话历史。管线脚本在散文降级处的立场（「无形状的回复胜过没有回复」）在这里同样成立
    expect(asSayContent(raw)).toBe(expected)
  })

  it('一个可用字段都没有时才真的拒绝', () => {
    expect(() => asSayContent({ status: 'ok' })).toThrow(/non-empty string or carry a headline/)
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

  /**
   * **全键**：落树的 content 是模型可见的唯一权威（重开、滚动压缩、标题、复制、TTS 读的
   * 都是它）。任务段交回来的 BotReply 漏投一个字段，就等于那条信息对模型不存在，而 UI 上
   * 它明明还在 —— 用户看得见一张表，模型下一轮却当它没说过。
   *
   * 投影本身的逐格用例在 `chat-protocol/src/botReply.test.ts`；这里钉的是**这条接线确实
   * 走了那个投影**，而不是某处又手写了一份只认 headline/body 的简化版。
   */
  describe('全键投影 —— content 是模型可见的唯一权威', () => {
    const FULL = {
      headline: '扫描完成，三处待修',
      body: '改动集中在鉴权中间件。',
      points: ['auth.ts:42 少了空值判断', 'router 的顺序变了'],
      table: { columns: ['接口', '状态'], rows: [['/login', '待修']] },
      status: 'warn' as const,
      followups: ['要我直接改吗？']
    }

    it.each([
      ['headline', '扫描完成，三处待修'],
      ['body', '改动集中在鉴权中间件。'],
      ['points', '- auth.ts:42 少了空值判断'],
      ['table', '| 接口 | 状态 |'],
      ['status', 'Status: warn'],
      ['followups', '- 要我直接改吗？']
    ])('SC 全键样本里 %s 在 content 中留下痕迹', (_key, trace) => {
      expect(asSayContent(FULL)).toContain(trace)
    })

    it('SC 段序与投影一致：结论最先，机器标签 Status 在正文之后', () => {
      const md = asSayContent(FULL)
      expect(md.indexOf(FULL.headline)).toBe(0)
      expect(md.indexOf(FULL.body)).toBeLessThan(md.indexOf('Status: warn'))
    })

    it('SC 未知键被丢掉 —— 侧车与 content 同源，多出的字段两边都不该有', () => {
      const md = asSayContent({ ...FULL, secretHint: '不该出现在 content 里' })
      expect(md).not.toContain('不该出现在 content 里')
    })

    it('SC 表格按列数对齐（短补空、长截断）—— 与 markdown 投影同口径', () => {
      const md = asSayContent({
        headline: 'H',
        table: { columns: ['A', 'B'], rows: [['1'], ['1', '2', '3']] }
      })
      expect(md).toContain('| 1 |  |')
      expect(md).toContain('| 1 | 2 |')
      expect(md).not.toContain('| 3 |')
    })

    it('SC 空数组 / 空表整段消失，不留一个只有标题的小节', () => {
      expect(
        asSayContent({
          headline: 'H',
          points: [],
          followups: [],
          table: { columns: ['A'], rows: [] }
        })
      ).toBe('H')
    })
  })
})

// ────────────────────────── GV：门控裁定 ──────────────────────────

/**
 * `gateVerdictOf(result, intent)` —— 门控健康计数的唯一信道。脚本不再自报 gate，宿主从引擎
 * 交回的 errorCode / errorStep 上推。判据是**第 0 步 + intent 槽位那个 agent + 契约故障**
 * 三者同时成立；差一条都是 null（既不递增也不清零）—— 这张表的每一格都对应一种会把用户的
 * 自定义管线误打成回落态、或把同名 agent 的任务段故障记到门控头上的漏判。
 */
describe('GV —— gateVerdictOf：从 invoke 结果推门控裁定', () => {
  const INTENT = 'my-intent'
  /** 起跑了但失败了：code 可缺（脚本自己抛），step 缺省落在第 0 步、intent 的 agent 上；null = 没有出错的步 */
  const failedAt = (
    code: string | undefined,
    step: WorkflowErrorStep | null = { index: 0, agent: INTENT }
  ): WorkflowInvokeResult => ({
    started: true,
    ok: false,
    error: 'x',
    ...(code ? { errorCode: code } : {}),
    ...(step ? { errorStep: step } : {})
  })

  it.each([
    ['无 ok', { started: false, reason: 'skipped' }],
    ['ok:true', { started: false, ok: true }],
    ['ok:false', { started: false, ok: false, reason: 'error' }]
  ])('GV-1 started:false（%s）→ null：没起跑就没有门控这回事', (_n, result) => {
    expect(gateVerdictOf(result as WorkflowInvokeResult, INTENT)).toBeNull()
  })

  it.each([[INTENT], [undefined], ['']])(
    "GV-2 ok:true → 'ok'（intent=%s 也一样：脚本正常收尾必然过了门控）",
    (intent) => {
      expect(gateVerdictOf({ started: true, ok: true, output: {} }, intent)).toBe('ok')
    }
  )

  it.each([
    ['step_timeout', 'timeout'],
    ['next_not_called', 'broken']
  ])("GV-3 第 0 步 + intent 的 agent + %s → '%s'", (code, verdict) => {
    expect(gateVerdictOf(failedAt(code), INTENT)).toBe(verdict)
  })

  it.each([
    ['unknown_agent'],
    ['step_aborted'],
    ['run_timeout'],
    ['run_aborted'],
    ['mailbox_timeout'],
    [undefined]
  ])('GV-4 同位同人但 code=%s → null（配置错 / 被中止 / run 级收尾都不是契约故障）', (code) => {
    expect(gateVerdictOf(failedAt(code), INTENT)).toBeNull()
  })

  it.each([['step_timeout'], ['next_not_called']])(
    'GV-5 第 1 步 + intent 的 agent + %s → null（intent 与 task 同名时的任务段失败）',
    (code) => {
      expect(gateVerdictOf(failedAt(code, { index: 1, agent: INTENT }), INTENT)).toBeNull()
    }
  )

  it.each([
    [
      '第 0 步但跑的是别的 agent',
      failedAt('next_not_called', { index: 0, agent: 'coding' }),
      INTENT
    ],
    ['intent 未知（自定义管线）', failedAt('next_not_called'), undefined],
    ['intent 为空串', failedAt('next_not_called'), ''],
    ['errorStep 缺失', failedAt('next_not_called', null), INTENT]
  ])('GV-6 %s → null', (_n, result, intent) => {
    expect(gateVerdictOf(result, intent)).toBeNull()
  })
})

// ────────────────────────── FC：失败文案 ──────────────────────────

/**
 * `failureCopy(result, intent, name)` —— 失败气泡选哪一句。这些句子是宿主的通告不是人设
 * 文案，住在 i18n；这里断言的是 (key, params) 与返回值（`t` 是 spy，回传 key）。
 * **配置错优先于门控归因**（unknown_agent 不管坏在哪一步都是 stepNoAgent），其余按
 * 「门控段 / 任务段 × 超时 / 破损」四格分，run 级墙钟并到任务段超时，认不出的落 runFailed。
 */
describe('FC —— failureCopy：按 errorCode / errorStep 选句', () => {
  const NAME = 'Scout'
  const INTENT = 'my-intent'
  const GATE_STEP: WorkflowErrorStep = { index: 0, agent: INTENT }
  const failed = (code?: string, step?: WorkflowErrorStep): WorkflowInvokeResult => ({
    started: true,
    ok: false,
    error: 'x',
    ...(code ? { errorCode: code } : {}),
    ...(step ? { errorStep: step } : {})
  })

  beforeEach(() => {
    // DP 的 reset 在它自己的 describe 里；这里的 spy 要从零数
    mocks.t.mockReset()
    mocks.t.mockImplementation((key: string) => key)
  })

  it.each([
    ['任务槽（第 1 步）', { index: 1, agent: 'ghost' }],
    ['门控槽（第 0 步、intent 的 agent）', GATE_STEP],
    ['更靠后的步', { index: 3, agent: 'ghost' }]
  ])(
    'FC-1 unknown_agent + step（%s）→ bot.stepNoAgent，参数带槽位里那个名字 —— 配置错优先于门控归因',
    (_n, step) => {
      expect(failureCopy(failed('unknown_agent', step), INTENT, NAME)).toBe('bot.stepNoAgent')
      expect(mocks.t).toHaveBeenCalledTimes(1)
      expect(mocks.t).toHaveBeenCalledWith('bot.stepNoAgent', { name: NAME, agent: step.agent })
    }
  )

  it('FC-2 【钉现状】unknown_agent 没带 step → 通用的 bot.runFailed（没有名字可报）', () => {
    expect(failureCopy(failed('unknown_agent'), INTENT, NAME)).toBe('bot.runFailed')
    expect(mocks.t).toHaveBeenCalledWith('bot.runFailed', { name: NAME })
  })

  it.each([
    ['门控段', GATE_STEP, INTENT, 'bot.gateTimeout'],
    [
      '第 1 步 + intent 的 agent（同名 agent 的任务段）',
      { index: 1, agent: INTENT },
      INTENT,
      'bot.taskTimeout'
    ],
    ['第 0 步 + 别的 agent', { index: 0, agent: 'coding' }, INTENT, 'bot.taskTimeout'],
    ['intent 未知（自定义管线）', GATE_STEP, undefined, 'bot.taskTimeout']
  ])('FC-3 step_timeout（%s）→ %s', (_n, step, intent, key) => {
    expect(failureCopy(failed('step_timeout', step), intent, NAME)).toBe(key)
    expect(mocks.t).toHaveBeenCalledWith(key, { name: NAME })
  })

  it.each([
    ['门控段', GATE_STEP, INTENT, 'bot.gateBroken'],
    [
      '第 1 步 + intent 的 agent（同名 agent 的任务段）',
      { index: 1, agent: INTENT },
      INTENT,
      'bot.taskFailed'
    ],
    ['第 0 步 + 别的 agent', { index: 0, agent: 'coding' }, INTENT, 'bot.taskFailed'],
    ['intent 未知（自定义管线）', GATE_STEP, undefined, 'bot.taskFailed']
  ])('FC-4 next_not_called（%s）→ %s', (_n, step, intent, key) => {
    expect(failureCopy(failed('next_not_called', step), intent, NAME)).toBe(key)
    expect(mocks.t).toHaveBeenCalledWith(key, { name: NAME })
  })

  it.each([
    ['无 step', undefined],
    ['带门控段的 step', GATE_STEP]
  ])(
    'FC-5 run_timeout（%s）→ bot.taskTimeout：整条管线做满了时长，对用户与任务段超时是同一件事',
    (_n, step) => {
      expect(failureCopy(failed('run_timeout', step), INTENT, NAME)).toBe('bot.taskTimeout')
      expect(mocks.t).toHaveBeenCalledWith('bot.taskTimeout', { name: NAME })
      expect(mocks.t).not.toHaveBeenCalledWith('bot.gateTimeout', expect.anything())
    }
  )

  it.each([
    ['run_aborted', failed('run_aborted')],
    ['step_aborted（门控段）', failed('step_aborted', GATE_STEP)],
    ['mailbox_timeout', failed('mailbox_timeout')],
    ['无 code（脚本自己抛）', failed(undefined, { index: 1, agent: 'coding' })],
    ['started:false', { started: false, reason: 'error' } as WorkflowInvokeResult]
  ])('FC-6 %s → bot.runFailed，参数恒为 {name}', (_n, result) => {
    expect(failureCopy(result, INTENT, NAME)).toBe('bot.runFailed')
    expect(mocks.t).toHaveBeenCalledTimes(1)
    expect(mocks.t).toHaveBeenCalledWith('bot.runFailed', { name: NAME })
  })

  it('FC-7 非 stepNoAgent 的句子参数只含 name，不夹带 agent', () => {
    failureCopy(failed('step_timeout', GATE_STEP), INTENT, NAME)
    failureCopy(failed('next_not_called', GATE_STEP), INTENT, NAME)
    failureCopy(failed('step_timeout', { index: 1, agent: 'coding' }), INTENT, NAME)
    failureCopy(failed('next_not_called', { index: 1, agent: 'coding' }), INTENT, NAME)
    failureCopy(failed('run_timeout'), INTENT, NAME)
    failureCopy(failed('run_aborted'), INTENT, NAME)

    expect(mocks.t).toHaveBeenCalledWith('bot.gateTimeout', { name: 'Scout' })
    expect(mocks.t.mock.calls.map((c) => c[0])).toEqual([
      'bot.gateTimeout',
      'bot.gateBroken',
      'bot.taskTimeout',
      'bot.taskFailed',
      'bot.taskTimeout',
      'bot.runFailed'
    ])
    // toEqual 是全等：多一个 agent 键就红
    for (const call of mocks.t.mock.calls) expect(call[1]).toEqual({ name: 'Scout' })
  })
})

// ────────────────────────── DP：一次 invoke 的票面 ──────────────────────────

/**
 * 派发那一刻宿主替 bot 打包了什么。三处写的必须是同一个路径：`input.bot.file`（脚本 /
 * 提示词里说「文件在这」）、围栏的 `file` 属性（agent 就往这里写）、`recordRead` 记的那条
 * （edit 工具据此放行「没 read 过就 edit」）—— 所以这一组打真 fs，不 stub bot 表。
 */
describe('DP —— 一次 invoke 带了什么', () => {
  /** 每条用例一条新会话（botService 是模块级单例，按会话 id 记着在飞计数与消息序） */
  let SID = ''
  let seq = 0
  const BODY = 'BOT BODY.\n\n## 记忆\n- 偏好 pnpm'

  /** 一份 bot md 落到真目录里，返回它的路径 */
  function writeBot(
    name: string,
    opts: {
      displayName?: string
      /** `shuvix-bot-pipeline.workflow` —— 必填；缺省内置 bot-chat（模板的缺省，解析器没有缺省） */
      pipeline?: string
      agents?: Record<string, string>
      input?: Record<string, unknown>
      body?: string
    } = {}
  ): string {
    mkdirSync(dirs.bots, { recursive: true })
    const lines = ['---', 'shuvix: bot v1', `name: ${name}`, `description: unit bot ${name}`]
    if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
    // 管线绑定是一个嵌套块：workflow 必填，agents / input 是它的从属项
    lines.push('shuvix-bot-pipeline:', `  workflow: ${opts.pipeline ?? 'bot-chat'}`)
    if (opts.agents) {
      lines.push('  agents:')
      for (const [k, v] of Object.entries(opts.agents)) lines.push(`    ${k}: ${v}`)
    }
    if (opts.input) {
      lines.push('  input:')
      for (const [k, v] of Object.entries(opts.input)) lines.push(`    ${k}: ${JSON.stringify(v)}`)
    }
    lines.push('---', '', opts.body ?? BODY)
    const file = join(dirs.bots, `${name}.md`)
    writeFileSync(file, lines.join('\n'))
    return file
  }

  const seedSession = (bots: string[]): void => {
    mocks.getById.mockReturnValue({
      workingDirectory: dirs.sessions,
      title: 'Some title',
      settings: { bots }
    })
  }

  /** 一次管线 invoke 的结果 —— 缺省「跑完了，门控正常」 */
  const ran = (
    output: Record<string, unknown> = { outcome: 'reply' }
  ): Record<string, unknown> => ({ started: true, ok: true, output })

  /** 门控段契约故障的 invoke 结果：errorCode + 第 0 步、intent 槽位的 agent（宿主据此记门控健康） */
  const gateFailed =
    (code: 'next_not_called' | 'step_timeout' = 'next_not_called') =>
    async (req: unknown): Promise<Record<string, unknown>> => ({
      started: true,
      ok: false,
      error: `${code} at gate`,
      errorCode: code,
      errorStep: {
        index: 0,
        agent: (req as { input: { agents: { intent: string } } }).input.agents.intent
      }
    })

  /**
   * 一次失败的 invoke 结果 —— 引擎交回的机器可读归类：`errorCode` + 出错的那一步。
   * 失败文案（failureCopy）与门控健康（gateVerdictOf）都从这两个字段推，脚本不再自报。
   */
  const failed = (
    code: string,
    step?: { index: number; agent: string }
  ): Record<string, unknown> => ({
    started: true,
    ok: false,
    error: `${code} at ${step?.agent ?? '?'}`,
    errorCode: code,
    ...(step ? { errorStep: step } : {})
  })

  const prompt = (text = 'hello', over: Record<string, unknown> = {}): Promise<void> =>
    botService.handleUserMessage({ sessionId: SID, text, ...over } as never)

  interface InvokeRequest {
    workflow: string
    sessionId: string
    input: Record<string, unknown> & {
      bot: { name: string }
      agents: Record<string, string>
      session: Record<string, unknown>
      message: Record<string, unknown>
      window: string[]
    }
    systemContext?: readonly string[]
    extraApi: { say: (raw: unknown, opts?: unknown) => Promise<{ messageId: string | null }> }
  }
  /** 第 i 次 invoke 的请求 */
  const request = (i = 0): InvokeRequest => mocks.invoke.mock.calls[i][0] as InvokeRequest
  /** 会话里的 bot 行（按 seq） */
  const botRows = (): ReturnType<typeof chatMessageDao.findBySession> =>
    chatMessageDao.findBySession(SID).filter((r) => r.authorKind === 'bot')
  const userRow = (): ReturnType<typeof chatMessageDao.findBySession>[number] => {
    const row = chatMessageDao.findBySession(SID).find((r) => r.authorKind === 'user')
    if (!row) throw new Error('no user message')
    return row
  }

  /** 某个 bot 的决策记录 kind 序列 */
  function kindsOf(botName: string): string[] {
    const file = join(dirs.bots, '.runs', botName, 'decisions.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => String((JSON.parse(l) as Record<string, unknown>).kind))
  }

  /** 最后一条 bot_activity 广播 —— 这个成员这一轮怎么收的 */
  const lastActivity = (): Record<string, unknown> => {
    const list = mocks.broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'bot_activity')
    return list[list.length - 1]
  }

  /** 某条 bot 行广播出去的投影产物（assistant_message）—— 失败卡的数据位 metadata.botFailure 在这上面 */
  const projected = (messageId: string): ChatMessage => {
    const evt = mocks.broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === 'assistant_message' && e.messageId === messageId)
    if (!evt) throw new Error(`no assistant_message broadcast for ${messageId}`)
    return JSON.parse(evt.message as string) as ChatMessage
  }

  beforeEach(() => {
    seq += 1
    SID = `pipe-sess-${seq}`
    rmSync(dirs.base, { recursive: true, force: true })
    mkdirSync(dirs.sessions, { recursive: true })
    mkdirSync(dirs.bots, { recursive: true })
    resetRows()
    for (const m of [mocks.invoke, mocks.getById, mocks.recordRead, mocks.broadcast, mocks.t]) {
      m.mockReset()
    }
    mocks.t.mockImplementation((key: string) => key)
    mocks.invoke.mockResolvedValue(ran())
    mocks.hasWorkflow.mockReturnValue(true)
  })

  afterAll(() => {
    rmSync(dirs.base, { recursive: true, force: true })
  })

  it('DP-1 input 恰 bot / agents / session / window / message 五键 —— 没有 occasion，也没有 notes', async () => {
    const file = writeBot('scout', {
      displayName: 'Scout',
      agents: { intent: 'bot-intent', task: 'default' }
    })
    seedSession(['scout'])
    await prompt('第一句')

    const req = request()
    // 派发的 workflow 就是 md 里 shuvix-bot-pipeline.workflow 那一行（writeBot 缺省写内置 bot-chat）
    expect(req.workflow).toBe('bot-chat')
    expect(req.sessionId).toBe(SID)
    expect(Object.keys(req.input).sort()).toEqual(['agents', 'bot', 'message', 'session', 'window'])
    expect(req.input.bot).toEqual({
      name: 'scout',
      displayName: 'Scout',
      description: 'unit bot scout',
      file
    })
    // 槽位表原样：宿主不补缺省行
    expect(req.input.agents).toEqual({ intent: 'bot-intent', task: 'default' })
    expect(req.input.session).toEqual({ id: SID, directed: false, members: ['scout'], others: [] })
    // 窗口截到本条之前 —— 第一条消息的窗口是空的（它自己在 message.text 里）
    expect(req.input.window).toEqual([])
    const user = userRow()
    expect(req.input.message).toEqual({ id: user.id, seq: user.seq, text: '第一句' })
  })

  it('DP-1b 派发的 workflow 原样取自 md 的 shuvix-bot-pipeline.workflow —— 没有回落到 bot-chat', async () => {
    // 宿主这一层不再有缺省管线：md 说 my-flow 就派 my-flow（在不在注册表是 not-found 那条路的事）
    writeBot('scout', { pipeline: 'my-flow', agents: { intent: 'bot-intent', task: 'default' } })
    seedSession(['scout'])
    await prompt()
    expect(request().workflow).toBe('my-flow')
  })

  it('DP-2 window 是已成型的「谁: 说了什么」字符串行，截到本条之前', async () => {
    writeBot('scout', { displayName: 'Scout' })
    seedSession(['scout'])
    mocks.invoke.mockImplementationOnce(async (req: InvokeRequest) => {
      await req.extraApi.say('收到')
      return ran()
    })
    await prompt('第一句')
    await prompt('第二句')

    // 发言人标签是固定的 User / bot 的 displayName —— 数据标注不是文案，刻意不本地化
    expect(request(1).input.window).toEqual(['User: 第一句', 'Scout: 收到'])
    expect(request(1).input.message).toMatchObject({ text: '第二句' })
  })

  it('DP-3 session.others 是其它成员的身份行「显示名: 描述」（与 window 同为已成型的行），不含自己', async () => {
    writeBot('scout', { displayName: 'Scout' })
    writeBot('ranger', { displayName: 'Ranger' })
    seedSession(['scout', 'ranger'])
    await prompt()

    const inputs = new Map(
      mocks.invoke.mock.calls.map((c) => {
        const r = c[0] as InvokeRequest
        return [r.input.bot.name, r.input]
      })
    )
    expect(inputs.get('scout')?.session).toEqual({
      id: SID,
      directed: false,
      members: ['scout', 'ranger'],
      others: ['Ranger: unit bot ranger']
    })
    expect(inputs.get('ranger')?.session).toMatchObject({
      others: ['Scout: unit bot scout']
    })
  })

  it('DP-4 shuvix-bot-pipeline.input 铺在最前，宿主键压过它 —— 一份 bot md 改写不了 session.id 这类事实', async () => {
    writeBot('scout', { input: { foo: 1, session: 'hijack' } })
    seedSession(['scout'])
    await prompt()

    const input = request().input
    expect(input.foo).toBe(1)
    expect(input.session).toMatchObject({ id: SID })
  })

  it('DP-5 systemContext 恰一块：renderBotContext 围栏后的正文（name / displayName / 文件路径 / 正文）', async () => {
    const file = writeBot('scout', { displayName: 'Scout' })
    seedSession(['scout'])
    await prompt()

    expect(request().systemContext).toEqual([
      renderBotContext({ name: 'scout', displayName: 'Scout', file, body: BODY })
    ])
    // 正文不走 input：它只在每个参与 agent 的系统提示词末尾，提示词模板里没有它
    expect(JSON.stringify(request().input)).not.toContain('偏好 pnpm')
  })

  it('DP-6 正文为空也照样围栏 —— agent 得知道文件在哪，才能开始往里写', async () => {
    const file = writeBot('scout', { body: '' })
    seedSession(['scout'])
    await prompt()

    const [block, ...rest] = request().systemContext ?? []
    expect(rest).toEqual([])
    expect(block).toBe(renderBotContext({ name: 'scout', displayName: 'scout', file, body: '' }))
    expect(block).toContain(`<bot_profile name="scout" file="${file}">`)
  })

  it('DP-7 派发前替这条会话记一笔「已读」：recordRead(sessionId, bot 文件) 先于 invoke', async () => {
    // 正文已经在每个参与 agent 的系统提示词里了 —— 对文件工具而言这就是「读过」，任务段
    // 直接 edit 自己的 md 不必先 read（派生 agent 的 fileTime 归根会话，即这条聊天会话）
    const file = writeBot('scout')
    seedSession(['scout'])
    const order: string[] = []
    mocks.recordRead.mockImplementation(() => {
      order.push('recordRead')
    })
    mocks.invoke.mockImplementation(async () => {
      order.push('invoke')
      return ran()
    })
    await prompt()

    expect(mocks.recordRead).toHaveBeenCalledTimes(1)
    expect(mocks.recordRead).toHaveBeenCalledWith(SID, file)
    expect(order).toEqual(['recordRead', 'invoke'])
  })

  it('DP-8 每个成员各记自己的文件（不是替整个 cohort 记一次）', async () => {
    const scout = writeBot('scout')
    const ranger = writeBot('ranger')
    seedSession(['scout', 'ranger'])
    await prompt()

    expect(mocks.recordRead.mock.calls.map((c) => c[1]).sort()).toEqual([ranger, scout].sort())
    expect(mocks.recordRead.mock.calls.every((c) => c[0] === SID)).toBe(true)
  })

  it('DP-9 message.attachments 只带句柄不带字节（input 会原样进 run journal）', async () => {
    writeBot('scout')
    seedSession(['scout'])
    const data = Buffer.from('BYTES-dp9').toString('base64')
    await prompt('看图', { images: [{ data, mimeType: 'image/png' }] })

    const message = request().input.message as { id: string; attachments?: unknown[] }
    expect(message.attachments).toEqual([
      { sessionId: SID, messageId: message.id, index: 0, mimeType: 'image/png' }
    ])
    expect(JSON.stringify(request().input)).not.toContain(data)
  })

  it('DP-10 started:false + invalid-input → 一条可见的错误气泡，文案是管线的原话；不再补通用的 runFailed', async () => {
    // 入参被管线拒绝几乎总是槽位没填全（agents.task 之类）—— 这是配置错，不是「跑到一半
    // 坏了」：把管线的原话说出来，用户才知道该去改 md 的哪一行。它已经往会话里放了东西
    //（said），所以「可见结局」兜底不再补第二条通用气泡
    writeBot('scout', { displayName: 'Scout', agents: { intent: 'bot-intent' } })
    seedSession(['scout'])
    const error = 'input is missing required field(s): agents.task'
    mocks.invoke.mockResolvedValue({ started: false, reason: 'invalid-input', error })
    await prompt('谁来')

    const rows = botRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      botName: 'scout',
      displayName: 'Scout',
      isError: true,
      content: 'bot.pipelineInvalidInput',
      replyToId: userRow().id
    })
    expect(mocks.t).toHaveBeenCalledWith('bot.pipelineInvalidInput', { name: 'Scout', error })
    expect(mocks.t).not.toHaveBeenCalledWith('bot.runFailed', expect.anything())
    expect(kindsOf('scout')).toContain('pipeline_invalid_input')
    expect(kindsOf('scout')).not.toContain('pipeline_error')
    expect(lastActivity()).toMatchObject({ phase: 'ended', outcome: 'invalid-input' })
  })

  it('DP-11 invalid-input 没带 error 串 → 文案参数回落 "invalid input"，气泡照出', async () => {
    writeBot('scout', { displayName: 'Scout' })
    seedSession(['scout'])
    mocks.invoke.mockResolvedValue({ started: false, reason: 'invalid-input' })
    await prompt()

    expect(botRows().map((r) => r.content)).toEqual(['bot.pipelineInvalidInput'])
    expect(mocks.t).toHaveBeenCalledWith('bot.pipelineInvalidInput', {
      name: 'Scout',
      error: 'invalid input'
    })
  })

  it.each([['not-found'], ['skipped'], ['superseded'], ['error']])(
    'DP-12 started:false + %s → 通用的 runFailed 兜底气泡，不是 invalid-input 那条',
    async (reason) => {
      writeBot('scout', { displayName: 'Scout' })
      seedSession(['scout'])
      mocks.invoke.mockResolvedValue({ started: false, reason, error: 'whatever' })
      await prompt()

      const rows = botRows()
      expect(rows.map((r) => r.content)).toEqual(['bot.runFailed'])
      expect(rows[0].isError).toBe(true)
      expect(mocks.t).toHaveBeenCalledWith('bot.runFailed', { name: 'Scout' })
      expect(mocks.t).not.toHaveBeenCalledWith('bot.pipelineInvalidInput', expect.anything())
      expect(kindsOf('scout')).toContain('pipeline_error')
      expect(kindsOf('scout')).not.toContain('pipeline_invalid_input')
      expect(lastActivity()).toMatchObject({ phase: 'ended', outcome: reason })
    }
  )

  it('DP-13 门控连续故障回落之后：只有 intent 换成内置件，其余槽位仍是 bot 自己填的', async () => {
    // 回落覆盖走的是 resolvePipeline 的 overrides。用一个本文件独占的 bot 名：健康度是
    // 进程级 sticky 的，没有复位入口也不该有
    writeBot('dp-degrade', {
      displayName: 'Degrade',
      agents: { intent: 'my-intent', task: 'coding', recheck: 'my-intent' }
    })
    seedSession(['dp-degrade'])
    mocks.invoke.mockImplementation(gateFailed())
    await prompt('一')
    await prompt('二')
    await prompt('三')

    expect(request(0).input.agents).toEqual({
      intent: 'my-intent',
      task: 'coding',
      recheck: 'my-intent'
    })
    expect(request(2).input.agents).toEqual({
      intent: BUILTIN_GATE_AGENT,
      task: 'coding',
      recheck: 'my-intent'
    })
  })

  /**
   * 可见结局（设计 §9）：脚本不为失败出声，宿主按引擎交回的 errorCode / errorStep 替它说。
   * 每格一个 bot 名 —— 门控健康是进程级 sticky 的，同名 bot 攒两次门控故障就会回落并多出
   * 一条提示，「恰一条气泡」就不成立了。
   */
  it.each([
    ['门控破损', 'next_not_called', { index: 0, agent: 'my-intent' }, 'bot.gateBroken'],
    ['门控超时', 'step_timeout', { index: 0, agent: 'my-intent' }, 'bot.gateTimeout'],
    ['任务段超时', 'step_timeout', { index: 1, agent: 'coding' }, 'bot.taskTimeout'],
    ['任务段破损', 'next_not_called', { index: 1, agent: 'coding' }, 'bot.taskFailed'],
    ['run 级墙钟到点', 'run_timeout', undefined, 'bot.taskTimeout']
  ])(
    'DP-14 %s → 恰一条失败气泡 %s（isError / botFailure，回复用户那行），不再补 runFailed',
    async (_n, code, step, key) => {
      const name = `dp14-${key.slice('bot.'.length).toLowerCase()}-${step?.index ?? 'run'}`
      writeBot(name, { displayName: 'Scout', agents: { intent: 'my-intent', task: 'coding' } })
      seedSession([name])
      mocks.invoke.mockResolvedValue(failed(code, step))
      await prompt('这条会失败')

      const rows = botRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        botName: name,
        displayName: 'Scout',
        isError: true,
        content: key,
        replyToId: userRow().id
      })
      // 失败卡的数据位：投影产物上 metadata.botFailure === true
      expect(projected(rows[0].id).metadata).toMatchObject({ botFailure: true })
      expect(mocks.t).toHaveBeenCalledWith(key, { name: 'Scout' })
      expect(mocks.t).not.toHaveBeenCalledWith('bot.runFailed', expect.anything())
      expect(lastActivity()).toMatchObject({ phase: 'ended', outcome: 'failed' })
    }
  )

  it.each([
    ['任务槽', { intent: 'my-intent', task: 'ghost' }, { index: 1, agent: 'ghost' }],
    [
      '门控槽（第 0 步、intent 的 agent）',
      { intent: 'ghost', task: 'coding' },
      { index: 0, agent: 'ghost' }
    ]
  ])(
    'DP-15 unknown_agent 在%s → bot.stepNoAgent 带槽位里那个名字，不是 gateBroken（配置错优先于门控归因）',
    async (_n, agents, step) => {
      const name = `dp15-${step.index}`
      writeBot(name, { displayName: 'Scout', agents })
      seedSession([name])
      mocks.invoke.mockResolvedValue(failed('unknown_agent', step))
      await prompt('这个 agent 不存在')

      expect(botRows().map((r) => r.content)).toEqual(['bot.stepNoAgent'])
      expect(botRows()[0].isError).toBe(true)
      expect(mocks.t).toHaveBeenCalledWith('bot.stepNoAgent', { name: 'Scout', agent: 'ghost' })
      expect(mocks.t).not.toHaveBeenCalledWith('bot.gateBroken', expect.anything())
      // 配置错不是契约故障：门控健康不记账
      expect(kindsOf(name)).not.toContain('gate_broken')
      expect(kindsOf(name)).toContain('run_end')
    }
  )

  it('DP-16 intent 与 task 同名：第 1 步超时 → taskTimeout，第 0 步超时 → gateTimeout（文案按步号分，不按名字）', async () => {
    writeBot('dp16-same', { displayName: 'Scout', agents: { intent: 'same', task: 'same' } })
    seedSession(['dp16-same'])
    mocks.invoke.mockResolvedValueOnce(failed('step_timeout', { index: 1, agent: 'same' }))
    await prompt('一')
    mocks.invoke.mockResolvedValueOnce(failed('step_timeout', { index: 0, agent: 'same' }))
    await prompt('二')

    expect(botRows().map((r) => r.content)).toEqual(['bot.taskTimeout', 'bot.gateTimeout'])
    expect(mocks.t).toHaveBeenCalledWith('bot.taskTimeout', { name: 'Scout' })
    expect(mocks.t).toHaveBeenCalledWith('bot.gateTimeout', { name: 'Scout' })
  })

  it('DP-17 run_aborted 但不是用户按的停止（没调 abortBot）→ runFailed 气泡照出', async () => {
    // 守卫看的是这张票的 signal，不是 errorCode：引擎报 run_aborted 而这边没人按停
    //（外部 signal 从别处落下）仍是「无从解释的沉默」，要出声。对照 A2-B9b（用户中止零气泡）
    writeBot('scout', { displayName: 'Scout', agents: { intent: 'my-intent', task: 'coding' } })
    seedSession(['scout'])
    mocks.invoke.mockResolvedValue(failed('run_aborted'))
    await prompt('没人按停')

    const rows = botRows()
    expect(rows.map((r) => r.content)).toEqual(['bot.runFailed'])
    expect(rows[0]).toMatchObject({ isError: true, replyToId: userRow().id })
    expect(mocks.t).toHaveBeenCalledWith('bot.runFailed', { name: 'Scout' })
    expect(lastActivity()).toMatchObject({ phase: 'ended', outcome: 'failed' })
  })

  it('DP-18 脚本已经 say 过再失败 → 不补失败气泡，会话里只有它说的那句（said 守卫）', async () => {
    // 它已经往会话里放了东西 —— 再补一条「没办成」只会让用户看到一句回答加一句道歉
    writeBot('scout', { displayName: 'Scout', agents: { intent: 'my-intent', task: 'coding' } })
    seedSession(['scout'])
    mocks.invoke.mockImplementationOnce(async (req: InvokeRequest) => {
      await req.extraApi.say('先说一句')
      return failed('next_not_called', { index: 1, agent: 'coding' })
    })
    await prompt('说完再坏')

    const rows = botRows()
    expect(rows.map((r) => r.content)).toEqual(['先说一句'])
    expect(rows[0].isError).toBeFalsy()
    expect(mocks.t).not.toHaveBeenCalled()
    // 账照记：这一轮的结局仍是 failed
    expect(kindsOf('scout')).toContain('run_end')
    expect(lastActivity()).toMatchObject({ phase: 'ended', outcome: 'failed' })
  })

  it('DP-19 三成员：others 两行按 members 顺序；名单里 md 缺失的成员被跳过，不留「undefined: undefined」', async () => {
    writeBot('scout', { displayName: 'Scout' })
    writeBot('ranger', { displayName: 'Ranger' })
    writeBot('hunter', { displayName: 'Hunter' })
    seedSession(['scout', 'ghost', 'ranger', 'hunter'])
    await prompt()

    const inputs = new Map(
      mocks.invoke.mock.calls.map((c) => {
        const r = c[0] as InvokeRequest
        return [r.input.bot.name, r.input]
      })
    )
    expect([...inputs.keys()]).toEqual(['scout', 'ranger', 'hunter'])
    expect(inputs.get('scout')?.session).toEqual({
      id: SID,
      directed: false,
      members: ['scout', 'ranger', 'hunter'],
      others: ['Ranger: unit bot ranger', 'Hunter: unit bot hunter']
    })
    expect(inputs.get('hunter')?.session).toMatchObject({
      others: ['Scout: unit bot scout', 'Ranger: unit bot ranger']
    })
    for (const input of inputs.values()) {
      expect(JSON.stringify(input.session)).not.toContain('undefined')
    }
  })
})
