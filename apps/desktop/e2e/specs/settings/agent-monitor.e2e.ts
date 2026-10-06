/**
 * 智能体监视端到端（隔离实例）—— 主窗 RightPanel 的 agents tab（AgentMonitorPanel）
 * 与设置窗口「监视器」页的回落，外加对话区顶部状态横幅（StatusBanner）的 profile 标记
 * （AgentProfileChip）与监视面板的联动（AM-10 ~ AM-17），提示词缓存命中率（AM-18 ~ AM-22）、
 * 花费（AM-23）与「只列打开着的会话」（AM-24，跨重启）。P3-13：数据源是打开着的 durable 会话的
 * `monitorSnapshot()` —— 没有事件计数器、没有孤儿（会话删了它的行一起没），缓存与花费取自 `pi.usage`。
 *
 * 实例复用（减少启动开销，故几组用例收在同一文件）：
 *   - 组一（AM-1/2/10/8/9）：无 provider 的全新实例 —— 空态、tab 存在性、未发消息的
 *     新会话横幅缺席、设置页形态与旧 hash 回落；
 *   - 组二（AM-3~7、AM-11~23）：fakeProvider 实例 —— 根 agent 上屏、相位灯、血缘缩进、
 *     删会话连同派生行一起消失、详情手风琴，横幅标记的出现/相位/点击三联动/筛选 chip，缓存命中率的
 *     三态（尚无用量 / 未上报 / 百分数）、按 token 加权的累计、中止不计入而零内容空回复计入（它也是花费，
 *     PIN-03）、未定价模型的花费格、窄面板不横向溢出；
 *   - 组三（AM-24）：`stop({keepHome})` + 重开 —— 重开之后没看过的会话不列，打开它根行才出现，它从前的
 *     echo 子 agent 不列（PIN-02）。
 *     注意 **turn-completed 的 echo hook 到 AM-5 才种进 hooksDir**：AM-3 断的是「恰一条」，
 *      hook 若 beforeAll 就装好，首轮收尾就会多出一个派生 entry（hooksDir 是指纹缓存的现扫，
 *     中途落盘下一轮即生效，见 hookService.scanCache）；AM-17 摘掉它，缓存段的会话因此不派生。
 *
 * 观测面：列表 / 详情数据一律走 IPC（`agent.monitorList` / `agent.monitorDetail`），DOM 只断
 * 呈现（相位灯配色与脉冲、血缘箭头、花费格、空态在屏、手风琴展开态、横幅标记）；空态文案是 i18n
 * 产物，只认结构与非空（AM-17 的「筛选空态 ≠ 通用空态」是同实例内的文案比对，不钉具体句子）。
 * 轮次收尾靠 `agent.prompt` 自己落定（durable 的 submitUser 等这一轮落定才答），扣住的轮次靠监视
 * 列表的相位回到 idle。用例有顺序依赖：AM-4 续 AM-3 的会话，AM-6 删 AM-5 的会话，
 * AM-7 用 AM-3 的根 + AM-11 的会话做手风琴互斥；AM-13~15 续 AM-11 的会话，
 * 所有「恰 N 条」断言都按 sid 过滤做相对比较，不做全量计数。
 *
 * 缓存命中率（AM-18 ~ AM-21）共用一条会话 `sids.cache`，累计数值逐条往后接（AM-19 断的是
 * AM-18 那一轮收尾后的累计，AM-20 在它之上加两轮，AM-21 再来一次中止与一次零内容）；AM-23 读它的花费，
 * AM-22 用 AM-21 收尾时的全量列表量宽度。这一段刻意放在 **AM-17 之后**：那时 echo hook 已经摘掉，
 * 新会话的轮次不会再派生 echo-agent —— 否则列表里多出 spawned 行、而且它会争用脚本。
 * 行定位靠横幅 chip 按 `sids.cache` 筛选（AM-13 那套），让列表只剩这一行；数值一律走 IPC，
 * DOM 只断呈现（图标在不在、`—` 还是 `NN%`、详情两格），文案类格子只比相等 / 不等。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '../../../../../packages/chat-protocol/src/i18n/locales/en.json'
import ja from '../../../../../packages/chat-protocol/src/i18n/locales/ja.json'
import zh from '../../../../../packages/chat-protocol/src/i18n/locales/zh.json'
import { listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  chatPane,
  monitorSettingsPane,
  rightPanelPane,
  sidebarPane,
  statusBannerPane,
  type AgentMonitorRowShot,
  type RightPanelPane,
  type SidebarPane,
  type StatusBannerPane
} from '../../harness/pages'
import {
  createProject,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'

const MODEL = 'e2e-model'
const TURN_COMPLETED = 'session.turn-completed'
const ECHO_BODY = 'E2E monitor echo hook.'

/**
 * AM-1 记下的通用空态原文（无任何运行时那条），供 AM-17 做「筛选空态文案不同」的比对 ——
 * 跨 describe（两个实例）共享，故挂在模块级；文案本身是 i18n 产物，只比不等、不钉内容。
 */
let genericEmptyText = ''

/** 三项缓存用量（pi 归一后互不重叠：input 已扣掉命中的部分） */
interface CacheTriple {
  input: number
  cacheRead: number
  cacheWrite: number
}

interface MonitorEntry {
  agentId: string
  kind: string
  rootSessionId: string
  depth: number
  profileName: string
  displayName: string
  dispatch?: string
  phase: string
  rootSessionTitle?: string
  model: { id: string }
  contextTokens: number
  cache: CacheTriple & { reported: boolean; last?: CacheTriple }
  cost: { total: number }
  sessionCost: number
}

/** 花费格「未定价」悬停说明的三语原文（AM-23：实例的界面语言不钉，三者之一即可） */
const UNPRICED_TITLES = [en, zh, ja].map((bundle) => bundle.panel.agentCostUnpricedTitle)

interface MonitorDetail {
  systemPrompt: string
  tools: unknown[]
  messageCount: number
}

const monitorList = (main: CdpClient): Promise<MonitorEntry[]> =>
  main.eval('window.api.agent.monitorList()')
const monitorDetail = (main: CdpClient, agentId: string): Promise<MonitorDetail | null> =>
  main.eval(`window.api.agent.monitorDetail(${JSON.stringify(agentId)})`)

/** 发 prompt 不等它、失败也吞掉（扣住的轮次另由监视列表的相位回 idle 等） */
const promptTolerant = (main: CdpClient, sid: string, text: string): Promise<unknown> =>
  main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined), true)`
  )

/** 根会话的请求：最后一条用户消息就是这句 prompt */
const rootRequest =
  (text: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText === text
/** echo hook 的请求：任务文本以这段正文开头、围栏里带这条会话 */
const echoRequest =
  (sid: string) =>
  (r: FakeRequest): boolean =>
    r.lastUserText.startsWith(ECHO_BODY) && r.lastUserText.includes(sid)

/** echo hook 的 md（turn-completed 触发，派 echo-agent） */
const ECHO_HOOK_MD = [
  '---',
  'shuvix: hook v1',
  'name: echo',
  'shuvix-hook-agent: echo-agent',
  'shuvix-hook-on:',
  `  - trigger: ${TURN_COMPLETED}`,
  '---',
  '',
  ECHO_BODY,
  ''
].join('\n')

/**
 * 发一轮并等它落定：durable 的 submitUser 等这一轮落定才答，`agent.prompt` 原样把它交回 —— 不靠
 * agent_end 事件。失败也吞掉（断言另走 IPC）
 */
const promptAndSettle = (main: CdpClient, sid: string, text: string): Promise<unknown> =>
  main.eval(
    `window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined).then(() => true)`
  )

// ─────────────────────────────────────────────────────────────────────────
// 组一：无 provider 的全新实例 —— 空态 / tab 存在性 / 设置页形态与旧 hash 回落

describe('空实例：空态、tab 位置与设置页回落', () => {
  let app: E2EApp
  let pane: RightPanelPane
  let settings: CdpClient | null = null

  beforeAll(async () => {
    app = await launchApp()
    await waitRendererReady(app.main)
    pane = rightPanelPane(app.main)
  })
  afterAll(async () => {
    await app?.stop()
  })

  it('AM-1 空态：新实例无活运行时 —— IPC 列表为空，DOM 空态非空且无列表行', async () => {
    await pane.open()
    await pane.activateAgentsTab()

    expect(await monitorList(app.main)).toEqual([])
    // 空态出现本身即证明首 tick 完成（loading 分支是另一块 DOM，不认它）
    const empty = await until(
      async () => (await pane.emptyText()) || null,
      'agent monitor empty state'
    )
    expect(empty.length).toBeGreaterThan(0)
    genericEmptyText = empty
    expect(await pane.rows()).toEqual([])
  })

  it('AM-2 agents tab 存在且是最后一个可见 tab；preview 默认隐藏（认图标 + DOM 序，不认文案）', async () => {
    // 面板已在 AM-1 打开；可见集合 = widget / calendar / agents（浏览器是独立窗口，不在面板里）
    expect(await pane.tabIcons()).toEqual([
      'lucide-wrench',
      'lucide-calendar-days',
      'lucide-activity'
    ])
  })

  it('AM-10 新会话未发消息：横幅整条不出现 —— chip 缺席且 banner 元素缺席（不是「banner 在但空」）；IPC 无该 sid entry', async () => {
    // 只建会话不发消息：根 agent 首轮才创建，monitorList 里永远不会有它（AM-1 的空列表断言因此不被破坏）
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'AM-10 fresh lane' })}).then((s) => s.id)`
    )
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.openSession('AM-10 fresh lane')) || null,
      'AM-10 session opened'
    )
    await chatPane(app.main).ready()

    // 缺席断言没有 until 可用：让监视轮询先走完一个 tick（1s），证明「会出现的窗口」已经过去
    await sleep(1200)
    const banner = statusBannerPane(app.main)
    expect(await banner.chip()).toBeNull()
    expect(await banner.bannerPresent()).toBe(false)
    const list = await monitorList(app.main)
    expect(list.some((e) => e.agentId === sid || e.rootSessionId === sid)).toBe(false)
  })

  it('AM-8 设置窗口只剩 LLM 请求子页：子标签条恰 1 个 tab，顶层导航无「智能体」项（旧 tab 的 lucide-bot 图标不再出现）', async () => {
    settings = await app.openSettings('monitor/httpLogs')
    // 构造器自带 [data-monitor-toolbar] 就绪等待
    const ms = await monitorSettingsPane(settings)
    expect(await ms.subTabCount()).toBe(1)
    expect(await ms.navIcons()).not.toContain('lucide-bot')
  })

  it('AM-9 旧 hash monitor/agents 回落：与 AM-8 同态（唯一子 tab 激活），hash 不被重写', async () => {
    // openSettings 对已存在窗口只聚焦不切 tab，且按「url 含 #settings」找 target —— 旧窗必须死透、
    // 连 target 也从 /json 里消失，才能保证重开的是新窗、连上的也是新窗。
    // 判据取 /json（主进程侧的事实），不取页内探活：页内 eval 在窗口拆掉时可能收不到回包，
    // 而「800ms 没回包就算死了」在满载时会把一个还活着的窗口当成已死。
    // window.close() 与回包赛跑：回包先到则 resolve，socket 先断则 reject（cdp.ts 的 onclose），都不挂
    await settings!.eval('window.close()').catch(() => undefined)
    settings!.close()
    await until(
      async () =>
        !(await listTargets(app.port)).some(
          (t) => t.type === 'page' && t.url.includes('#settings')
        ) || null,
      'settings window target gone from /json'
    )

    settings = await app.openSettings('monitor/agents')
    const ms = await monitorSettingsPane(settings)
    expect(await ms.subTabCount()).toBe(1)
    expect(await ms.subTabActive()).toBe(true)
    // 子段非法只影响回落到哪个子页，hash 原样保留（不重写成 monitor/httpLogs）
    expect(await ms.hash()).toBe('#settings/monitor/agents')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 组二：fakeProvider 实例 —— 上屏 / 相位灯 / 血缘 / 删会话 / 详情手风琴 / 缓存 / 花费

describe('fakeProvider：运行时的上屏、相位、血缘与详情', () => {
  let app: E2EApp
  let provider: FakeProvider
  let pane: RightPanelPane
  let banner: StatusBannerPane
  let sidebar: SidebarPane
  const sids: Record<string, string> = {}

  beforeAll(async () => {
    app = await launchApp()
    provider = await startFakeProvider()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)
    pane = rightPanelPane(app.main)
    banner = statusBannerPane(app.main)
    sidebar = sidebarPane(app.main)
    await pane.open()
    await pane.activateAgentsTab()
  })
  afterAll(async () => {
    await provider?.close()
    await app?.stop()
  })

  const createSession = (title: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
    )

  /** 发一轮并等根会话这一轮落定 */
  const promptTurn = async (sid: string, text: string): Promise<void> => {
    await promptAndSettle(app.main, sid, text)
  }

  /** 等某个 agent 在 IPC 列表里回到 idle */
  const idleEntry = (agentId: string, what: string): Promise<MonitorEntry> =>
    until(async () => {
      const e = (await monitorList(app.main)).find((x) => x.agentId === agentId)
      return e?.phase === 'idle' ? e : null
    }, what)

  it('AM-3 根 agent 上屏：恰一条 root entry（id = rootSessionId = sid、idle、模型 id、会话标题），行内无血缘箭头', async () => {
    const sid = await createSession('AM-3 monitor lane')
    sids.root = sid
    provider.script({ text: 'r1', when: rootRequest('hello') })
    await promptTurn(sid, 'hello')

    const entry = await until(async () => {
      const list = await monitorList(app.main)
      return list.length === 1 ? list[0] : null
    }, 'exactly one monitor entry')
    expect(entry.kind).toBe('root')
    expect(entry.agentId).toBe(sid)
    expect(entry.rootSessionId).toBe(sid)
    expect(entry.phase).toBe('idle')
    expect('rootSessionExists' in entry).toBe(false)
    expect(entry.rootSessionTitle).toBe('AM-3 monitor lane')
    expect(entry.model.id).toBe(MODEL)

    const row = await until(async () => {
      const rows = await pane.rows()
      return rows.length === 1 ? rows[0] : null
    }, 'one monitor row on screen')
    expect(row.text).toContain('AM-3 monitor lane')
    expect(row.text).toContain(MODEL)
    expect(row.phaseClass).toContain('bg-text-tertiary/40')
    expect(row.pulsing).toBe(false)
    expect(row.arrow).toBe(false)
  })

  it('AM-4 相位灯：hold 中的第二轮显示 turn（绿灯脉冲），放行后回 idle', async () => {
    const sid = sids.root
    provider.script({ holdMs: 20_000, when: rootRequest('again') })
    await promptTolerant(app.main, sid, 'again')

    const entry = await until(async () => {
      const e = (await monitorList(app.main)).find((x) => x.agentId === sid)
      return e?.phase === 'turn' ? e : null
    }, 'root entry in turn phase')
    expect('counters' in entry).toBe(false)

    // DOM 每秒轮询才跟上 —— until 等到脉冲上屏（此刻列表里仍只有这一行）
    const row = await until(async () => {
      const rows = await pane.rows()
      return rows.length === 1 && rows[0].pulsing ? rows[0] : null
    }, 'phase dot pulsing on screen')
    expect(row.phaseClass).toContain('bg-emerald-500')

    provider.release()
    await idleEntry(sid, 'root entry back to idle')
  })

  it('AM-5 血缘：turn-completed hook 派生的 agent 缩进跟随根行（同 rootSessionId、紧随其后、只有它有血缘箭头）', async () => {
    // hook 此刻才落盘：AM-3/AM-4 的轮次不能派生任何 agent（AM-3 的「恰一条」靠这个成立）
    writeAgentMd(app, 'echo-agent', { tools: 'read', body: 'ECHO AGENT BODY.' })
    mkdirSync(app.hooksDir, { recursive: true })
    writeFileSync(join(app.hooksDir, 'echo.md'), ECHO_HOOK_MD)

    const sid = await createSession('AM-5 lineage lane')
    sids.lineage = sid
    provider.script(
      { text: 'r1', when: rootRequest('lin-1') },
      { text: 'echo-r', when: echoRequest(sid) }
    )
    await promptTurn(sid, 'lin-1')

    // AM-6 删会话的前提：派生 run 完全落回 idle（滞留而不是在跑）
    await until(async () => {
      const e = (await monitorList(app.main)).find(
        (x) => x.kind === 'spawned' && x.rootSessionId === sid && x.profileName === 'echo-agent'
      )
      return e?.phase === 'idle' ? e : null
    }, 'spawned echo agent back to idle')

    const list = await monitorList(app.main)
    const rootIdx = list.findIndex((e) => e.agentId === sid)
    const spawnIdx = list.findIndex((e) => e.kind === 'spawned' && e.rootSessionId === sid)
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    // 父在上、子紧随（组间排序不测，故按找到的下标断相对位置）
    expect(spawnIdx).toBe(rootIdx + 1)
    const spawned = list[spawnIdx]
    expect(spawned.profileName).toBe('echo-agent')
    expect(spawned.depth).toBeGreaterThanOrEqual(1)
    expect(spawned.dispatch).toBe('hook')

    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === list.length ? rs : null
    }, 'monitor rows match the list')
    expect(rows[rootIdx].arrow).toBe(false)
    expect(rows[spawnIdx].arrow).toBe(true)
    expect(await pane.rowsAdjacent(rootIdx, spawnIdx)).toBe(true)
  })

  it('AM-6 删会话：根行与它的派生行一起消失（没有孤儿）；没有 rootSessionExists 键；DOM 行与列表一致；不得有未捕获异常', async () => {
    const sid = sids.lineage
    const before = await monitorList(app.main)
    expect(before.filter((e) => e.rootSessionId === sid).length).toBe(2)
    const errorsBefore = await app.main.eval<string[]>('window.__e2e ?? []')

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(
      async () => !(await monitorList(app.main)).some((e) => e.rootSessionId === sid) || null,
      'every row of the deleted session gone'
    )
    const after = await monitorList(app.main)
    for (const e of after) expect('rootSessionExists' in e).toBe(false)
    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === after.length ? rs : null
    }, 'monitor rows match the list after the delete')
    expect(rows.some((r) => r.text.includes('AM-5 lineage lane'))).toBe(false)
    expect(await app.main.eval<string[]>('window.__e2e ?? []')).toEqual(errorsBefore)
  })

  // ── AM-11 ~ AM-17：对话区状态横幅的 profile 标记（AgentProfileChip）与监视面板联动 ──
  // 此刻 echo hook 已装（AM-5），每条新会话的首轮都会自动派生一个 echo-agent（无脚本匹配
  // 时 fakeProvider 回默认 "OK" 收尾）；列表里还有 AM-3 的根 —— 故所有
  // 「恰 N 条」都按 sid 过滤做相对比较，不做全量计数。AM-7（详情手风琴）排在 AM-11 之后：它要两行。

  /**
   * IPC 已报 idle 之后，标记最多再等多久跟上：一个轮询周期（agentMonitorStore POLL_MS = 1000）
   * + until 自己的 400ms 轮询间隔 + 渲染余量。超过它说明标记不跟随轮询，是产品问题。
   */
  const CHIP_CATCH_UP_MS = 3000

  /** 建会话（IPC）→ 侧栏打开成行 → 发一轮并等收尾（横幅标记用例的公共前奏） */
  const openAndPrompt = async (title: string, text: string): Promise<string> => {
    const sid = await createSession(title)
    await until(async () => (await sidebar.openSession(title)) || null, `session "${title}" opened`)
    provider.script({ text: 'r1', when: rootRequest(text) })
    await promptTurn(sid, text)
    return sid
  }

  it('AM-11 首轮后标记出现：内容 = 档案显示名（chat 的 displayName），idle 灰点不脉冲，横幅在屏', async () => {
    const sid = await openAndPrompt('AM-11 banner lane', 'banner-1')
    sids.banner = sid

    // 标记的相位来自监视 store 的 1s 轮询（agentMonitorStore POLL_MS）：首轮刚收尾时，store 里的
    // 那一拍可能还是 turn 中取的，标记已在屏却仍是绿脉冲 —— 不能断言第一次读到的相位。
    // 先等 IPC（store 的数据源）报 idle，再等标记跟上；标记必须在约一个轮询周期内跟上，
    // 跟不上才是产品问题（轮询停了 / 标记没订阅），所以这一步给的是紧的上限而不是缺省的 25s。
    const entry = await until(async () => {
      const e = (await monitorList(app.main)).find((x) => x.kind === 'root' && x.agentId === sid)
      return e?.phase === 'idle' ? e : null
    }, 'root entry idle in IPC')
    const chip = await until(
      async () => {
        const c = await banner.chip()
        return c && !c.pulsing && c.phaseClass.includes('bg-text-tertiary/40') ? c : null
      },
      'profile chip shows the idle dot',
      CHIP_CATCH_UP_MS
    )
    expect(chip.profile).toBe('chat')
    // 显示名与 IPC 该 root entry 的 displayName 同源（档案 md 的 shuvix-displayName，随界面语言）
    expect(entry.displayName).toBeTruthy()
    expect(chip.text).toBe(entry.displayName)
    expect(await banner.bannerPresent()).toBe(true)
  })

  it('AM-7 展开详情：monitorDetail 非 null（注入标记 / 工具 / messageCount），手风琴互斥（点同一条收起、展开 B 时 A 消失）', async () => {
    const sid = sids.root
    const detail = await monitorDetail(app.main, sid)
    expect(detail).not.toBeNull()
    // 注入标记 = 会话的工作目录原文（系统提示词随界面语言走，英文锚点 'Working directory:'
    // 在中文副本里不存在；目录路径是各语言副本都逐字内嵌的那段）
    const workDir = await app.main.eval<string>(
      `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.workingDirectory || '')`
    )
    expect(workDir).not.toBe('')
    expect(detail!.systemPrompt).toContain(workDir)
    expect(detail!.tools.length).toBeGreaterThan(0)
    expect(detail!.messageCount).toBeGreaterThanOrEqual(2)

    // 此刻列表 = AM-3 的根 + AM-11 的根（与它的 echo 子 agent）—— 至少两行，够断互斥
    const list = await monitorList(app.main)
    const rootIdx = list.findIndex((e) => e.agentId === sid)
    const otherIdx = list.findIndex((e) => e.agentId !== sid)
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    expect(otherIdx).toBeGreaterThanOrEqual(0)

    await pane.clickRow(rootIdx)
    await until(() => pane.detailOpen(rootIdx), 'root detail expanded')

    // 点同一条 = 收起
    await pane.clickRow(rootIdx)
    await until(
      async () => !(await pane.detailOpen(rootIdx)) || null,
      'detail collapsed on re-click'
    )

    // 展开 A 再展开 B：A 的详情卸载（手风琴）
    await pane.clickRow(rootIdx)
    await until(() => pane.detailOpen(rootIdx), 'root detail expanded again')
    await pane.clickRow(otherIdx)
    await until(
      async () => ((await pane.detailOpen(otherIdx)) && !(await pane.detailOpen(rootIdx))) || null,
      'accordion: B expanded, A unmounted'
    )
  })

  it('AM-12 项目会话的标记属 work，显示它的显示名（与 IPC displayName 一致）', async () => {
    const projDir = join(app.home, 'proj-am12')
    mkdirSync(projDir, { recursive: true })
    const { id: projectId } = await createProject(app.main, { name: 'AM-12 Proj', path: projDir })
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'AM-12 work lane', projectId })}).then((s) => s.id)`
    )
    await until(
      async () => (await sidebar.openSession('AM-12 work lane')) || null,
      'AM-12 session opened'
    )
    provider.script({ text: 'r1', when: rootRequest('work-1') })
    await promptTurn(sid, 'work-1')

    const chip = await until(async () => (await banner.chip()) ?? null, 'work chip on screen')
    expect(chip.profile).toBe('work')
    const entry = (await monitorList(app.main)).find((e) => e.kind === 'root' && e.agentId === sid)!
    expect(chip.text).toBe(entry.displayName)
  })

  it('AM-13 点标记三联动（面板关着时）：面板开 + agents tab 激活 + 按本会话筛选（AM-3 根行被筛掉）', async () => {
    const sid = sids.banner
    // 活动会话换回 AM-11 的（AM-12 把活动会话切去了项目会话）
    expect(await sidebar.openSession('AM-11 banner lane')).toBe(true)
    await pane.close()
    expect(await pane.isOpen()).toBe(false)

    await until(async () => (await banner.chip()) ?? null, 'chip back on screen')
    await banner.clickChip()

    // agents tab 可见 ⟺ 面板开着且 tab 激活（一条判据证两件）
    await until(() => pane.agentsActive(), 'agents tab activated by chip click')
    const filter = await until(
      async () => (await pane.filterChip()) ?? null,
      'session filter chip on screen'
    )
    expect(filter.label).toContain('AM-11 banner lane')

    const expected = (await monitorList(app.main)).filter((e) => e.rootSessionId === sid).length
    expect(expected).toBeGreaterThan(0)
    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === expected ? rs : null
    }, 'filtered rows match IPC count')
    expect(rows.some((r) => r.text.includes('AM-3 monitor lane'))).toBe(false)
  })

  it('AM-14 面板已开但在 widget tab 时点标记：agents tab 重新激活，筛选仍是该 sid', async () => {
    await pane.activateWidgetTab()
    expect(await pane.agentsActive()).toBe(false)

    await banner.clickChip()
    await until(() => pane.agentsActive(), 'agents tab re-activated')
    const filter = await until(
      async () => (await pane.filterChip()) ?? null,
      'filter chip still on screen'
    )
    expect(filter.label).toContain('AM-11 banner lane')
  })

  it('AM-15 相位点：hold 中绿脉冲，放行回灰', async () => {
    const sid = sids.banner
    // AM-13/14 之后活动会话仍是 AM-11 的（有 root entry，标记在屏）
    provider.script({ holdMs: 20_000, when: rootRequest('hold-1') })
    await promptTolerant(app.main, sid, 'hold-1')

    await until(async () => {
      const e = (await monitorList(app.main)).find((x) => x.agentId === sid)
      return e?.phase === 'turn' ? e : null
    }, 'root entry in turn phase')
    // 标记的相位灯与面板同一套轮询（1s）—— until 等绿脉冲上屏
    await until(async () => {
      const chip = await banner.chip()
      return chip?.pulsing && chip.phaseClass.includes('bg-emerald-500') ? chip : null
    }, 'chip dot green-pulsing on screen')

    provider.release()
    await idleEntry(sid, 'root entry back to idle')
    await until(async () => {
      const chip = await banner.chip()
      return chip && !chip.pulsing && chip.phaseClass.includes('bg-text-tertiary/40') ? chip : null
    }, 'chip dot back to gray')
  })

  it('AM-16 筛选含派生 entry（root + spawned，spawned 带血缘箭头）；点 X 清除后恢复全量', async () => {
    const sid = await openAndPrompt('AM-16 lineage lane', 'lin-2')
    // echo hook 已装：这轮自动派生 echo-agent —— 等它跑完回 idle，筛选时才是稳定的 2 条
    await until(async () => {
      const e = (await monitorList(app.main)).find(
        (x) => x.kind === 'spawned' && x.rootSessionId === sid
      )
      return e?.phase === 'idle' ? e : null
    }, 'spawned echo agent back to idle')

    await until(async () => (await banner.chip()) ?? null, 'chip on screen')
    await banner.clickChip()
    await until(() => pane.agentsActive(), 'agents tab activated')

    const filtered = (await monitorList(app.main)).filter((e) => e.rootSessionId === sid)
    expect(filtered.length).toBe(2)
    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === 2 ? rs : null
    }, 'filtered rows = root + spawned')
    expect(rows.filter((r) => r.arrow).length).toBe(1)

    await pane.clearFilter()
    expect(await pane.filterChip()).toBeNull()
    // 只比数量不钉名单：全量里有 AM-3 根与各条会话的根和它们的 echo entry
    const total = (await monitorList(app.main)).length
    await until(
      async () => (await pane.rows()).length === total || null,
      'rows restored to full list'
    )
  })

  it('AM-17 筛选空态（会话已删）+ chip 标签回落 id 截断；收尾清除筛选', async () => {
    // 先摘掉 echo hook（指纹缓存现扫，下一轮即生效，与 AM-5 落盘生效同一机制）：之后的缓存段要
    // 「无派生」的会话；F 删掉时它的行（根与派生）一起消失，不再有孤儿可滞留
    unlinkSync(join(app.hooksDir, 'echo.md'))

    const sid = await openAndPrompt('AM-17 fade lane', 'fade-1')
    await until(async () => (await banner.chip()) ?? null, 'chip on screen')
    await banner.clickChip()
    const filter = await until(
      async () => (await pane.filterChip()) ?? null,
      'filter chip on screen'
    )
    expect(filter.label).toContain('AM-17 fade lane')

    // 切去别的会话（筛选不随会话切换复位 —— store 注释明示的设计），再删 F
    expect(await sidebar.openSession('AM-11 banner lane')).toBe(true)
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(
      async () => !(await monitorList(app.main)).some((e) => e.rootSessionId === sid) || null,
      'no monitor entry for the deleted session'
    )

    await until(async () => (await pane.rows()).length === 0 || null, 'filtered list empty')
    const empty = await until(async () => (await pane.emptyText()) || null, 'filtered empty state')
    // 筛选空态 ≠ AM-1 记下的通用空态（两条不同的 i18n 键；只比不等，不钉文案）
    expect(genericEmptyText.length).toBeGreaterThan(0)
    expect(empty).not.toBe(genericEmptyText)
    // 条目已消失 → chip 标签从会话标题回落成 id 截断
    const retained = await until(
      async () => (await pane.filterChip()) ?? null,
      'filter chip retained'
    )
    expect(retained.label).toBe(`${sid.slice(0, 8)}…`)

    await pane.clearFilter()
  })

  // ── AM-18 ~ AM-22：提示词缓存命中率 ──
  // 共用会话 `sids.cache`，累计逐条往后接（见文件头）。此刻 echo hook 已在 AM-17 摘掉，
  // 这条会话的轮次不会派生任何 agent；标题显式给出，不触发 auto-title。

  /** AM-18 记下的「尚无用量」原文 —— 只用来与 AM-19 的「未上报」比不等，不钉内容 */
  let noneText = ''
  /** AM-19 记下的「未上报」悬停说明 —— AM-20 断言百分数状态的悬停口径换了一句 */
  let unreportedTitle = ''

  /** 缓存会话的根 entry（IPC）；缺席即抛，给 until 当「未就绪」 */
  const cacheEntry = async (): Promise<MonitorEntry> => {
    const e = (await monitorList(app.main)).find((x) => x.agentId === sids.cache)
    if (!e) throw new Error('no monitor entry for the cache lane')
    return e
  }

  /** 等缓存会话回到 idle，且累计的未命中输入到了 `input`（这一轮的用量已记进 `pi.usage`） */
  const settledCacheEntry = (input: number): Promise<MonitorEntry> =>
    until(async () => {
      const e = await cacheEntry()
      return e.phase === 'idle' && e.cache.input === input ? e : null
    }, `cache lane idle with cache.input ${input}`)

  /** 筛选后唯一的那一行，等它的命中率格显示成 `text` */
  const cacheRowShowing = (text: string): Promise<NonNullable<AgentMonitorRowShot['cache']>> =>
    until(async () => {
      const rows = await pane.rows()
      return rows.length === 1 && rows[0].cache?.text === text ? rows[0].cache : null
    }, `cache cell shows "${text}"`)

  /** 展开唯一的那一行，等详情两格满足 `ready`，读完收起 */
  const readCacheFields = async (
    ready: (f: { total: string; last: string }) => boolean
  ): Promise<{ total: string; last: string }> => {
    await pane.clickRow(0)
    await until(() => pane.detailOpen(0), 'cache lane detail expanded')
    const fields = await until(async () => {
      const f = await pane.detailCacheFields(0)
      return f && ready(f) ? f : null
    }, 'cache fields in the detail')
    await pane.clickRow(0)
    await until(async () => !(await pane.detailOpen(0)) || null, 'cache lane detail collapsed')
    return fields
  }

  it('AM-18 尚无用量：hold 中 IPC cache 全 0 且没有 last；行里是空占位，详情两格同一句非百分数的说明', async () => {
    const sid = await createSession('AM-18 cache lane')
    sids.cache = sid
    await until(
      async () => (await sidebar.openSession('AM-18 cache lane')) || null,
      'AM-18 session opened'
    )
    provider.script({
      text: 'c1',
      holdMs: 20_000,
      usage: { prompt: 400, completion: 5, cached: 0 },
      when: rootRequest('cache-1')
    })
    await promptTolerant(app.main, sid, 'cache-1')

    // hold 中：内容片已发，回复还没落成条目 —— 这一刻 agent 已在跑、`pi.usage` 却还是空的
    const entry = await until(async () => {
      const e = await cacheEntry()
      return e.phase === 'turn' ? e : null
    }, 'cache lane in turn phase')
    expect(entry.cache).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, reported: false })
    expect('last' in entry.cache).toBe(false)

    // 横幅 chip 按本会话筛选，列表只剩这一行
    await until(async () => (await banner.chip()) ?? null, 'chip on screen')
    await banner.clickChip()
    await until(
      async () => (await pane.filterChip())?.label.includes('AM-18 cache lane') || null,
      'filter on the cache lane'
    )
    const row = await until(async () => {
      const rows = await pane.rows()
      return rows.length === 1 ? rows[0] : null
    }, 'only the cache lane row')
    expect(row.text).toContain('AM-18 cache lane')
    expect(row.cache).toBeNull()

    const fields = await readCacheFields((f) => f.total !== '')
    expect(fields.last).toBe(fields.total)
    expect(fields.total).not.toContain('%')
    expect(fields.total).not.toMatch(/\d/)
    noneText = fields.total

    provider.release()
    await until(
      async () => (await cacheEntry()).phase === 'idle' || null,
      'cache lane back to idle'
    )
  })

  it('AM-19 有调用、从未上报缓存：累计照记但 reported 为 false，行里是「—」，详情是与「尚无」不同的一句', async () => {
    // AM-18 那一轮带 cached_tokens: 0（上报了 0）—— 与「不上报」一样只能读作未知
    const entry = await settledCacheEntry(400)
    expect(entry.cache).toEqual({
      input: 400,
      cacheRead: 0,
      cacheWrite: 0,
      reported: false,
      last: { input: 400, cacheRead: 0, cacheWrite: 0 }
    })
    expect(entry.contextTokens).toBe(405)

    const cell = await cacheRowShowing('—')
    expect(cell.title).not.toBe('')
    unreportedTitle = cell.title

    const fields = await readCacheFields((f) => f.total !== '' && f.total !== noneText)
    expect(fields.last).toBe(fields.total)
    expect(fields.total).not.toContain('%')
    expect(noneText).not.toBe('')
    expect(fields.total).not.toBe(noneText)

    // 「根本不上报」那一半：AM-3 的根跑的轮次没带 usage，provider 压根没发 usage 块
    const root = (await monitorList(app.main)).find((e) => e.agentId === sids.root)
    expect(root).toBeDefined()
    expect(root!.cache.reported).toBe(false)
  })

  it('AM-20 命中率按 token 加权累计、最近一次单算，reported 置真后不回落', async () => {
    const sid = sids.cache

    // 第二轮：prompt 600 里命中 300（pi 从 prompt_tokens 里扣掉 cached → input 300）
    provider.script({
      text: 'c2',
      usage: { prompt: 600, completion: 5, cached: 300 },
      when: rootRequest('cache-2')
    })
    await promptTurn(sid, 'cache-2')
    const second = await settledCacheEntry(700)
    expect(second.cache).toEqual({
      input: 700,
      cacheRead: 300,
      cacheWrite: 0,
      reported: true,
      last: { input: 300, cacheRead: 300, cacheWrite: 0 }
    })
    expect(second.contextTokens).toBe(605)

    // 300 / 1000 = 30%：「每次比例取平均」得 25%，「只看最近一次」得 50%
    const cell = await cacheRowShowing('30%')
    expect(cell.title).not.toBe('')
    expect(cell.title).not.toBe(unreportedTitle)

    const fields = await readCacheFields((f) => f.total.includes('30.0%'))
    // 累计不再插调用次数（PIN-03：账本没有调用计数）
    expect(fields.total).toBe('30.0%')
    expect(fields.last).toBe('50.0%')

    // 第三轮：上报了、但一次没命中 —— reported 不回落，最近一次是真 0%
    provider.script({
      text: 'c3',
      usage: { prompt: 500, completion: 5, cached: 0 },
      when: rootRequest('cache-3')
    })
    await promptTurn(sid, 'cache-3')
    const third = await settledCacheEntry(1200)
    expect(third.cache).toEqual({
      input: 1200,
      cacheRead: 300,
      cacheWrite: 0,
      reported: true,
      last: { input: 500, cacheRead: 0, cacheWrite: 0 }
    })
    expect(third.contextTokens).toBe(505)

    await cacheRowShowing('20%')
    const after = await readCacheFields((f) => f.total.includes('20.0%'))
    expect(after.total).toBe('20.0%')
    expect(after.last).toBe('0.0%')
  })

  it('AM-21 中止的那一轮（用量没到）不改缓存与上下文占用；零内容空回复计入（PIN-03 / PIN-04：它也是花费）', async () => {
    const sid = sids.cache
    const before = await settledCacheEntry(1200)
    expect(before.contextTokens).toBe(505)

    // 中止：部分文本已发（content 非空），usage 块还没发（OpenAI 系的 usage 在流的最后）
    provider.script({
      text: 'partial',
      holdMs: 20_000,
      usage: { prompt: 70, completion: 2, cached: 60 },
      when: rootRequest('cache-abort')
    })
    await promptTolerant(app.main, sid, 'cache-abort')
    await until(() => provider.holding() || null, 'abort turn held by the provider')
    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    const aborted = await until(async () => {
      const e = await cacheEntry()
      return e.phase === 'idle' && !provider.holding() ? e : null
    }, 'cache lane idle after the aborted turn')
    expect(aborted.cache).toEqual(before.cache)
    expect(aborted.contextTokens).toBe(505)
    expect('counters' in aborted).toBe(false)

    // 零内容空回复（放在最后：空 assistant 会进下一次请求的历史）。text '' 经适配器不建块，
    // content 是 []；它的用量（prompt 50）照样记进账本 —— 累计 1250，最近一次与上下文占用都是它
    provider.script({
      text: '',
      usage: { prompt: 50, completion: 1, cached: 0 },
      when: rootRequest('cache-empty')
    })
    await promptTurn(sid, 'cache-empty')
    const empty = await settledCacheEntry(1250)
    expect(empty.cache).toEqual({
      input: 1250,
      cacheRead: 300,
      cacheWrite: 0,
      reported: true,
      last: { input: 50, cacheRead: 0, cacheWrite: 0 }
    })
    expect(empty.contextTokens).toBe(51)

    // 300 / 1550 ≈ 19%
    await cacheRowShowing('19%')

    await pane.clearFilter()
  })

  it('AM-23 花费：自定义 provider 的模型没有价格 —— IPC cost 与 sessionCost 都是 0；行里花费格是「—」，悬停是「未定价」说明', async () => {
    const entry = await cacheEntry()
    expect(entry.cost).toEqual({ total: 0 })
    expect(entry.sessionCost).toBe(0)
    const total = (await monitorList(app.main)).length
    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === total ? rs : null
    }, 'rows restored to the full list')
    const row = rows.find((r) => r.text.includes('AM-18 cache lane'))
    expect(row?.cost?.text).toBe('—')
    expect(UNPRICED_TITLES).toContain(row?.cost?.title)
  })

  it('AM-22 窄面板（320px）：全量列表收起与展开时都不横向溢出（行里多了命中率格与花费格）', async () => {
    await pane.setPanelWidth(320)
    // 全量列表：AM-3 的根、各条会话的根与它们的 echo 派生行、带命中率格的缓存会话行
    const total = (await monitorList(app.main)).length
    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === total ? rs : null
    }, 'rows restored to the full list')
    const idx = rows.findIndex((r) => r.text.includes('AM-18 cache lane'))
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(rows[idx].cache?.text).toBe('19%')
    expect(await pane.listOverflowsX()).toBe(false)

    // 展开详情（两格命中率在里面）同样不能撑破宽度
    await pane.clickRow(idx)
    await until(() => pane.detailOpen(idx), 'cache lane detail expanded at 320px')
    await until(
      async () => (await pane.detailCacheFields(idx))?.total.includes('19.4%') || null,
      'cache fields rendered at 320px'
    )
    expect(await pane.listOverflowsX()).toBe(false)
    await pane.clickRow(idx)
    await until(async () => !(await pane.detailOpen(idx)) || null, 'cache lane detail collapsed')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 组三：重启 —— 只列打开着的会话（Q-P3-08），重开的会话里闲着的历史 agent 不列（PIN-02）

describe('重启：只列打开着的会话', () => {
  let app: E2EApp | undefined
  let provider: FakeProvider

  beforeAll(async () => {
    provider = await startFakeProvider()
    app = await launchApp()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)
  })
  afterAll(async () => {
    await provider?.close()
    await app?.stop()
  })

  it('AM-24 重开之后：没看过的会话不列（尽管它锁着）；侧栏打开它根行才出现；它从前的 echo 子 agent 不列', async () => {
    const first = app!
    writeAgentMd(first, 'echo-agent', { tools: 'read', body: 'ECHO AGENT BODY.' })
    mkdirSync(first.hooksDir, { recursive: true })
    writeFileSync(join(first.hooksDir, 'echo.md'), ECHO_HOOK_MD)
    const sid = await first.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'AM-24 restart lane' })}).then((s) => s.id)`
    )
    provider.script(
      { text: 'r1', when: rootRequest('restart-1') },
      { text: 'echo-r', when: echoRequest(sid) }
    )
    await promptAndSettle(first.main, sid, 'restart-1')
    const child = await until(async () => {
      const e = (await monitorList(first.main)).find(
        (x) => x.kind === 'spawned' && x.rootSessionId === sid
      )
      return e?.phase === 'idle' ? e : null
    }, 'echo child idle before the restart')
    // 活动会话换成一条没锁的新会话：重开时渲染端恢复的若是它，打开它也不会列出任何 agent
    await first.main.eval(
      `window.api.session.create(${JSON.stringify({ title: 'AM-24 other lane' })}).then((s) => s.id)`
    )
    const sidebar1 = sidebarPane(first.main)
    await until(
      async () => (await sidebar1.openSession('AM-24 other lane')) || null,
      'other lane opened before the restart'
    )

    const home = first.home
    await first.stop({ keepHome: true })
    app = undefined
    app = await launchApp({ home })
    await waitRendererReady(app.main)
    const main = app.main

    // 让监视轮询有机会走一拍；锁着的那条没被打开，列表里不该有它
    await sleep(1200)
    expect(await monitorList(main)).toEqual([])

    const sidebar = sidebarPane(main)
    await until(
      async () => (await sidebar.openSession('AM-24 restart lane')) || null,
      'restart lane opened after the restart'
    )
    const root = await until(
      async () => (await monitorList(main)).find((e) => e.agentId === sid) ?? null,
      'root row after opening the session'
    )
    expect(root.kind).toBe('root')
    expect(root.phase).toBe('idle')
    const list = await monitorList(main)
    expect(list.some((e) => e.agentId === child.agentId)).toBe(false)
    expect(list.filter((e) => e.rootSessionId === sid).map((e) => e.kind)).toEqual(['root'])
  })
})
