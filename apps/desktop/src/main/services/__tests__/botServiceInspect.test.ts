/**
 * botService.inspect —— 设置页运行时读数条（A1）的数据源。
 *
 * inspect 回答的是「按现在的注册表状态，这个 bot 跑起来会解析成什么」：管线在不在、
 * 管线声明了哪些槽位、bot 给每个槽位填了谁、填的那个 agent 还在不在、门控是否已 sticky
 * 降级、正文（人设与记忆）有多大。它是**呈现**接口 —— 引用缺失这类事实此前只埋在
 * journal 里（§8.5），读数条是把它们摆上台面的那一步。
 *
 * 与 botServiceTriggers 同一套夹具（vi.hoisted 临时目录 + 真 fs），差别有二：
 *  - **agentService 用真的**：slots 的 missing 判定要穿透「内置 + 用户 md 覆盖」的合并
 *    注册表，mock 它等于把被测逻辑的一半换成断言自己；
 *  - workflowService 的 mock 多补 listForSettings（inspect 读并发模式的那条缝）与
 *    agentSlots（槽位表来自管线自己的输入 schema —— 这里给内置 bot-chat 一份与真件同形的
 *    声明：intent / task 必填，recheck 可选）。
 *
 * 同一套夹具也养着 `botService.advise`（AD 组）：它是属性卡琥珀横幅的数据源，回答的是
 * inspect 的另一面 —— 不是「会解析成什么」而是「跑起来会在哪里可见地失败」。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ParsedBotFile, PipelineAgentSlot } from '@shuvix/agent-runtime'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botinspect-${process.pid}`
  return {
    base,
    sessions: `${base}/sessions`,
    bots: `${base}/bots`,
    agents: `${base}/agents`
  }
})

const mocks = vi.hoisted(() => ({
  fire: vi.fn(),
  invoke: vi.fn(),
  hasWorkflow: vi.fn((_name: string) => true),
  listForSettings: vi.fn(() => [] as Array<Record<string, unknown>>),
  agentSlots: vi.fn(
    (_name: string) => [] as Array<{ role: string; required: boolean; description?: string }>
  ),
  abortSessionRuns: vi.fn(() => 0),
  getById: vi.fn(),
  buildFacts: vi.fn(),
  isDefaultTitle: vi.fn(() => false),
  broadcast: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: mocks.invoke,
    abortSessionRuns: mocks.abortSessionRuns,
    hasWorkflow: mocks.hasWorkflow,
    listForSettings: mocks.listForSettings,
    agentSlots: mocks.agentSlots,
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: mocks.fire }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => join(dirs.base, 'data'),
  getChatAttachmentsDir: (sid: string) => join(dirs.base, 'data', 'chat-attachments', sid),
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // 真 agentService 的模块作用域构造器 + builtinAgents() 的宿主参数都从这里来
  getDefaultAgentsDir: () => dirs.agents,
  getWidgetsDir: () => `${dirs.base}/widgets`,
  getDefaultWikisDir: () => `${dirs.base}/wikis`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: mocks.broadcast } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: mocks.buildFacts,
  isDefaultTitle: mocks.isDefaultTitle
}))
vi.mock('../sessionService', () => ({
  // noteUnreadBotReply：appendBotMessage 每次落库都记未读账（回落提示会走到）—— 给 no-op
  sessionService: { getById: mocks.getById, noteUnreadBotReply: () => {} }
}))

import { botService } from '../botService'
import { clearSessionTreeCacheForTests } from '../sessionStorage'

let SID = 'inspect-sess'
let sidSeq = 0

/** 内置 bot-chat 声明的槽位（与真件 shuvix-workflow-input.properties.agents 同形） */
const BOT_CHAT_SLOTS: PipelineAgentSlot[] = [
  { role: 'intent', required: true, description: 'gate agent' },
  { role: 'task', required: true, description: 'task agent' },
  { role: 'recheck', required: false, description: 'recheck agent' }
]

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
): void {
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
  lines.push('---', '', opts.body ?? 'BOT BODY.')
  writeFileSync(join(dirs.bots, `${name}.md`), lines.join('\n'))
}

/** 真用户 agent md（真 agentService 现扫 dirs.agents —— missing 判定的另一半注册表） */
function writeAgentMd(name: string): void {
  mkdirSync(dirs.agents, { recursive: true })
  writeFileSync(
    join(dirs.agents, `${name}.md`),
    [
      '---',
      'shuvix: agent v1',
      `name: ${name}`,
      `description: unit agent ${name}`,
      '---',
      '',
      'AGENT BODY.'
    ].join('\n')
  )
}

interface InspectSlot {
  role: string
  required: boolean
  description?: string
  ref?: string
  missing: boolean
}

/** inspect 的成功形态（error 形态直接 fail，让失败信息带上原因） */
function ok(name: string): {
  pipeline: { name: string; exists: boolean; concurrency?: string }
  slots: InspectSlot[]
  gateDegraded?: string
  body: { chars: number }
} {
  const r = botService.inspect(name)
  if ('error' in r) throw new Error(`inspect("${name}") unexpectedly failed: ${r.error}`)
  return r
}

/** 某个槽位那一行（没有就 fail，让失败信息带上角色名） */
function slotOf(name: string, role: string): InspectSlot {
  const slot = ok(name).slots.find((s) => s.role === role)
  if (!slot) throw new Error(`inspect("${name}") has no slot "${role}"`)
  return slot
}

const seedSession = (bots: string[]): void => {
  mocks.getById.mockReturnValue({
    workingDirectory: dirs.sessions,
    title: 'Some title',
    settings: { bots }
  })
}

/** 一次管线 invoke 的结果 —— 缺省「跑完了，门控正常」（同 botServiceTriggers 的 ran） */
const ran = (
  output: Record<string, unknown> = { gate: 'ok', outcome: 'reply' }
): { started: boolean; ok: boolean; output: Record<string, unknown> } => ({
  started: true,
  ok: true,
  output
})

const prompt = (text = 'hello'): Promise<void> =>
  botService.handleUserMessage({ sessionId: SID, text } as never)

beforeEach(() => {
  sidSeq += 1
  SID = `inspect-sess-${sidSeq}`
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.hasWorkflow.mockReturnValue(true)
  // 生效并发模式来自「未被遮蔽」的注册表条目 —— 缺省只有内置 bot-chat（parallel）
  mocks.listForSettings.mockReturnValue([{ name: 'bot-chat', concurrency: 'parallel' }])
  // 槽位表由管线文件说了算：只有内置 bot-chat 有声明，别的名字一律空表
  mocks.agentSlots.mockImplementation((name) => (name === 'bot-chat' ? BOT_CHAT_SLOTS : []))
  mocks.abortSessionRuns.mockReturnValue(0)
  mocks.isDefaultTitle.mockReturnValue(false)
  mocks.invoke.mockResolvedValue(ran())
  mocks.buildFacts.mockResolvedValue({
    title: 'Some title',
    isDefaultTitle: false,
    titleAutoGenerated: false,
    turnCount: 1,
    textMessageCount: 2,
    recentText: 'User: hi'
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('botService.inspect', () => {
  it('B1 未知名 → {error}', () => {
    const r = botService.inspect('b1-nobody')
    expect(r).toEqual({ error: 'Bot "b1-nobody" not found' })
  })

  it('B2 存在但非法的文件 → {error}（扫描即跳过，非法文件不产生读数）', () => {
    // description 是 bot md 的必填项 —— 缺它整份被拒，b2-bad 对注册表不存在
    writeFileSync(
      join(dirs.bots, 'b2-bad.md'),
      ['---', 'shuvix: bot v1', 'name: b2-bad', '---', '', 'BODY.'].join('\n')
    )
    const r = botService.inspect('b2-bad')
    expect('error' in r).toBe(true)
  })

  it('B3 最小全景：只写必填的 workflow（内置 bot-chat）+ 管线声明的三个槽位（一个都没填）+ 正文字数，无 gateDegraded 键', () => {
    // 管线没有缺省 —— writeBot 缺省写的是模板管线 bot-chat，读数条读到的就是它
    writeBot('b3-panorama')
    const r = ok('b3-panorama')
    expect(r.pipeline).toEqual({ name: 'bot-chat', exists: true, concurrency: 'parallel' })
    // 恰三行、顺序即管线的声明序。没填的槽位**没有 ref 键**（不是值为 undefined 的键），
    // 也不算 missing —— 「没填」由管线的输入校验在派发时拦，读数条只标「填错」
    expect(r.slots).toEqual([
      { role: 'intent', required: true, description: 'gate agent', missing: false },
      { role: 'task', required: true, description: 'task agent', missing: false },
      { role: 'recheck', required: false, description: 'recheck agent', missing: false }
    ])
    expect(r.slots.some((s) => 'ref' in s)).toBe(false)
    expect(r.body).toEqual({ chars: 'BOT BODY.'.length })
    // 未降级时键**缺省**，不是值为 undefined 的键
    expect('gateDegraded' in r).toBe(false)
  })

  it('B4 填了内置档案（bot-intent / default）→ ref 原样、missing false', () => {
    writeBot('b4-builtin', { agents: { intent: 'bot-intent', task: 'default' } })
    expect(slotOf('b4-builtin', 'intent')).toEqual({
      role: 'intent',
      required: true,
      description: 'gate agent',
      ref: 'bot-intent',
      missing: false
    })
    expect(slotOf('b4-builtin', 'task')).toMatchObject({ ref: 'default', missing: false })
    // 没填的那个照旧没有 ref
    expect('ref' in slotOf('b4-builtin', 'recheck')).toBe(false)
  })

  it('B5 missing 只在「填了且查无此 agent」时为 true：填错的槽位标红，没填的不标', () => {
    writeBot('b5-ghost', { agents: { intent: 'no-such-agent' } })
    expect(slotOf('b5-ghost', 'intent')).toMatchObject({ ref: 'no-such-agent', missing: true })
    expect(slotOf('b5-ghost', 'task')).toEqual({
      role: 'task',
      required: true,
      description: 'task agent',
      missing: false
    })
  })

  it('B6 普通 ref 查合并注册表（用户 md 也算）；管线没声明的额外槽位追加在声明序之后，required=false', () => {
    writeAgentMd('my-gate')
    writeBot('b6-roles', { agents: { intent: 'my-gate', extra: 'bot-intent' } })
    const r = ok('b6-roles')
    // 顺序钉死：声明的三个槽位位置不因填写而漂，开放槽位一律排在其后
    expect(r.slots.map((s) => s.role)).toEqual(['intent', 'task', 'recheck', 'extra'])
    // 用户 md 真实存在 → false；原位替换（intent 仍在第 0 位）
    expect(r.slots[0]).toEqual({
      role: 'intent',
      required: true,
      description: 'gate agent',
      ref: 'my-gate',
      missing: false
    })
    // 额外槽位：管线没声明，所以既不必填也没有 description
    expect(r.slots[3]).toEqual({
      role: 'extra',
      required: false,
      ref: 'bot-intent',
      missing: false
    })
    expect('description' in r.slots[3]).toBe(false)
  })

  it('B6b 用户 md 覆盖了同名内置件（bot-intent）→ 仍 missing false（合并注册表：用户覆盖内置）', () => {
    writeAgentMd('bot-intent')
    writeBot('b6b-override', { agents: { intent: 'bot-intent' } })
    expect(slotOf('b6b-override', 'intent')).toMatchObject({ ref: 'bot-intent', missing: false })
  })

  it('B6c 槽位顺序跟管线的声明序，不跟 bot md 里 shuvix-bot-pipeline.agents 的书写序', () => {
    writeBot('b6c-order', { agents: { task: 'default', intent: 'bot-intent' } })
    expect(ok('b6c-order').slots.map((s) => s.role)).toEqual(['intent', 'task', 'recheck'])
  })

  it('B7 管线不存在：exists:false、concurrency 缺省、槽位表只剩 bot 自己填的（全按额外槽位列）', () => {
    mocks.hasWorkflow.mockImplementation((name: string) => name !== 'no-such-flow')
    writeBot('b7-noflow', { pipeline: 'no-such-flow' })
    const r = ok('b7-noflow')
    expect(r.pipeline.name).toBe('no-such-flow')
    expect(r.pipeline.exists).toBe(false)
    expect(r.pipeline.concurrency).toBeUndefined()
    expect(r.slots).toEqual([])

    // 填了的槽位仍要列出来 —— 管线名写坏时用户至少能看见自己填过什么
    writeBot('b7-noflow-filled', { pipeline: 'no-such-flow', agents: { task: 'default' } })
    expect(ok('b7-noflow-filled').slots).toEqual([
      { role: 'task', required: false, ref: 'default', missing: false }
    ])
  })

  it('B8 用户遮蔽内置管线：并发模式取未被遮蔽的那份（user 的 queue，不是内置的 parallel）', () => {
    mocks.listForSettings.mockReturnValue([
      { name: 'bot-chat', concurrency: 'queue', source: 'user' },
      { name: 'bot-chat', concurrency: 'parallel', overridden: true }
    ])
    writeBot('b8-shadow')
    expect(ok('b8-shadow').pipeline).toEqual({
      name: 'bot-chat',
      exists: true,
      concurrency: 'queue'
    })
  })

  it('B9 body.chars = 正文 trim 后的字符数 —— frontmatter 不算，首尾空行不算', () => {
    // 正文进每个参与 agent 的系统提示词，设置页据此提醒体量；它是解析器 trim 之后的那份
    const PERSONA = '## 人设\n直说结论。\n\n## 记忆\n- 偏好 pnpm；先看先例再拍板。'
    writeBot('b9-chars', { body: `\n\n${PERSONA}\n\n\n` })
    expect(ok('b9-chars').body.chars).toBe(PERSONA.length)
  })

  it('B10 正文为空是合法的 → chars 0（围栏照发，agent 得知道文件在哪）', () => {
    writeBot('b10-empty', { body: '' })
    expect(ok('b10-empty').body).toEqual({ chars: 0 })
  })

  it('B12 门控降级读数 + slots 仍显配置值（降级是运行时替换，不改写用户的槽位表）', async () => {
    writeAgentMd('my-intent')
    writeBot('b12-degraded', {
      displayName: 'B12',
      agents: { intent: 'my-intent', task: 'default' }
    })
    seedSession(['b12-degraded'])
    mocks.invoke.mockResolvedValue(ran({ gate: 'broken', outcome: 'gate-broken' }))
    await prompt('一')
    await prompt('二')

    const r = ok('b12-degraded')
    expect(r.gateDegraded).toBe('broken')
    // 分离语义：读数条的 slots 是「你配置了什么」，降级徽标才是「现在实际跑谁」——
    // 二者合并显示的话，用户会以为自己的 md 被改掉了
    expect(slotOf('b12-degraded', 'intent')).toMatchObject({ ref: 'my-intent', missing: false })
  })

  it('B13 载荷形状封口：顶层恰 body / pipeline / slots 三键，body 恰 chars 一键，槽位无多余键', () => {
    writeBot('b13-shape', { agents: { intent: 'bot-intent', extra: 'default' } })
    const r = ok('b13-shape')
    // 没有 notes：笔记段连同它的读数一起退场，正文本身就是记忆
    expect(Object.keys(r).sort()).toEqual(['body', 'pipeline', 'slots'])
    expect(Object.keys(r.body)).toEqual(['chars'])
    const allowed = new Set(['role', 'required', 'description', 'ref', 'missing'])
    for (const s of r.slots) {
      expect(
        Object.keys(s).every((k) => allowed.has(k)),
        JSON.stringify(s)
      ).toBe(true)
    }
  })
})

// ────────────────────────── AD：advise —— 对照注册表的提示 ──────────────────────────

/**
 * `botService.advise` 是属性卡琥珀横幅的数据源：文件**合法**之上，对照**此刻的注册表**说
 * 「跑起来会在哪里可见地失败」—— 管线在不在、重入模式对不对、必填槽位填没填、槽位指向的
 * agent 在不在、有没有填了管线没声明的槽位。它们都不是解析器的事（文件可以后补、注册表
 * 随时在变；两端共用的纯校验器也没有注册表可对照 —— shuvixMdValidate 的 BV-15 钉着那一半），
 * 所以只提示、不判非法：桌面 IPC 处理器把它们追加到 valid 结果的 messages 里，状态仍是 valid。
 *
 * 入参是一份已解析的 bot（属性卡送来的是编辑器里的文本，不是注册表里的那一份），所以这里
 * 直接构造 ParsedBotFile；agentService 仍用真的（同 B 组的理由）。断言到文案时取 em dash
 * 之前的「事实」半句 —— 后半句是后果，措辞可变。
 */
describe('botService.advise', () => {
  const HEALTHY = { intent: 'bot-intent', task: 'default' }
  const parsed = (p: Partial<ParsedBotFile> & { name: string }): ParsedBotFile => ({
    displayName: p.name,
    description: `unit bot ${p.name}`,
    body: '',
    pipeline: 'bot-chat',
    pipelineInput: {},
    agents: {},
    ...p
  })
  /** 每条提示 em dash 之前的「事实」半句 */
  const facts = (msgs: string[]): string[] => msgs.map((m) => m.split(' — ')[0])

  it('AD-1 健康的 bot → []：管线在、parallel、必填槽位都填了存在的 agent', () => {
    expect(botService.advise(parsed({ name: 'ad1', agents: HEALTHY }))).toEqual([])
  })

  it('AD-2 管线不存在 → 点名管线；此时没有槽位表可对照，填了的槽位不报「未声明」', () => {
    mocks.hasWorkflow.mockImplementation((name: string) => name !== 'no-such-flow')
    const out = botService.advise(
      parsed({ name: 'ad2', pipeline: 'no-such-flow', agents: HEALTHY })
    )
    expect(facts(out)).toEqual(["pipeline 'no-such-flow' does not exist"])
  })

  it('AD-2b 管线不存在时槽位指向的 agent 仍查：agent 的存在性不依赖管线', () => {
    mocks.hasWorkflow.mockImplementation((name: string) => name !== 'no-such-flow')
    const out = botService.advise(
      parsed({ name: 'ad2b', pipeline: 'no-such-flow', agents: { task: 'ghost-agent' } })
    )
    expect(facts(out)).toEqual([
      "pipeline 'no-such-flow' does not exist",
      "slot 'task': agent 'ghost-agent' does not exist"
    ])
  })

  it.each([['skip'], ['queue']])(
    'AD-3 用户同名文件遮蔽内置 bot-chat 且重入模式是 %s（非 parallel）→ 点名该模式',
    (mode) => {
      // 生效的是未被遮蔽的那份（同 B8）：内置的 parallel 被用户 bot-chat.md 的
      // `shuvix-workflow-concurrency: <mode>` 压掉了 —— 引擎级重入会和 mailbox 的独占打架
      mocks.listForSettings.mockReturnValue([
        { name: 'bot-chat', concurrency: mode, source: 'user' },
        { name: 'bot-chat', concurrency: 'parallel', overridden: true }
      ])
      const out = botService.advise(parsed({ name: 'ad3', agents: HEALTHY }))
      expect(facts(out)).toEqual([`pipeline 'bot-chat' declares '${mode}' reentry`])
      expect(out[0]).toContain('non-parallel')
    }
  )

  it('AD-3b 被遮蔽的那份不参与判定：用户覆盖仍是 parallel → 无提示', () => {
    mocks.listForSettings.mockReturnValue([
      { name: 'bot-chat', concurrency: 'parallel', source: 'user' },
      { name: 'bot-chat', concurrency: 'parallel', overridden: true }
    ])
    expect(botService.advise(parsed({ name: 'ad3b', agents: HEALTHY }))).toEqual([])
  })

  it('AD-4 必填槽位没填 → 点名槽位；可选槽位（recheck）没填不提示', () => {
    const out = botService.advise(parsed({ name: 'ad4', agents: { intent: 'bot-intent' } }))
    expect(facts(out)).toEqual(["slot 'task' is required by the pipeline but not set"])
    expect(out[0]).toContain('cannot run')
    // 两个必填都没填：各一条，按管线的声明序
    expect(facts(botService.advise(parsed({ name: 'ad4b' })))).toEqual([
      "slot 'intent' is required by the pipeline but not set",
      "slot 'task' is required by the pipeline but not set"
    ])
  })

  it('AD-5 槽位指向不存在的 agent → 点名槽位与 agent；用户 md 里的 agent 算存在（合并注册表）', () => {
    writeAgentMd('my-gate')
    expect(
      botService.advise(parsed({ name: 'ad5', agents: { intent: 'my-gate', task: 'default' } }))
    ).toEqual([])
    const out = botService.advise(
      parsed({ name: 'ad5b', agents: { intent: 'ghost-agent', task: 'default' } })
    )
    expect(facts(out)).toEqual(["slot 'intent': agent 'ghost-agent' does not exist"])
  })

  it('AD-6 填了管线没声明的槽位 → 提示它被忽略；那个槽位再指向不存在的 agent 时多一条', () => {
    const out = botService.advise(parsed({ name: 'ad6', agents: { ...HEALTHY, extra: 'default' } }))
    expect(facts(out)).toEqual(["slot 'extra' is not declared by pipeline 'bot-chat'"])
    expect(out[0]).toContain('ignored')
    expect(
      facts(botService.advise(parsed({ name: 'ad6b', agents: { ...HEALTHY, extra: 'ghost' } })))
    ).toEqual([
      "slot 'extra' is not declared by pipeline 'bot-chat'",
      "slot 'extra': agent 'ghost' does not exist"
    ])
  })

  it('AD-7 多处不对时逐条列出，顺序固定：管线 → 声明的槽位（按声明序）→ 额外槽位', () => {
    mocks.listForSettings.mockReturnValue([
      { name: 'bot-chat', concurrency: 'queue', source: 'user' }
    ])
    const out = botService.advise(
      parsed({ name: 'ad7', agents: { extra: 'default', intent: 'ghost' } })
    )
    expect(facts(out)).toEqual([
      "pipeline 'bot-chat' declares 'queue' reentry",
      "slot 'intent': agent 'ghost' does not exist",
      "slot 'task' is required by the pipeline but not set",
      "slot 'extra' is not declared by pipeline 'bot-chat'"
    ])
  })

  it('AD-8 提示是提示不是拒绝：文案里没有「the whole file is rejected」，也不经 i18n（英文原话，同解析器诊断口径）', () => {
    mocks.hasWorkflow.mockReturnValue(false)
    const out = botService.advise(parsed({ name: 'ad8', pipeline: 'gone', agents: { x: 'ghost' } }))
    expect(out.length).toBeGreaterThan(0)
    for (const m of out) {
      expect(m).not.toContain('the whole file is rejected')
      // i18n 在这里被桩成「返回 key」—— 走了 t() 的文案会长成 `bot.xxx`
      expect(m).not.toMatch(/^bot\./)
    }
  })

  it('AD-9 与 inspect 同源：inspect 标 missing 的槽位恰是 advise 点名「does not exist」的槽位', () => {
    writeBot('ad9', { agents: { intent: 'ghost', task: 'default' } })
    const missing = ok('ad9')
      .slots.filter((s) => s.missing)
      .map((s) => s.role)
    const advised = botService
      .advise(botService.getBot('ad9')!)
      .filter((m) => m.includes('does not exist'))
      .map((m) => /^slot '([^']+)'/.exec(m)![1])
    expect(missing).toEqual(['intent'])
    expect(advised).toEqual(missing)
  })
})
