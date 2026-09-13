/**
 * bot 会话的呈现（BD-5…11）—— 头部身份胶囊（BotBindingChip）、空会话里 bot 的自我介绍
 * （BotEmptyState）、侧栏行首的 bot 身份图标与子会话折叠钮（SessionItem）。
 *
 * 种子刻意让每个 bot 的 displayName ≠ name：胶囊在 `bot.list()` 回来之前顶的是身份键，回来之后
 * 才换成 displayName —— 两者一样的话，「查询落定了没有」在 DOM 上无从分辨。
 *
 * 「加载中」与「md 已删」渲染得一模一样（胶囊不标缺失、空态只留提示行不出卡片）：凡是「没有 X」
 * 的断言，都要先等一个已落定的信号、再守一段时间窗，否则只是在加载中的那一帧里侥幸为真。
 *
 * 全程无 LLM。唯一需要消息的 BD-8 走 promptAndListMessages（隔离实例无 API key，turn 在用户
 * 消息落树之后才失败 —— 同 sessions/sidebar-row-menu 的做法）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createBotSession,
  createProject,
  promptAndListMessages,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'
import {
  botChip,
  botIntro,
  chatPane,
  sidebarPane,
  type BotChipPane,
  type BotChipSnapshot,
  type BotIntroPane,
  type BotIntroSnapshot,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

const PROJECT = 'BDV-Proj'
/** 普通会话（无 bot、无项目） */
const PLAIN = 'BDV-plain'
/** 临时组里的两条 bot 会话 —— BD-5 / BD-7 在它们之间直接切换 */
const SCOUT = 'BDV-scout'
const ALPHA = 'BDV-alpha'
/** 项目组里的 bot 会话（BD-9 把组折上 —— 折叠只收高度，行仍在 DOM 里） */
const SCOUT_PROJ = 'BDV-scout-proj'
/** 绑定的 md 在任何会话被打开之前就删了 */
const GHOST = 'BDV-ghost'
/** 各用例现建的一次性夹具 */
const WITH_MSG = 'BDV-scout-msg'
const LIVE = 'BDV-live'
const BOT_PARENT = 'BDV-bot-parent'
const BOT_CHILD = 'BDV-bot-child'

let app: E2EApp
let sidebar: SidebarPane
let chip: BotChipPane
let intro: BotIntroPane
let chat: ChatPane
const sids = { plain: '', scout: '', alpha: '', scoutProj: '', ghost: '' }

/** 等某标题的行出现在侧栏（列表由 session.listChanged 广播驱动重拉） */
const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

/** 等胶囊落定到 { bot, 显示名 } 这一对 —— 名字换成 displayName 才说明这一轮查询回来了 */
const waitChip = (bot: string, name: string): Promise<BotChipSnapshot> =>
  until(async () => {
    const shot = await chip.snapshot()
    return shot.bot === bot && shot.name === name ? shot : null
  }, `header chip settled on ${bot} / "${name}"`)

/** 等胶囊标出「md 已删」（替这个 bot 查的那一轮 bot.list() 已回来的信号） */
const waitChipMissing = (bot: string, timeoutMs?: number): Promise<BotChipSnapshot> =>
  until(
    async () => {
      const shot = await chip.snapshot()
      return shot.bot === bot && shot.missing ? shot : null
    },
    `header chip for ${bot} marked missing`,
    timeoutMs
  )

/** 等空态里出现某个 bot 的自我介绍卡（卡片只在查到这个 bot 之后才渲染） */
const waitIntroCard = (bot: string): Promise<BotIntroSnapshot> =>
  until(async () => {
    const shot = await intro.snapshot()
    return shot.member === bot ? shot : null
  }, `bot intro card for "${bot}"`)

/** 在 ms 时间窗里反复取样，任何一次不成立即失败 ——「保持不出现」类断言用 */
async function expectHolds(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (!(await check())) throw new Error(`expected to hold for ${ms}ms, but broke: ${what}`)
    if (Date.now() >= deadline) return
    await sleep(100)
  }
}

const messageCount = (sid: string): Promise<number> =>
  app.main.eval<number>(`window.api.message.list(${JSON.stringify(sid)}).then((m) => m.length)`)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  chip = botChip(app.main)
  intro = botIntro(app.main)
  chat = chatPane(app.main)

  // displayName 与 name 故意不同（见文件头）；description 显式种上 —— 卡片只在它非空时才渲染描述
  writeBotMd(app, 'scout', { displayName: 'Scout Prime', description: 'BDV scout intro' })
  writeBotMd(app, 'alpha', { displayName: 'Alpha Prime', description: 'BDV alpha intro' })
  writeBotMd(app, 'ghost', { displayName: 'Ghost Display', description: '' })

  const projDir = join(app.home, 'proj-bdv')
  mkdirSync(projDir, { recursive: true })
  const { id: projectId } = await createProject(app.main, { name: PROJECT, path: projDir })

  sids.plain = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: PLAIN })}).then((s) => s.id)`
  )
  sids.scout = await createBotSession(app.main, { bot: 'scout', title: SCOUT })
  sids.alpha = await createBotSession(app.main, { bot: 'alpha', title: ALPHA })
  sids.scoutProj = await createBotSession(app.main, {
    bot: 'scout',
    title: SCOUT_PROJ,
    projectId
  })
  sids.ghost = await createBotSession(app.main, { bot: 'ghost', title: GHOST })

  // 在任何会话被打开之前删：胶囊与空态的第一次查询里它就已经不在了
  const removed = await app.main.eval<{ success: boolean; error?: string }>(
    `window.api.bot.delete({ name: 'ghost' })`
  )
  if (!removed.success) throw new Error(`seed: bot.delete(ghost) failed: ${removed.error}`)

  await until(async () => {
    const titles = await sidebar.titles()
    return [PLAIN, SCOUT, ALPHA, SCOUT_PROJ, GHOST].every((t) => titles.includes(t))
  }, 'every BDV session listed')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('头部身份胶囊', () => {
  it('BD-5 胶囊显示 displayName、跟着 bot 会话之间的切换走，普通会话上没有', async () => {
    expect(await sidebar.openSession(PLAIN)).toBe(true)
    expect((await chip.snapshot()).count).toBe(0)

    expect(await sidebar.openSession(SCOUT)).toBe(true)
    const scout = await waitChip('scout', 'Scout Prime')
    // 「不缺失」只在名字落定之后才算数（加载中同样不标缺失）
    expect(scout.missing).toBe(false)
    expect(scout.count).toBe(1)

    // 直接从 scout 切到 alpha：上一个 bot 的查询结果不许串过来
    expect(await sidebar.openSession(ALPHA)).toBe(true)
    const alpha = await waitChip('alpha', 'Alpha Prime')
    expect(alpha.missing).toBe(false)
    expect(alpha.count).toBe(1)

    expect(await sidebar.openSession(PLAIN)).toBe(true)
    await until(async () => (await chip.snapshot()).count === 0, 'chip gone on a plain session')
  })

  it('BD-6 md 已删：胶囊照常在，标缺失，名字退回绑定的身份键', async () => {
    const registry = await app.main.eval<{ bots: Array<{ name: string }> }>(`window.api.bot.list()`)
    expect(registry.bots.map((b) => b.name)).not.toContain('ghost')
    const ghost = await app.main.eval<{ settings: { bot?: string } } | null>(
      `window.api.session.getById(${JSON.stringify(sids.ghost)})`
    )
    expect(ghost?.settings.bot).toBe('ghost')

    expect(await sidebar.openSession(GHOST)).toBe(true)
    const shot = await waitChipMissing('ghost')
    expect(shot.name).toBe('ghost')
    expect(shot.count).toBe(1)
  })
})

describe('空会话里的自我介绍', () => {
  it('BD-7 空的 bot 会话由 bot 自我介绍；普通会话与 md 已删的会话没有介绍卡', async () => {
    for (const sid of [sids.scout, sids.alpha, sids.plain, sids.ghost]) {
      expect(await messageCount(sid), `messages in ${sid}`).toBe(0)
    }

    expect(await sidebar.openSession(SCOUT)).toBe(true)
    const scout = await waitIntroCard('scout')
    expect(scout.text).toContain('Scout Prime')
    expect(scout.text).toContain('BDV scout intro')

    expect(await sidebar.openSession(ALPHA)).toBe(true)
    const alpha = await waitIntroCard('alpha')
    expect(alpha.text).toContain('Alpha Prime')
    expect(alpha.text).toContain('BDV alpha intro')
    // 从 scout 直接切过来：卡片里不许留着上一个 bot 的名字
    expect(alpha.text).not.toContain('Scout Prime')

    expect(await sidebar.openSession(PLAIN)).toBe(true)
    await chat.ready()
    await until(
      async () => !(await intro.snapshot()).present,
      'no bot empty state on a plain session'
    )

    expect(await sidebar.openSession(GHOST)).toBe(true)
    // 落定信号：胶囊标出缺失 = 替 ghost 查的那一轮 bot.list() 已经回来
    await waitChipMissing('ghost')
    expect((await intro.snapshot()).present).toBe(true)
    // 空态的查询与胶囊各跑各的：再守一个时间窗，卡片始终不出现
    await expectHolds(
      'no intro card for a deleted bot',
      500,
      async () => (await intro.snapshot()).member === ''
    )
  })

  it('BD-8 会话里有了消息，自我介绍让位；胶囊仍在', async () => {
    const sid = await createBotSession(app.main, { bot: 'scout', title: WITH_MSG })
    const messages = await promptAndListMessages(app.main, sid, 'BDV hello')
    expect(
      messages.length,
      'precondition: the prompt must leave a message in the session tree'
    ).toBeGreaterThan(0)
    await waitRow(WITH_MSG)

    expect(await sidebar.openSession(WITH_MSG)).toBe(true)
    // 无提供商：turn 会失败，可能多一条错误行 —— 只要有消息行，不数种类
    await chat.waitItems(1)
    expect((await intro.snapshot()).present).toBe(false)
    await until(async () => (await chip.snapshot()).bot === 'scout', 'chip bound to scout')
  })
})

describe('侧栏行首的身份图标', () => {
  it('BD-9 bot 会话行的行首是 bot 图标（md 删了也是、在折叠的项目组里也是），普通会话行不是', async () => {
    // 折叠只把高度收成 0，行仍在 DOM 里 —— 显式折上，让「折叠组里」这半条不靠首载默认
    await sidebar.setGroupExpanded({ project: PROJECT }, false)

    expect(await sidebar.rowIcon(SCOUT)).toBe('bot')
    expect(await sidebar.rowIcon(GHOST)).toBe('bot')
    expect(await sidebar.rowIcon(SCOUT_PROJ)).toBe('bot')
    expect(await sidebar.rowIcon(PLAIN)).toBe('chat')

    // 选中换的是图标的颜色，不是图标
    expect(await sidebar.openSession(SCOUT)).toBe(true)
    expect(await sidebar.rowIcon(SCOUT)).toBe('bot')
  })
})

describe('会话开着时注册表变了', () => {
  it('BD-10 删掉正开着的会话绑定的 md：胶囊跟上标缺失，自我介绍卡也退场', async () => {
    writeBotMd(app, 'live', { displayName: 'Live One' })
    await createBotSession(app.main, { bot: 'live', title: LIVE })
    await waitRow(LIVE)
    expect(await sidebar.openSession(LIVE)).toBe(true)
    await waitChip('live', 'Live One')
    await waitIntroCard('live')

    // botService 每次落盘都广播 bot.changed —— 两个组件都得靠它重查，而不是等下次打开会话
    const removed = await app.main.eval<{ success: boolean }>(
      `window.api.bot.delete({ name: 'live' })`
    )
    expect(removed.success).toBe(true)

    await waitChipMissing('live', 5_000)
    await until(
      async () => {
        const shot = await intro.snapshot()
        return shot.present && shot.member === ''
      },
      'intro card gone after bot.changed',
      5_000
    )
  })
})

describe('bot 会话带子会话', () => {
  it('BD-11 行首保住子会话折叠钮（按钮集合与普通父行同款），且仍认得出是 bot 会话', async () => {
    const parentSid = await createBotSession(app.main, { bot: 'scout', title: BOT_PARENT })
    // 父行先上屏，子会话再建（同批到达的父子都算「新的」，那是另一条路径）
    await waitRow(BOT_PARENT)
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ parentId: parentSid, title: BOT_CHILD })})`
    )
    await until(
      async () => (await sidebar.subCountOf(BOT_PARENT)) === 1,
      'bot parent row shows 1 child'
    )

    const affordances = await sidebar.rowAffordances(BOT_PARENT)
    expect(affordances).not.toBeNull()
    expect(affordances!.buttons).toEqual(['subs-toggle', 'menu'])

    // 不断初始折叠态（新子会话触发的自动展开在一次 effect 之后才落下），只断「点它会翻转」——
    // 起点取连续两次读数一致的那个，免得读到自动展开之前的那一帧
    const before = await until(async () => {
      const first = await sidebar.subsStateOf(BOT_PARENT)
      await sleep(300)
      const second = await sidebar.subsStateOf(BOT_PARENT)
      return first !== '' && first === second ? first : null
    }, 'bot parent fold state settled')
    const flipped = before === 'expanded' ? 'collapsed' : 'expanded'
    expect(await sidebar.toggleSubs(BOT_PARENT)).toBe(true)
    await until(
      async () => (await sidebar.subsStateOf(BOT_PARENT)) === flipped,
      `bot parent row ${flipped} after the toggle`
    )

    expect(await sidebar.rowIcon(BOT_PARENT)).toBe('bot')
  })
})
