/**
 * 智能体监视端到端（隔离实例）—— 主窗 RightPanel 的 agents tab（AgentMonitorPanel）
 * 与设置窗口「监视器」页的回落，外加对话区顶部状态横幅（StatusBanner）的 profile 标记
 * （AgentProfileChip）与监视面板的联动（AM-10 ~ AM-17）。
 *
 * 实例复用（减少启动开销，故两组用例收在同一文件）：
 *   - 组一（AM-1/2/10/8/9）：无 provider 的全新实例 —— 空态、tab 存在性、未发消息的
 *     新会话横幅缺席、设置页形态与旧 hash 回落；
 *   - 组二（AM-3~7、AM-11~17）：fakeProvider 实例 —— 根 agent 上屏、相位灯、血缘缩进、
 *     孤儿徽章、详情手风琴，以及横幅标记的出现/相位/点击三联动/筛选 chip。
 *     注意 **turn-completed 的 echo hook 到 AM-5 才种进 hooksDir**：AM-3 断的是「恰一条」，
 *      hook 若 beforeAll 就装好，首轮收尾就会多出一个派生 entry（hooksDir 是指纹缓存的现扫，
 *     中途落盘下一轮即生效，见 hookService.scanCache）；AM-17 反向利用同一机制 —— 先摘掉
 *      hook 再发 F 的首轮，才能造出「无派生」的会话。
 *
 * 观测面：列表 / 详情数据一律走 IPC（`agent.monitorList` / `agent.monitorDetail`），DOM 只断
 * 呈现（相位灯配色与脉冲、孤儿徽章、血缘箭头、空态在屏、手风琴展开态、横幅标记）；空态/徽章
 * 文案是 i18n 产物，只认结构与非空（AM-17 的「筛选空态 ≠ 通用空态」是同实例内的文案比对，
 * 不钉具体句子）。用例有顺序依赖：AM-4 续 AM-3 的会话，AM-6 删 AM-5 的会话，
 * AM-7 用 AM-3 的根 + AM-6 留下的孤儿做手风琴互斥；AM-13~15 续 AM-11 的会话，
 * 所有「恰 N 条」断言都按 sid 过滤做相对比较，不做全量计数。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  chatPane,
  monitorSettingsPane,
  rightPanelPane,
  sidebarPane,
  statusBannerPane,
  type RightPanelPane,
  type SidebarPane,
  type StatusBannerPane
} from '../../harness/pages'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const TURN_COMPLETED = 'session.turn-completed'
const ECHO_BODY = 'E2E monitor echo hook.'

/**
 * AM-1 记下的通用空态原文（无任何运行时那条），供 AM-17 做「筛选空态文案不同」的比对 ——
 * 跨 describe（两个实例）共享，故挂在模块级；文案本身是 i18n 产物，只比不等、不钉内容。
 */
let genericEmptyText = ''

interface MonitorEntry {
  agentId: string
  kind: string
  rootSessionId: string
  depth: number
  profileName: string
  phase: string
  rootSessionTitle?: string
  rootSessionExists: boolean
  counters: { turns: number }
  model: { id: string }
}

interface MonitorDetail {
  systemPrompt: string
  tools: unknown[]
  messageCount: number
}

const monitorList = (main: CdpClient): Promise<MonitorEntry[]> =>
  main.eval('window.api.agent.monitorList()')
const monitorDetail = (main: CdpClient, agentId: string): Promise<MonitorDetail | null> =>
  main.eval(`window.api.agent.monitorDetail(${JSON.stringify(agentId)})`)

/** 发 prompt 不等它、失败也吞掉（轮次收尾另由 agent_end 等） */
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
    // 面板已在 AM-1 打开；可见集合 = browser / widget / calendar / agents
    expect(await pane.tabIcons()).toEqual([
      'lucide-monitor',
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
// 组二：fakeProvider 实例 —— 上屏 / 相位灯 / 血缘 / 孤儿 / 详情手风琴

describe('fakeProvider：运行时的上屏、相位、血缘与详情', () => {
  let app: E2EApp
  let provider: FakeProvider
  let events: EventRecorder
  let pane: RightPanelPane
  let banner: StatusBannerPane
  let sidebar: SidebarPane
  const sids: Record<string, string> = {}

  beforeAll(async () => {
    app = await launchApp()
    provider = await startFakeProvider()
    await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
    await waitRendererReady(app.main)
    events = eventRecorder(app.main)
    await events.install()
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

  /** 发一轮并等根会话这一轮收尾（agent_end 是流式游标：每轮恰好等到自己那一条） */
  const promptTurn = async (sid: string, text: string): Promise<void> => {
    await promptTolerant(app.main, sid, text)
    await events.waitFor('agent_end', { sessionId: sid })
  }

  it('AM-3 根 agent 上屏：恰一条 root entry（id = rootSessionId = sid、idle、模型 id、会话标题），行内无孤儿徽章与血缘箭头', async () => {
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
    expect(entry.rootSessionExists).toBe(true)
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
    expect(row.orphan).toBe(false)
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
    // turns 在 agent_start（轮开始）即 +1（runtimeRegistry.reduce），不是轮收尾 ——
    // hold 中的第二轮已记为 2。用例清单写「仍为 1」是按「完成的轮数」理解的，与实现语义不符
    expect(entry.counters.turns).toBe(2)

    // DOM 每秒轮询才跟上 —— until 等到脉冲上屏（此刻列表里仍只有这一行）
    const row = await until(async () => {
      const rows = await pane.rows()
      return rows.length === 1 && rows[0].pulsing ? rows[0] : null
    }, 'phase dot pulsing on screen')
    expect(row.phaseClass).toContain('bg-emerald-500')

    provider.release()
    await events.waitFor('agent_end', { sessionId: sid })
    await until(
      async () =>
        (await monitorList(app.main)).find((x) => x.agentId === sid)?.phase === 'idle' || null,
      'root entry back to idle'
    )
  })

  it('AM-5 血缘：turn-completed hook 派生的 agent 缩进跟随根行（同 rootSessionId、紧随其后、只有它有血缘箭头）', async () => {
    // hook 此刻才落盘：AM-3/AM-4 的轮次不能派生任何 agent（AM-3 的「恰一条」靠这个成立）
    writeAgentMd(app, 'echo-agent', { tools: 'read', body: 'ECHO AGENT BODY.' })
    mkdirSync(app.hooksDir, { recursive: true })
    writeFileSync(
      join(app.hooksDir, 'echo.md'),
      [
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
    )

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

    const rows = await until(async () => {
      const rs = await pane.rows()
      return rs.length === list.length ? rs : null
    }, 'monitor rows match the list')
    expect(rows[rootIdx].arrow).toBe(false)
    expect(rows[spawnIdx].arrow).toBe(true)
    expect(await pane.rowsAdjacent(rootIdx, spawnIdx)).toBe(true)
  })

  it('AM-6 孤儿徽章：删根会话后根 entry 注销、派生 entry 滞留成孤儿（rootSessionExists=false）；展开孤儿详情不得有未捕获异常', async () => {
    const sid = sids.lineage
    const before = await monitorList(app.main)
    const spawnedId = before.find((e) => e.kind === 'spawned' && e.rootSessionId === sid)!.agentId
    sids.orphan = spawnedId
    const errorsBefore = await app.main.eval<string[]>('window.__e2e ?? []')

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(
      async () => !(await monitorList(app.main)).some((e) => e.agentId === sid) || null,
      'root entry deregistered'
    )

    const orphan = await until(async () => {
      const e = (await monitorList(app.main)).find((x) => x.agentId === spawnedId)
      return e && !e.rootSessionExists ? e : null
    }, 'spawned entry orphaned')
    expect(orphan.rootSessionTitle).toBeUndefined()

    // 根 entry 消失后下标移位 —— 重新对快照取孤儿行的下标再断 DOM。
    // 注意 until 把 0 当「未就绪」，所以这里只回 boolean，下标落定后再取
    await until(async () => {
      const list = await monitorList(app.main)
      const i = list.findIndex((e) => e.agentId === spawnedId)
      if (i < 0) return null
      const rows = await pane.rows()
      return (rows.length === list.length && rows[i].orphan) || null
    }, 'orphan badge on the spawned row')
    const finalList = await monitorList(app.main)
    const orphanIdx = finalList.findIndex((e) => e.agentId === spawnedId)
    expect((await pane.rows())[orphanIdx].orphanText).not.toBe('')

    // 附加断言（设计钦定）：孤儿 entry 展开一次 —— 详情仍可取或明确「不可用」两种结果都接受，
    // 但不得有未捕获异常（页内取证缓冲 window.__e2e 不得多长一条）
    await pane.clickRow(orphanIdx)
    await until(() => pane.detailOpen(orphanIdx), 'orphan detail expanded')
    const detail = await monitorDetail(app.main, spawnedId)
    if (detail) expect(typeof detail.systemPrompt).toBe('string')
    expect(await app.main.eval<string[]>('window.__e2e ?? []')).toEqual(errorsBefore)
    // 收起复原，把手风琴的干净起点留给 AM-7
    await pane.clickRow(orphanIdx)
    await until(async () => !(await pane.detailOpen(orphanIdx)) || null, 'orphan detail collapsed')
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

    // 此刻列表 = AM-3 的根 + AM-6 留下的孤儿，两行正好够断互斥
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

  // ── AM-11 ~ AM-17：对话区状态横幅的 profile 标记（AgentProfileChip）与监视面板联动 ──
  // 此刻 echo hook 已装（AM-5），每条新会话的首轮都会自动派生一个 echo-agent（无脚本匹配
  // 时 fakeProvider 回默认 "OK" 收尾）；列表里还有 AM-3 的根与 AM-6 的孤儿 —— 故所有
  // 「恰 N 条」都按 sid 过滤做相对比较，不做全量计数。

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

  it('AM-11 首轮后标记出现：内容 = profileName（chat），idle 灰点不脉冲，横幅在屏', async () => {
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
    expect(chip.text).toBe('chat')
    // 与 IPC 该 root entry 的 profileName 同源
    expect(chip.text).toBe(entry.profileName)
    expect(await banner.bannerPresent()).toBe(true)
  })

  it('AM-12 项目会话的标记显示 work（与 IPC profileName 一致）', async () => {
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
    expect(chip.text).toBe('work')
    const entry = (await monitorList(app.main)).find((e) => e.kind === 'root' && e.agentId === sid)!
    expect(chip.text).toBe(entry.profileName)
  })

  it('AM-13 点标记三联动（面板关着时）：面板开 + agents tab 激活 + 按本会话筛选（AM-3 根行与孤儿行被筛掉）', async () => {
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
    expect(rows.some((r) => r.orphan)).toBe(false)
  })

  it('AM-14 面板已开但在 browser tab 时点标记：agents tab 重新激活，筛选仍是该 sid', async () => {
    await pane.activateBrowserTab()
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
    await events.waitFor('agent_end', { sessionId: sid })
    await until(
      async () =>
        (await monitorList(app.main)).find((x) => x.agentId === sid)?.phase === 'idle' || null,
      'root entry back to idle'
    )
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
    // 只比数量不钉名单：全量里有 AM-3 根、AM-6 孤儿与各轮留下的 echo entry
    const total = (await monitorList(app.main)).length
    await until(
      async () => (await pane.rows()).length === total || null,
      'rows restored to full list'
    )
  })

  it('AM-17 筛选空态（会话已删）+ chip 标签回落 id 截断；收尾清除筛选', async () => {
    // F 要「无派生」：echo hook 还装着的话这一轮必然多一个 echo-agent entry，它随根会话
    // 删除滞留成孤儿（rootSessionId 仍是 F），「无 entry」永远等不到 —— 先摘掉 hook
    // （指纹缓存现扫，下一轮即生效，与 AM-5 落盘生效同一机制）
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
})
