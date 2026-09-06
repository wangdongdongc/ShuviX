/**
 * A0 · Bot 会话最小可聊面 —— 侧栏入口 + 选 bot 对话框 + 创建流（B 组）。
 *
 * 被测面：SessionGroup 分组头菜单里的「新建 Bot 会话」入口（与「新建对话」同一份菜单）、
 * BotSessionDialog 的 create 场合（空态出路 / **单选，点行即建** / 项目归属提示 / 防重入）、
 * 创建后的会话形态（projectId + `settings.bot`，没有群聊时代的 `bots` 名单）与侧栏行呈现
 * （活动态 + bot 图标）。会话是一对一的，对话框里没有勾选态、没有创建钮。
 *
 * 全程无 LLM：创建 Bot 会话只落库，不碰任何模型 —— 也**不播开场白**，
 * 新会话零条消息（B1 顺带钉住）。
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
): Promise<{ id: string; projectId: string | null; settings: { bot?: string; bots?: string[] } }> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)})`)

const botNames = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.bot.list().then((bs) => bs.map((b) => b.name))`)

/** 该会话的消息条数（新会话恒为 0 —— 没有开场白） */
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
  it('项目组头菜单里有 Bot 入口，与「新建对话」同处一份菜单', async () => {
    const items = await sidebar.groupMenuItems({ project: PROJECT_NAME })
    expect(items).not.toBeNull()
    expect(items).toContain('new-chat')
    expect(items).toContain('new-bot-chat')
  })

  // A0-12 —— 本 spec 第一个打开对话框的用例：bots 目录必须还是空的
  it('bots 目录为空时的空态：无 bot 行、「打开 Bots 文件夹」在屏；对话框是 create 场合', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()

    expect(await dialog.isOpen()).toBe(true)
    expect(await dialog.mode()).toBe('create')
    expect(await dialog.rows()).toEqual([])
    // 只断存在，绝不点击 —— 点了会真的弹系统文件管理器
    expect((await dialog.emptyState()).openFolderButton).toBe(true)

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

describe('bot 列表与单选创建', () => {
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

  // B1（顶替 A0-16 / A0-17：没有多选与创建钮，点行即建）
  it('B1 项目组全链路：create 场合、页脚项目名在屏且无警示块、行 = bot.list()；点一行 → 恰一个新会话：settings.bot、无 bots、projectId、零条消息、侧栏活动行带 bot 图标', async () => {
    const names = await botNames()

    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()
    // 场合与归属页脚：create、显示种子项目名，且没有「无项目」警示块
    expect(await dialog.mode()).toBe('create')
    expect(await dialog.projectLabelText()).toBe(PROJECT_NAME)
    expect(await dialog.noProjectHintShown()).toBe(false)
    expect((await dialog.rows()).map((r) => r.name)).toEqual(names)

    const created = await newSessionsAfter(async () => {
      // 单选：点行即创建，成功后对话框自关
      expect(await dialog.pick('b-echo')).toBe(true)
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)

    const session = await getSession(created[0])
    expect(session.projectId).toBe(project.id)
    // 绑定是一个名字，不是名单：一对一会话只写 `bot`
    expect(session.settings.bot).toBe('b-echo')
    expect(session.settings.bots).toBeUndefined()
    // 建会话不播开场白 —— 对话从用户的第一句开始
    expect(await messageCount(created[0])).toBe(0)

    // 侧栏：新行成为活动会话（bg-bg-active）且行图标是 bot
    await until(() => sidebar.activeRowIsBot(), 'new bot session row active with bot icon')
  })
})

describe('创建流（临时组 / 防重入）', () => {
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
    // 临时组没有项目 —— 警示块（bot 的文件操作落在主目录）必须在屏
    expect(await dialog.noProjectHintShown()).toBe(true)

    const created = await newSessionsAfter(async () => {
      expect(await dialog.pick('b-relay')).toBe(true)
      await dialog.waitClosed()
    })
    expect(created).toHaveLength(1)
    const session = await getSession(created[0])
    expect(session.projectId).toBeNull()
    expect(session.settings.bot).toBe('b-relay')

    // 对照：那条普通临时会话的行没有 bot 图标
    expect(await sidebar.rowIsBot('plain-temp-chat')).toBe(false)
  })

  // A0-19 —— 若真建出两个会话：这是产品防重入缺陷，上报，勿改断言
  it('同一次 eval 里连点同一行两下只建一个会话', async () => {
    await sidebar.clickNewBotChat({ project: PROJECT_NAME })
    await dialog.waitOpen()

    const created = await newSessionsAfter(async () => {
      expect(await dialog.pickDoubleClick('b-echo')).toBe(true)
      await dialog.waitClosed()
      // 若第二击真的漏进来，session.create 是异步的 —— 给它冒头的时间再点名
      await sleep(600)
    })
    expect(created).toHaveLength(1)
  })
})
