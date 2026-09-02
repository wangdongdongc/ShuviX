/**
 * botService 管线半边（M4′）的接线与两个跨 realm 校验器。
 *
 * 这里测的三件事都是**表**，不是流程：管线/角色的回落表（`resolvePipeline`）、
 * say 正文的投影表（`asSayContent`）。仲裁相关的取值表随 v2 去仲裁一并移除。
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
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => `${dirs.base}/data`,
  getChatAttachmentsDir: (sid: string) => `${dirs.base}/data/chat-attachments/${sid}`,
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // botService → agentService 的模块作用域构造器在 import 阶段就要它
  getDefaultAgentsDir: () => `${dirs.base}/agents`
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
// botService 经 settingsService 读两道循环护栏。真件一经导入就把 settingsDao →
// dao/database 拉进模块图，而 DatabaseManager 构造即开 sqlite（原生绑定是 Electron ABI 的）
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))

import { DEFAULT_BOT_PIPELINE } from '@shuvix/agent-runtime'
import { asSayContent, botSelfRef, resolvePipeline } from '../botService'

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
    respondTo: 'user',
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

/**
 * 「这一轮 cohort 一个字都没换来」的定性 —— 又一张**表**，所以摆在这一层而不是 e2e。
 *
 * 它要答的是两个用户能读懂的问题：会话里到底有没有多出东西（第一问），以及这次沉默
 * 是正常的（大家都判定这条不归自己）还是坏掉了（没有一个走到判定）。两者对用户的意味
 * 完全相反 —— 前者不必管，后者要去看日志。端到端能验的是链路，这张表的每一格只能在
 * 这里逐条摆开。
 */
