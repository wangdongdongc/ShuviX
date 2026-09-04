/**
 * 侧栏会话行的动作入口（RM）—— 一行如今只剩悬停浮现的那颗 ⋮，点它与右键整行弹的是
 * **同一份**菜单（RowMenuButton → SessionItem.onMenu → ProjectSessionGroups.openSessionMenu）。
 *
 * 三条断言口径，都是为了让「悄悄坏掉」这件事变得不可能：
 *   - 「只剩一颗 ⋮」按**按钮集合**断，不按旧图标名断。按图标名的否定断言只能证明齿轮和
 *     垃圾桶没回来，将来有人塞进一颗别的快捷按钮它一声不吭。
 *   - 「⋮ 与右键同一份」比的是桩记下的**原始 items**（id / label / separator / 顺序全比）。
 *     只比 id 挡不住真正的分叉形状 —— 两处各组装一次 items，最先分开的往往是 label。
 *   - 导出**没有任何 IPC 可断**（`useSessionExport` 整条在渲染端），故只断到边界：
 *     文件名 + Blob 正文。桌面主进程没有 will-download 监听，`<a download>` 那一击会弹
 *     原生另存为面板（e2e 关不掉，整文件挂死），故下载出口整文件顶掉，见 seed.downloadCapture。
 *
 * 行夹具一律是**临时会话**：临时组是摊开的纯分节、恒展开，不必跟项目组「首次加载默认折叠」
 * 打架；标题全局唯一（pages.ts 的行定位按标题文本认）。全程无 LLM —— 两条需要「会话里有
 * 消息」的用例走 promptAndListMessages，容忍隔离实例无 API key 的失败，只取消息落树这一个副作用。
 *
 * 不做的两件事（做不到，不是漏了）：不驱动真实 hover（CdpClient 只有 Runtime.evaluate，
 * 合成 mouseover 触发不了 CSS :hover），故 ⋮ 只断静止态 opacity 为 0；不断「右键不选中行」
 * ——合成 contextmenu 本就不触发 onClick，那是一句空断言。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { downloadCapture, promptAndListMessages, waitRendererReady } from '../../harness/seed'
import type { DownloadCapture } from '../../harness/seed'
import {
  confirmPane,
  sessionConfigPane,
  sidebarPane,
  type ConfirmPane,
  type MenuItemShot,
  type SessionConfigPane,
  type SidebarPane
} from '../../harness/pages'

/** 普通叶子会话（无子会话、无消息）—— 菜单形状与「只剩一颗 ⋮」的基准行 */
const LEAF = 'RM-叶子'
/** 笔记本会话：菜单里没有导出 */
const NOTEBOOK = 'RM-笔记本'
/** RM-05 的一对：A 保持活动，动作打在 B 上 */
const ACTIVE = 'RM-活动'
const BYSTANDER = 'RM-旁观'
/** 父行 + 两条子会话（子行菜单、菜单归属、删父确认的数量提示都靠它） */
const PARENT = 'RM-父'
const SUB_A = 'RM-子甲'
const SUB_B = 'RM-子乙'
/** 删除三条路径各自的一次性夹具 */
const EMPTY = 'RM-空会话'
const WITH_MSGS = 'RM-有消息'
const CANCEL = 'RM-取消删除'
/** 导出夹具（标题会成为文件名） */
const EXPORTED = 'RM-导出'
/** 导出会话里那条用户消息的原文 —— 要在导出的 md 里逐字找到它 */
const EXPORTED_TEXT = 'RM 导出用的一句话'

let app: E2EApp
let sidebar: SidebarPane
let sessionConfig: SessionConfigPane
let confirm: ConfirmPane
let download: DownloadCapture

let parentSid = ''
let subASid = ''
let subBSid = ''
let emptySid = ''
let withMsgsSid = ''
let cancelSid = ''

const listSessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

/** 建一条会话并回 id（临时会话：不带 projectId） */
const createSession = (opts: {
  title: string
  notebookPath?: string
  parentId?: string
}): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)

/** 等某标题的行出现在侧栏（列表由 session.listChanged 广播驱动重拉） */
const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

/** items → 便于逐项比对的序列（分隔符记成 'sep'，它没有 id） */
const idsOf = (items: MenuItemShot[] | null): string[] => (items ?? []).map((it) => it.id ?? 'sep')

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  confirm = confirmPane(app.main)
  download = downloadCapture(app.main)
  // 整文件顶掉下载出口：按用例装的话，中途一次抛错就会让后面的导出裸奔一次 ——
  // 那一次足以把整个文件挂死在一个谁也关不掉的系统面板上
  await download.install()

  for (const title of [LEAF, ACTIVE, BYSTANDER]) await createSession({ title })
  await createSession({ title: NOTEBOOK, notebookPath: 'rm-note.md' })
  const exportedSid = await createSession({ title: EXPORTED })
  emptySid = await createSession({ title: EMPTY })
  withMsgsSid = await createSession({ title: WITH_MSGS })
  cancelSid = await createSession({ title: CANCEL })

  // 父行必须**先在列表里出现**，子会话才会自动展开（判据见 autoExpandSubs：父行上一帧
  // 就在 + 这一帧冒出新子 id）。同一批到达的话父子都是「新的」，缺省折叠
  parentSid = await createSession({ title: PARENT })
  await waitRow(PARENT)
  subASid = await createSession({ title: SUB_A, parentId: parentSid })
  subBSid = await createSession({ title: SUB_B, parentId: parentSid })

  // 三条需要「会话里有消息」的夹具：容忍 LLM 失败，只要用户条目已落树
  await promptAndListMessages(app.main, withMsgsSid, 'RM 删除确认用的一句话')
  await promptAndListMessages(app.main, cancelSid, 'RM 取消删除用的一句话')
  await promptAndListMessages(app.main, exportedSid, EXPORTED_TEXT)

  await waitRow(EXPORTED)
  await until(() => sidebar.subCountOf(PARENT).then((n) => n === 2), 'parent row shows 2 children')
}, 120_000)

afterAll(async () => {
  await download.uninstall()
  await app?.stop()
})

describe('一行只剩一个入口，且 ⋮ 与右键同源', () => {
  // RM-01
  it('叶子行的按钮集合恰是 {⋮}、父行是 {折叠钮, ⋮}；静止态不可见，旧的一排小图标一个不剩', async () => {
    const leaf = await sidebar.rowAffordances(LEAF)
    expect(leaf).not.toBeNull()
    // 按集合断而不是按图标名断：塞回任何一颗新按钮，这里都会红
    expect(leaf!.buttons).toEqual(['menu'])
    expect(leaf!.legacyActionIcons).toEqual([])
    // hover 驱动不了，故只断静止态：⋮ 平时是隐形的
    expect(leaf!.menuOpacity).toBe('0')

    const parent = await sidebar.rowAffordances(PARENT)
    expect(parent).not.toBeNull()
    // 有子会话的行行首那枚图标本身就是折叠钮 —— 它是行内唯一另一颗合法按钮
    expect(parent!.buttons).toEqual(['subs-toggle', 'menu'])
    expect(parent!.legacyActionIcons).toEqual([])
  })

  // RM-02
  it('点 ⋮ 与右键整行弹的是同一份菜单（连 label 与分隔符位置都一样）', async () => {
    const viaButton = await sidebar.rowMenuShots(LEAF)
    const viaContextMenu = await sidebar.rowMenuShots(LEAF, 'contextmenu')
    expect(viaButton).not.toBeNull()
    // 深比较原始 items：分叉最先出现在 label 或 separator 上，只比 id 会放过它
    expect(viaContextMenu).toEqual(viaButton)
  })

  // RM-03
  it('普通会话行：配置 / 导出 /（分隔）/ 删除，顺序固定', async () => {
    expect(idsOf(await sidebar.rowMenuShots(LEAF))).toEqual([
      'session-config',
      'export-session',
      'sep',
      'delete-session'
    ])
  })

  // RM-04
  it('笔记本会话行没有导出（正文是那份 md，导出它没有意义）', async () => {
    const ids = idsOf(await sidebar.rowMenuShots(NOTEBOOK))
    expect(ids).toEqual(['session-config', 'sep', 'delete-session'])
    expect(ids).not.toContain('export-session')
  })
})

describe('打开菜单本身没有副作用', () => {
  // RM-05 —— 整改动最容易悄悄坏的一条：RowMenuButton 少一句 stopPropagation，
  // 点 ⋮ 就会顺手把会话切过去
  it('对另一行点 ⋮：活动会话不变、列表不变、什么弹窗都不开', async () => {
    expect(await sidebar.openSession(ACTIVE)).toBe(true)
    const before = await listSessionIds()

    await sidebar.rowMenuShots(BYSTANDER)

    expect(await sidebar.activeTitle()).toBe(ACTIVE)
    expect(await listSessionIds()).toEqual(before)
    expect(await sessionConfig.isOpen()).toBe(false)
    expect((await confirm.snapshot()).open).toBe(false)
  })
})

describe('菜单绑定的是「打开它的那一行」', () => {
  // RM-06
  it('子会话行的配置开的是子会话本身（不是父会话）', async () => {
    // 新子会话会自动展开父行；折叠只收高度不摘行，但先等展开更贴近人手操作
    await until(
      () => sidebar.subsStateOf(PARENT).then((s) => s === 'expanded'),
      'parent row expanded'
    )

    await sidebar.pickRowMenu(SUB_A, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(SUB_A)
    await sessionConfig.close()
  })

  // RM-07
  it('子会话行也有 ⋮，菜单与顶层行同款', async () => {
    const sub = await sidebar.rowAffordances(SUB_B)
    expect(sub).not.toBeNull()
    expect(sub!.buttons).toEqual(['menu'])
    expect(idsOf(await sidebar.rowMenuShots(SUB_B))).toEqual([
      'session-config',
      'export-session',
      'sep',
      'delete-session'
    ])
  })

  // RM-08
  it('session-config 打开会话配置弹窗，Escape 后离开 DOM', async () => {
    await sidebar.pickRowMenu(LEAF, 'session-config')
    await sessionConfig.waitOpen()
    expect(await sessionConfig.titleValue()).toBe(LEAF)

    await sessionConfig.close()
    expect(await sessionConfig.isOpen()).toBe(false)
  })
})

describe('delete-session', () => {
  // RM-09
  it('空会话直接删，不弹确认', async () => {
    await sidebar.pickRowMenu(EMPTY, 'delete-session')
    await until(
      async () => !(await listSessionIds()).includes(emptySid),
      'empty session deleted without confirmation'
    )

    expect((await confirm.snapshot()).open).toBe(false)
    expect(await sidebar.titles()).not.toContain(EMPTY)
  })

  // RM-10
  it('有消息的会话先弹确认，且**此刻还没删**；确认后才消失', async () => {
    await sidebar.pickRowMenu(WITH_MSGS, 'delete-session')
    await confirm.waitOpen()
    // 「还没删」才是这条用例的价值：先删再问等于没问
    expect(await listSessionIds()).toContain(withMsgsSid)

    await confirm.confirm()
    await until(
      async () => !(await listSessionIds()).includes(withMsgsSid),
      'session deleted after confirm'
    )
  })

  // RM-11
  it('确认框取消：面板离开 DOM，会话仍在，行仍在', async () => {
    await sidebar.pickRowMenu(CANCEL, 'delete-session')
    await confirm.waitOpen()

    await confirm.cancel()
    await confirm.waitClosed()

    expect(await listSessionIds()).toContain(cancelSid)
    expect(await sidebar.titles()).toContain(CANCEL)
  })

  // RM-12 —— 父会话本身 0 条消息，确认框走的是 `childrenOf(id).length > 0` 那半个分支
  it('删父会话：确认框写明会带走几条子会话，确认后三条一起消失', async () => {
    await sidebar.pickRowMenu(PARENT, 'delete-session')
    await confirm.waitOpen()

    // 断数字不断本地化文案 —— 三种语言的这句话里只有 count 是数字
    expect((await confirm.snapshot()).description).toContain('2')

    await confirm.confirm()
    await until(async () => {
      const ids = await listSessionIds()
      return ![parentSid, subASid, subBSid].some((id) => ids.includes(id))
    }, 'parent and both sub-sessions deleted')
  })
})

describe('export-session', () => {
  // RM-13 —— 导出整条在渲染端，没有 IPC 可断，只断到「交给浏览器的那一份」
  it('导出落到 <标题>.md，正文里有会话标题与那条用户消息原文', async () => {
    await download.clear()
    await sidebar.pickRowMenu(EXPORTED, 'export-session')

    const file = await download.wait()
    expect(file.download).toBe(`${EXPORTED}.md`)
    expect(file.text).toContain(EXPORTED)
    expect(file.text).toContain(EXPORTED_TEXT)
  })
})
