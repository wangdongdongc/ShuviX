/**
 * botService.inspect —— 设置页运行时读数条（A1）的数据源。
 *
 * inspect 回答的是「按现在的注册表状态，这个 bot 跑起来会解析成什么」：管线在不在、
 * 各角色 ref 落到谁头上、门控是否已 sticky 降级、笔记攒了多少。它是**呈现**接口 ——
 * 引用缺失即回落这类事实此前只埋在 journal 里（§8.5），读数条是把它们摆上台面的那一步。
 *
 * 与 botServiceTriggers 同一套夹具（vi.hoisted 临时目录 + 真 fs + 真会话树），差别有二：
 *  - **agentService 用真的**：stages 的 missing 判定要穿透「内置 + 用户 md 覆盖」的合并
 *    注册表，mock 它等于把被测逻辑的一半换成断言自己；
 *  - workflowService 的 mock 多补 listForSettings（inspect 读并发模式的那条缝）。
 *
 * ⚠️ 笔记状态文件是**懒加载 + 进程内缓存**的（BotNotesScheduler.load 只跑一次）：
 * 种子必须在本进程第一次 peek 之前就落盘 —— beforeEach 里每次重建，无论哪条用例先跑
 * 都保证首次加载读到完整种子；各用例的 bot 名互不复用，缓存不串味。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

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
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: mocks.fire }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({
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
vi.mock('../sessionService', () => ({ sessionService: { getById: mocks.getById } }))

import { botService } from '../botService'
import { clearSessionTreeCacheForTests } from '../sessionStorage'

let SID = 'inspect-sess'
let sidSeq = 0

const STATE_FILE = join(dirs.bots, '.notes-state.json')
/** 笔记调度种子 —— **文件级最先**：beforeEach 每次重建，首次懒加载无论落在哪条用例都读得到 */
const NOTES_STATE = {
  'b9-notes': { lastRunAt: 111222333, pending: 4, sessions: { s1: 'e1', s2: '' } }
}

function writeBot(
  name: string,
  opts: {
    displayName?: string
    pipeline?: string
    notes?: boolean
    agents?: Record<string, string>
    body?: string
  } = {}
): void {
  mkdirSync(dirs.bots, { recursive: true })
  const lines = ['---', 'shuvix: bot v1', `name: ${name}`, `description: unit bot ${name}`]
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  if (opts.pipeline) lines.push(`shuvix-bot-pipeline: ${opts.pipeline}`)
  if (opts.notes === false) lines.push('shuvix-bot-notes: false')
  if (opts.agents) {
    lines.push('shuvix-bot-agents:')
    for (const [k, v] of Object.entries(opts.agents)) lines.push(`  ${k}: ${v}`)
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

/** inspect 的成功形态（error 形态直接 fail，让失败信息带上原因） */
function ok(name: string): {
  pipeline: { name: string; exists: boolean; concurrency?: string }
  stages: Array<{ role: string; ref: string; missing: boolean }>
  gateDegraded?: string
  notes: { enabled: boolean; chars: number; pending: number; lastRunAt: number }
} {
  const r = botService.inspect(name)
  if ('error' in r) throw new Error(`inspect("${name}") unexpectedly failed: ${r.error}`)
  return r
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
  writeFileSync(STATE_FILE, JSON.stringify(NOTES_STATE))
  clearSessionTreeCacheForTests()
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.hasWorkflow.mockReturnValue(true)
  // 生效并发模式来自「未被遮蔽」的注册表条目 —— 缺省只有内置 bot-chat（parallel）
  mocks.listForSettings.mockReturnValue([{ name: 'bot-chat', concurrency: 'parallel' }])
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

  it('B3 缺省全景：内置管线 + 四个缺省角色 + 零笔记，无 gateDegraded 键', () => {
    writeBot('b3-panorama')
    const r = ok('b3-panorama')
    expect(r.pipeline).toEqual({ name: 'bot-chat', exists: true, concurrency: 'parallel' })
    // 恰四行、顺序即角色表的装配序：三个内置缺省 + task 自指
    expect(r.stages).toEqual([
      { role: 'intent', ref: 'bot-intent', missing: false },
      { role: 'recheck', ref: 'bot-intent', missing: false },
      { role: 'notes', ref: 'bot-notes', missing: false },
      { role: 'task', ref: `bot:b3-panorama`, missing: false }
    ])
    expect(r.notes).toEqual({ enabled: true, chars: 0, pending: 0, lastRunAt: 0 })
    // 未降级时键**缺省**，不是值为 undefined 的键
    expect('gateDegraded' in r).toBe(false)
  })

  it('B4 task 自指永不 missing（缺省与显式 bot:<self> 同判）', () => {
    writeBot('b4-implicit')
    writeBot('b4-explicit', { agents: { task: 'bot:b4-explicit' } })
    expect(ok('b4-implicit').stages.find((s) => s.role === 'task')).toEqual({
      role: 'task',
      ref: 'bot:b4-implicit',
      missing: false
    })
    expect(ok('b4-explicit').stages.find((s) => s.role === 'task')).toEqual({
      role: 'task',
      ref: 'bot:b4-explicit',
      missing: false
    })
  })

  it('B5 bot: 前缀 ref 查 bot 注册表：在册 → false，查无此 bot → true', () => {
    writeBot('b5-other')
    writeBot('b5-points-real', { agents: { task: 'bot:b5-other' } })
    writeBot('b5-points-ghost', { agents: { task: 'bot:ghost' } })
    expect(ok('b5-points-real').stages.find((s) => s.role === 'task')!.missing).toBe(false)
    expect(ok('b5-points-ghost').stages.find((s) => s.role === 'task')).toEqual({
      role: 'task',
      ref: 'bot:ghost',
      missing: true
    })
  })

  it('B6 普通 ref 查 agent 档案注册表；覆盖角色原位替换、额外角色追加于 task 后', () => {
    writeAgentMd('my-gate')
    writeBot('b6-roles', { agents: { intent: 'my-gate', extra: 'bot-notes' } })
    const r = ok('b6-roles')
    // 顺序钉死：缺省三角色的位置不因覆盖而漂，开放角色一律排在 task 之后
    expect(r.stages.map((s) => s.role)).toEqual(['intent', 'recheck', 'notes', 'task', 'extra'])
    // 用户 md 真实存在 → false；原位替换（intent 仍在第 0 位）
    expect(r.stages[0]).toEqual({ role: 'intent', ref: 'my-gate', missing: false })
    expect(r.stages[4]).toEqual({ role: 'extra', ref: 'bot-notes', missing: false })

    writeBot('b6-missing', { agents: { intent: 'no-such-agent' } })
    expect(ok('b6-missing').stages[0]).toEqual({
      role: 'intent',
      ref: 'no-such-agent',
      missing: true
    })
  })

  it('B7 管线不存在：exists:false、concurrency 缺省', () => {
    mocks.hasWorkflow.mockImplementation((name: string) => name !== 'no-such-flow')
    writeBot('b7-noflow', { pipeline: 'no-such-flow' })
    const r = ok('b7-noflow')
    expect(r.pipeline.name).toBe('no-such-flow')
    expect(r.pipeline.exists).toBe(false)
    expect(r.pipeline.concurrency).toBeUndefined()
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

  it('B9 笔记关闭仍回 peek 数字 —— 开关管「还要不要跑」，读数管「已经攒了什么」', () => {
    writeBot('b9-notes', { notes: false })
    expect(ok('b9-notes').notes).toEqual({
      enabled: false,
      chars: 0,
      pending: 4,
      lastRunAt: 111222333
    })
  })

  it('B10 chars = 笔记区切片长度（分界线之下 trim 后的字符数，不是整篇正文）', () => {
    const NOTE = '## 关于这个用户\n偏好 pnpm；先看先例再拍板。'
    writeBot('b10-chars', {
      body: `PERSONA LINE.\n\n<!-- shuvix:bot-notes -->\n\n${NOTE}`
    })
    expect(ok('b10-chars').notes.chars).toBe(NOTE.length)
  })

  it('B11 peek 不种状态：inspect 未知于状态文件的 bot → 0/0，且状态文件不新增/不创建', () => {
    writeBot('b11-fresh')
    rmSync(STATE_FILE, { force: true })
    expect(ok('b11-fresh').notes).toEqual({ enabled: true, chars: 0, pending: 0, lastRunAt: 0 })
    // 「看一眼」不落盘：文件既不被重建，也不长出一个从没归纳过的 bot
    expect(existsSync(STATE_FILE)).toBe(false)
  })

  it('B12 门控降级读数 + stages 仍显配置值（降级是运行时替换,不改写用户的角色表）', async () => {
    writeBot('b12-degraded', { displayName: 'B12', agents: { intent: 'my-intent' } })
    seedSession(['b12-degraded'])
    mocks.invoke.mockResolvedValue(ran({ gate: 'broken', outcome: 'gate-broken' }))
    await prompt('一')
    await prompt('二')

    const r = ok('b12-degraded')
    expect(r.gateDegraded).toBe('broken')
    // 分离语义：读数条的 stages 是「你配置了什么」，降级徽标才是「现在实际跑谁」——
    // 二者合并显示的话，用户会以为自己的 md 被改掉了
    expect(r.stages.find((s) => s.role === 'intent')!.ref).toBe('my-intent')
  })

  it('B13 载荷形状封口：notes 恰 4 键（sessions 不外漏）、顶层无多余键', () => {
    writeBot('b13-shape')
    const r = ok('b13-shape')
    expect(Object.keys(r).sort()).toEqual(['notes', 'pipeline', 'stages'])
    // peek 自带 sessions 计数,inspect 刻意不透传 —— 会话数属于调度内部,不是设置页读数
    expect(Object.keys(r.notes).sort()).toEqual(['chars', 'enabled', 'lastRunAt', 'pending'])
  })
})
