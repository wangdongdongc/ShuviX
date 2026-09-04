/**
 * A0 · Bot 会话最小可聊面 —— 侧栏入口 + 成员多选对话框 + 创建流（B 组）。
 *
 * 被测面：SessionGroup 分组头的「新建 Bot 会话」入口（.lucide-bot 与
 * .lucide-message-square-plus 并排）、BotSessionDialog（空态出路 / 成员多选 /
 * 项目归属提示 / 防重入）、创建后的会话形态（projectId + settings.bots）与
 * 侧栏行呈现（活动态 + bot 图标）。
 *
 * 全程无 LLM：创建 Bot 会话只落库，不碰任何模型 —— v3 起也**不播开场白**，
 * 新会话零条消息（A0-16 顺带钉住）。
 * bot md 在用例内按需播种（A0-12/13 依赖 bots 目录为空，**必须**排在播种之前）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject, waitRendererReady, writeBotMd } from '../../harness/seed'
import {
  botDialogPane,
  sidebarPane,
  type BotDialogPane,
  type SidebarPane
} from '../../harness/pages'

const PROJECT_NAME = 'BotUIProj'

let app: E2EApp
let sidebar: SidebarPane
let dialog: BotDialogPane
let project: { id: string }

const listSessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

const getSession = (
  sid: string
): Promise<{ id: string; projectId: string | null; settings: { bots?: string[] } }> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)

const botNames = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.bot.list().then((bs) => bs.map((b) => b.name))`)

/** 该会话的消息条数（v3 新会话恒为 0 —— 没有开场白） */
const messageCount = (sid: string): Promise<number> =>
  app.main.eval<number>(`window.api.message.list(${JSON.stringify(sid)}).then((ms) => ms.length)`)

/** 记录当前会话 id 集，执行 act 后返回新增的那些 id */
async function newSessionsAfter(act: () => Promise<void>): Promise<string[]> {
  const before = await listSessionIds()
  await act()
  const after = await listSessionIds()
  return after.filter((id) => !before.includes(id))
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  dialog = botDialogPane(app.main)

  // 只种项目、不种 bot：空态用例（A0-12）要求 bots 目录此刻还是空的
  const projDir = join(app.home, 'proj-bot-ui')
  mkdirSync(projDir, { recursive: true })
  project = await createProject(app.main, { name: PROJECT_NAME, path: projDir })
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('分组头入口与对话框空态', () => {
  // A0-11
  it('项目组头悬停区有 Bot 入口，与「新建对话」并排', async () => {
    const actions = await sidebar.groupHeaderActions({ project: PROJECT_NAME })
    expect(actions).not.toBeNull()
    expect(actions!.newChat).toBe(true)
    expect(actions!.newBot).toBe(true)
    expect(actions!.sameContainer).toBe(true)
  })

  // A0-12 —— 本 spec 第一个打开对话框的用例：bots 目录必须还是空的
  it('bots 目录为空时的空态：无成员行、「打开 Bots 文件夹」在屏、创建禁用', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()

    expect(await dialog.isOpen()).toBe(true)
    expect(await dialog.rows()).toEqual([])
    // 只断存在，绝不点击 —— 点了会真的弹系统文件管理器
    expect((await dialog.emptyState()).openFolderButton).toBe(true)
    expect(await dialog.createDisabled()).toBe(true)

    await dialog.pressEscape()
    await dialog.waitClosed()
  })

  // A0-13
  it('Escape 关闭：对话框（等动画后）离开 DOM，session.list 长度不变', async () => {
    const before = (await listSessionIds()).length

    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()
    await dialog.pressEscape()
    // 关闭动画 120ms 之后才卸载 —— waitClosed 轮询等它真的离开 DOM
    await dialog.waitClosed()

    expect(await dialog.isOpen()).toBe(false)
    expect((await listSessionIds()).length).toBe(before)
  })
})

describe('成员列表与多选', () => {
  // A0-14
  it('列表 = registry 合法集：2 合法 + 1 非法 → 行名单恰等于 bot.list()', async () => {
    writeBotMd(app, 'b-echo', { description: 'echo bot', displayName: 'Echo' })
    writeBotMd(app, 'b-relay', { description: 'relay bot', displayName: 'Relay' })
    // 非法文件（description 必填却为空 + 重复键）：进 invalid 通道，不进列表
    writeBotMd(app, 'b-broken', { description: '', rawLines: ['description: '] })

    const names = await botNames()
    expect(names).toHaveLength(2)
    expect(names).not.toContain('b-broken')

    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()
    // 恰等于：成员、顺序都以 bot.list() 为准
    expect((await dialog.rows()).map((r) => r.name)).toEqual(names)

    await dialog.pressEscape()
    await dialog.waitClosed()
  })

  // A0-15
  it('勾选切换翻转 aria-checked；0 选中创建禁用，≥1 启用，取消回禁用', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()

    const [first] = await dialog.rows()
    expect(first.checked).toBe(false)
    expect(await dialog.createDisabled()).toBe(true)

    expect(await dialog.toggle(first.name)).toBe(true)
    expect((await dialog.rows()).find((r) => r.name === first.name)!.checked).toBe(true)
    expect(await dialog.createDisabled()).toBe(false)

    expect(await dialog.toggle(first.name)).toBe(true)
    expect((await dialog.rows()).find((r) => r.name === first.name)!.checked).toBe(false)
    expect(await dialog.createDisabled()).toBe(true)

    await dialog.pressEscape()
    await dialog.waitClosed()
  })

  // A0-16
  it('成员按名单顺序而非点击顺序：settings.bots 等于 bot.list() 序；新会话零条消息（无开场白）', async () => {
    const names = await botNames()

    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()
    // 故意先点靠后的、再点靠前的
    expect(await dialog.toggle(names[1])).toBe(true)
    expect(await dialog.toggle(names[0])).toBe(true)

    const created = await newSessionsAfter(async () => {
      await dialog.create()
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)

    const sid = created[0]
    expect((await getSession(sid)).settings.bots).toEqual(names)
    // v3：建会话不播开场白 —— 对话从用户的第一句开始
    expect(await messageCount(sid)).toBe(0)
  })
})

describe('创建流（项目组 / 临时组）', () => {
  // A0-17
  it('项目组全链路：页脚项目名在屏且无警示块；建出的会话 projectId+bots 正确、侧栏活动行带 bot 图标', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()

    // 归属页脚：显示种子项目名，且没有「无项目」警示块
    expect(await dialog.projectLabelText()).toBe(PROJECT_NAME)
    expect(await dialog.noProjectHintShown()).toBe(false)

    expect(await dialog.toggle('b-echo')).toBe(true)
    const created = await newSessionsAfter(async () => {
      await dialog.create()
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)

    const session = await getSession(created[0])
    expect(session.projectId).toBe(project.id)
    expect(session.settings.bots).toEqual(['b-echo'])

    // 侧栏：新行成为活动会话（bg-bg-active）且行图标是 bot
    await until(() => sidebar.activeRowIsBot(), 'new bot session row active with bot icon')
  })

  // A0-18
  it('临时组：警示块在屏；建出的会话 projectId 为 null；普通会话行无 bot 图标', async () => {
    // 先经 IPC 造一条普通临时会话（临时组因它出现），session.listChanged 广播会刷新侧栏
    await app.main.eval(`window.api.session.create({ title: 'plain-temp-chat' })`)
    await until(
      async () => (await sidebar.titles()).includes('plain-temp-chat'),
      'plain temp session listed'
    )

    await sidebar.clickNewBotChat('temp')
    await dialog.waitOpen()
    // 临时组没有项目 —— 警示块（成员文件操作落在主目录）必须在屏
    expect(await dialog.noProjectHintShown()).toBe(true)

    expect(await dialog.toggle('b-relay')).toBe(true)
    const created = await newSessionsAfter(async () => {
      await dialog.create()
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)
    expect((await getSession(created[0])).projectId).toBeNull()

    // 对照：那条普通临时会话的行没有 bot 图标
    expect(await sidebar.rowIsBot('plain-temp-chat')).toBe(false)
  })

  // A0-19 —— 若真建出两个会话：这是产品防重入缺陷，上报，勿改断言
  it('同一次 eval 里连点两下「创建」只建一个会话', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()
    expect(await dialog.toggle('b-echo')).toBe(true)

    const created = await newSessionsAfter(async () => {
      await dialog.createDoubleClick()
      await dialog.waitClosed()
      // 若第二击真的漏进来，session.create 是异步的 —— 给它冒头的时间再点名
      await sleep(600)
    })
    expect(created).toHaveLength(1)
  })
})
