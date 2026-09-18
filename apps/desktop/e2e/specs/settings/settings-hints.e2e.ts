/**
 * 设置页的说明气泡（`InfoHint`）—— 2026-09-17 把「铺在标题下面的灰字」换成了标题旁一个小问号，
 * 悬浮或聚焦才展开。这份 spec 钉的是**那次整改的边界**，不是气泡好不好看：
 *
 *   - 收起时那段话**根本不在页面上**（IH-E-1），而没有说明的行**根本没有问号**（IH-E-2）——
 *     整改的两头，一头做过了就满屏问号，一头没做完就等于什么也没改。
 *   - 键盘一条路走得通（IH-E-3 / IH-E-7）：只用键盘的人不能因为这次整改失去全部解释。
 *     **现有用例一条都没走过聚焦路径** —— pages.ts 的 SECTION_HINT 走的是悬浮。
 *   - 滚动是**重新定位**不是收起（IH-E-4），锚点整个滚出视野才藏起来（IH-E-5）。前者是真发生过的
 *     回归：`focus()` 自己会把按钮滚进视野，滚动即收起的话，键盘 Tab 过来的人刚展开就被关掉。
 *   - 气泡挂在 `document.body` 上（IH-E-6）：卡片是 `overflow-hidden` 的圆角容器，行内绝对定位会被
 *     裁掉半截；弹窗里还要压在 `z-50` 的遮罩之上。**这种回归下读文案的断言全绿** —— 它们只读
 *     `textContent`，剪没剪、盖没盖一概看不出来，所以这里读的是几何与 z-index。
 *   - 少数 `description` 其实是「这一行自己的内容」（数据库凭据的 `user@host`、更新检查的当前状态），
 *     那些走 `subtitle`，照旧是明面上的文字（IH-E-8）。这是唯一在真实调用点上钉住这条分流的用例。
 *
 * 几何算术本身（翻转 / 夹边 / 钉上边距 / 出视口）在 `packages/app-shell/src/settings/
 * SettingsPrimitives.test.ts` 的 IH-U-* 里 —— 那几条分支在真实设置页里走不到。
 *
 * 一个隔离实例、**一个设置窗口一路点下去**（`openSettings` 对已存在的窗口只聚焦、不切 tab），
 * 所以用例之间有顺序依赖：通用 tab 的几条在前，切到「LLM 工具」与「关于」的在后。
 * 三语取串照抄 session-knowledge-bases.e2e.ts：隔离实例跟系统语言走，断的是「是哪一句」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  infoHintPane,
  sessionConfigPane,
  settingsNavPane,
  sidebarPane,
  type InfoHintPane,
  type InfoHintShot,
  type SessionConfigPane,
  type SettingsNavPane,
  type SidebarPane
} from '../../harness/pages'
import { seedSkill, waitRendererReady } from '../../harness/seed'

const L = [en, zh, ja]

/** 带说明的那一行（通用 tab · 外观节的末行） */
const FOCUS_TITLE = L.map((l) => l.settings.focusMode)
const FOCUS_DESC = L.map((l) => l.settings.focusModeDesc)
/** 同一节里**不带**说明的两行，以及既无说明也无 footer 的节标题 */
const THEME_TITLE = L.map((l) => l.settings.themeMode)
const FONT_TITLE = L.map((l) => l.settings.fontSize)
const APPEARANCE_GROUP = L.map((l) => l.settings.appearanceGroup)
/** 问号按钮的无障碍名字 —— 这个键缺了肉眼看不出来（它不上屏） */
const INFO_LABEL = L.map((l) => l.common.info)
/** 「LLM 工具」页数据库子页里那一节（页面够长，锚点滚得出视野） */
const DB_TITLE = L.map((l) => l.settings.toolDbTitle)
const DB_DESC = L.map((l) => l.settings.toolDbDesc)
const TOOLS_TAB = L.map((l) => l.settings.tabTools)
const ABOUT_TAB = L.map((l) => l.settings.tabAbout)
const CHECK_UPDATE = L.map((l) => l.about.checkUpdate)
/** 会话设置弹窗里的扩展能力卡（说明走 SettingsSection 的 footer，同样收进问号） */
const EXT_GROUP = L.map((l) => l.sessionConfig.extensionsGroup)

/** 实现里的两个常量（私有，不导出）—— 断言写字面量，改了实现就该来改这里 */
const HINT_GAP = 6
const HINT_MARGIN = 8

/** 种一条数据库凭据：名字是「它是谁」，`user@host:port/db` 是「它连的是哪台机器」 */
const DB_CRED = {
  name: 'hints-box',
  dbType: 'postgresql',
  host: '10.0.0.7',
  port: 5432,
  username: 'e2e',
  password: 'x',
  database: 'hints'
}
const DB_TARGET = `${DB_CRED.username}@${DB_CRED.host}:${DB_CRED.port}/${DB_CRED.database}`

/** 弹窗面板（sessionConfigPane 同款）—— 空会话的聊天区会内联渲染同一张面板，必须限定作用域 */
const DIALOG_PANEL = `[...document.querySelectorAll('.dialog-panel')].find((p) => p.querySelector('input'))`

let app: E2EApp
let settings: CdpClient
let hints: InfoHintPane
let nav: SettingsNavPane
let sidebar: SidebarPane
let sessionConfig: SessionConfigPane

/** 气泡到锚点的距离（取上下两种贴法里近的那个）—— 与「放在哪一侧」无关的「贴着没有」判据 */
function gapToAnchor(shot: InfoHintShot, anchor: { top: number; bottom: number }): number {
  return Math.min(
    Math.abs(shot.rect.top - (anchor.bottom + HINT_GAP)),
    Math.abs(anchor.top - HINT_GAP - shot.rect.bottom)
  )
}

/** 切到「LLM 工具」页的数据库子页（子页标签取自工具定义，不写死英文） */
async function openDbToolPage(): Promise<void> {
  await nav.selectTab(TOOLS_TAB)
  const defs = await app.main.eval<{ name: string; label?: string }[]>(
    'window.api.tools.definitions()'
  )
  const db = defs.find((d) => d.name === 'database')
  if (!db) throw new Error('builtin database tool missing from tools.definitions()')
  await nav.selectToolSubTab(db.label || db.name)
  await hints.waitRow(DB_TITLE)
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  // IH-E-6 的弹窗要有扩展能力卡才渲染；隔离实例恒有 v10 种下的 mcp:tavily（v24 起不再是内置，
  // 但那一行仍在），再种一个 skill 让两组都不空
  seedSkill(app, 'e2e-hint-skill')
  // 多种几条：IH-E-5 要把锚点整个滚出视口，页面得够长
  for (let i = 0; i < 16; i++) {
    const cred = { ...DB_CRED, name: i === 0 ? DB_CRED.name : `${DB_CRED.name}-${i}` }
    await app.main.eval(`window.api.dbCredential.add(${JSON.stringify(cred)})`)
  }
  settings = await app.openSettings('general')
  hints = infoHintPane(settings)
  nav = settingsNavPane(settings)
  sidebar = sidebarPane(app.main)
  sessionConfig = sessionConfigPane(app.main)
  // 设置窗口是另开的一扇窗，React 挂完才有行可读
  await hints.waitRow(FOCUS_TITLE)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('说明收进问号（通用 tab）', () => {
  it('IH-E-1 说明在你伸手要之前不在页面上：该行恰好一个问号，悬上去才拿到那句话', async () => {
    // 失败 = 说明又铺回页面了（整改白做），或者气泡里不是用户要找的那一句
    const before = await hints.visibleText()
    expect(FOCUS_DESC.some((d) => before.includes(d))).toBe(false)
    // 更硬的一条：收起时气泡**根本不在 DOM 里**，不是靠 CSS 藏起来的
    expect(await hints.openTips()).toBe(0)
    expect(await hints.count(FOCUS_TITLE)).toBe(1)

    const shot = await hints.hoverOpen(FOCUS_TITLE)
    expect(FOCUS_DESC).toContain(shot.text)
    // 这个气泡确实属于这个问号（aria-describedby → id），不是 document 里碰巧的第一个
    expect(shot.describedBy).toBe(true)

    await hints.hoverOut(FOCUS_TITLE)
    await hints.waitClosed(FOCUS_TITLE)
  })

  it('IH-E-2 没说明就没问号：同节里不带 description 的行、既无 description 也无 footer 的节标题都是 0', async () => {
    // 失败 = 守卫破了，满屏问号 —— 一个点开来是空的问号比一行灰字更糟
    expect(await hints.count(THEME_TITLE)).toBe(0)
    expect(await hints.count(FONT_TITLE)).toBe(0)
    expect(await hints.count(APPEARANCE_GROUP)).toBe(0)
  })

  it('IH-E-3 键盘路径：focus 展开、Escape 收起且焦点不走、blur 收起', async () => {
    // 失败 = 只用键盘的人悄无声息地失去了设置页的全部解释（问号能 Tab 到，却打不开）
    const opened = await hints.focus(FOCUS_TITLE)
    expect(opened).not.toBeNull()
    expect(FOCUS_DESC).toContain(opened!.text)

    await hints.pressKey(FOCUS_TITLE, 'Escape')
    await hints.waitClosed(FOCUS_TITLE)
    // Escape 只收气泡，不该把焦点也甩掉 —— 甩掉了就接不上 Tab 序列
    expect((await hints.a11y(FOCUS_TITLE)).focused).toBe(true)

    // 已经聚焦着的按钮再 focus() 不会触发事件，所以先失焦：这一来一回也顺带证明 blur 收得掉
    await hints.blur(FOCUS_TITLE)
    await hints.waitClosed(FOCUS_TITLE)
    expect(await hints.focus(FOCUS_TITLE)).not.toBeNull()
    await hints.blur(FOCUS_TITLE)
    await hints.waitClosed(FOCUS_TITLE)
  })

  it('IH-E-7 无障碍接线：aria-label 已翻译、aria-describedby 展开才有且指向气泡、没有 aria-expanded', async () => {
    const closed = await hints.a11y(FOCUS_TITLE)
    // 失败 = 读屏把设置页读成一堆没名字的按钮；裸键（common.info）也算失败 —— 语言包缺键不上屏，肉眼看不出来
    expect(INFO_LABEL).toContain(closed.ariaLabel)
    expect(closed.ariaLabel).not.toBe('common.info')
    expect(closed.describedBy).toBe('')
    // tooltip 不是展开/收起一块内容的控件；写了 aria-expanded 读屏会把它念成一个可操作的开关
    expect(closed.hasAriaExpanded).toBe(false)

    const shot = await hints.hoverOpen(FOCUS_TITLE)
    const open = await hints.a11y(FOCUS_TITLE)
    expect(open.describedBy).not.toBe('')
    expect(open.hasAriaExpanded).toBe(false)
    // describedBy 为 true 就意味着 aria-describedby 指到的那个元素**就是**读出这段文字的气泡
    expect(shot.describedBy).toBe(true)
    expect(FOCUS_DESC).toContain(shot.text)

    await hints.hoverOut(FOCUS_TITLE)
    await hints.waitClosed(FOCUS_TITLE)
  })

  it('IH-E-4 滚动是重新定位不是收起：气泡仍在、仍可见，跟着锚点走了同样的距离', async () => {
    const before = await hints.hoverOpen(FOCUS_TITLE)
    const a0 = await hints.anchorRect(FOCUS_TITLE)
    expect(gapToAnchor(before, a0)).toBeLessThan(1)

    // 只滚一小段：这一节的滚动余量只有几十像素，滚多了气泡会从锚点上方翻到下方，
    // 那时「位移相同」本来就不该成立（翻转本身由 IH-U-2 钉）
    const room = await hints.scrollRoom(FOCUS_TITLE)
    expect(room.down).toBeGreaterThan(24) // 前置自检：容器真能滚，否则这条用例是空转
    const moved = await hints.scrollBy(FOCUS_TITLE, 24)
    expect(moved).toBe(24)

    // 锚点是同步就位的（改 scrollTop 即生效），气泡不是：scroll 事件 → 重新量 → 写 style
    // 要跨一拍，所以先把锚点定下来，再等气泡追上它
    const a1 = await hints.anchorRect(FOCUS_TITLE)
    expect(a1.top - a0.top).toBe(-moved)
    // 失败 = 键盘用户刚 Tab 过来就被 focus() 自带的那一下滚动关掉（这个回归真发生过）——
    // 被关掉时 peek 一直是 null，于是这里超时，信息里两种坏法都写上了
    const after = await until(
      async () => {
        const shot = await hints.peek(FOCUS_TITLE)
        return shot && gapToAnchor(shot, a1) < 1 ? shot : null
      },
      'hint repositioned with the anchor (not closed by the scroll)',
      5_000
    )
    expect(after.visibility).toBe('visible')
    expect(after.rect.top - before.rect.top).toBeCloseTo(a1.top - a0.top, 0)

    await hints.hoverOut(FOCUS_TITLE)
    await hints.waitClosed(FOCUS_TITLE)
    await hints.scrollBy(FOCUS_TITLE, -moved)
  })
})

describe('锚点滚出视野（LLM 工具 · 数据库子页）', () => {
  it('IH-E-5 锚点整个滚出视口：气泡仍挂在 DOM 上，但被置成 visibility:hidden', async () => {
    await openDbToolPage()
    // 这一节天然落在首屏之下，先把它滚进视野（留 100px 余地）再开气泡
    const start = await hints.anchorRect(DB_TITLE)
    await hints.scrollBy(DB_TITLE, start.top - 100)

    const inView = await hints.hoverOpen(DB_TITLE)
    expect(DB_DESC).toContain(inView.text)
    expect(inView.visibility).toBe('visible')

    // 余量在气泡开出来**之后**才测得准：hoverOpen 自己会把锚点滚进视野，先测就废了
    const room = await hints.scrollRoom(DB_TITLE)
    // 前置自检：下方要够长，才能把锚点整个推出视口上沿
    expect(room.down).toBeGreaterThan(200)

    // 再滚到底：锚点整个落到视口**上沿**之外（数据库子页标题上方的内容比旧的 SSH 子页少，
    // 滚到顶时它还差几十像素没出下沿；换个方向考的是同一件事，且只依赖下方有滚动空间）
    const moved = await hints.scrollBy(DB_TITLE, room.down)
    expect(moved).toBe(room.down)
    const anchor = await hints.anchorRect(DB_TITLE)
    expect(anchor.bottom).toBeLessThan(0) // 前置自检：真的整个出去了

    // 先断「没被卸掉」：悬浮态一刻没断过，气泡该一直挂着，只是看不见
    expect(await hints.peek(DB_TITLE)).not.toBeNull()
    // 失败 = 一段无主的说明飘在不相干的行上面（没藏起来）
    const out = await until(
      async () => {
        const shot = await hints.peek(DB_TITLE)
        return shot && shot.visibility === 'hidden' ? shot : null
      },
      'hint hidden once its anchor left the viewport',
      5_000
    )
    expect(out.text).not.toBe('')

    await hints.hoverOut(DB_TITLE)
    await hints.waitClosed(DB_TITLE)
  })
})

describe('气泡逃出卡片与弹窗层叠（会话设置弹窗）', () => {
  it('IH-E-6 气泡 portal 到 body、压在遮罩之上、整块落在视口内且守住 8px 边距', async () => {
    const title = 'IH-E6-会话'
    await app.main.eval(`window.api.session.create(${JSON.stringify({ title })})`)
    await until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
    await sidebar.pickRowMenu(title, 'session-config')
    await sessionConfig.waitOpen()

    const dialogHints = infoHintPane(app.main, DIALOG_PANEL)
    await until(() => dialogHints.count(EXT_GROUP), 'extensions card hint in the dialog')
    const shot = await dialogHints.hoverOpen(EXT_GROUP)
    const vp = await dialogHints.viewport()

    // ① 挂在 body 上 —— 失败 = 有人把气泡搬回行内，被卡片的 overflow-hidden 剪掉半截。
    //    注意这种回归下「读文案」的三条既有断言全绿：textContent 读得到被剪掉的那半截
    expect(shot.parentTag).toBe('BODY')
    // ② 压在弹窗遮罩之上 —— 气泡是 pointer-events-none 的，被盖住也一样读得到文字
    expect(shot.zIndex).toBeGreaterThan(await sessionConfig.overlayZ())
    // ③ 整块落在视口内，四边各守 8px
    expect(shot.rect.left).toBeGreaterThanOrEqual(HINT_MARGIN)
    expect(shot.rect.top).toBeGreaterThanOrEqual(HINT_MARGIN)
    expect(shot.rect.right).toBeLessThanOrEqual(vp.width - HINT_MARGIN)
    expect(shot.rect.bottom).toBeLessThanOrEqual(vp.height - HINT_MARGIN)
    expect(shot.text).not.toBe('')

    await dialogHints.hoverOut(EXT_GROUP)
    await sessionConfig.close()
    await sessionConfig.waitClosed()
  })
})

describe('「这一行自己的内容」留在明面上', () => {
  it('IH-E-8 数据库凭据行的 user@host:port/db 与更新检查行的状态，不悬浮就在页面文字里', async () => {
    await openDbToolPage()
    const toolsText = await hints.visibleText()
    // 失败 = 整改用过头：凭据行只剩名字，两台机器的区别藏进了悬浮，选哪一条全靠猜
    expect(toolsText).toContain(DB_CRED.name)
    expect(toolsText).toContain(DB_TARGET)
    // 而且这一刻一个气泡都没开着 —— 上面那句是真·页面文字，不是谁顺手展开的
    expect(await hints.openTips()).toBe(0)

    // 「关于」页的更新检查行同形：状态是这一行自己的内容（subtitle），不是「这一行是干嘛的」
    await nav.selectTab(ABOUT_TAB)
    await hints.waitRow(CHECK_UPDATE)
    await settings.eval('window.api.update.check()')
    // 只要求「有状态」，不钉是哪一种：隔离实例里读不到 dev-app-update.yml，落的是 error 那一支
    const status = await until(
      async () => (await hints.subtitleOf(CHECK_UPDATE)) || null,
      'update status subtitle'
    )
    expect((await hints.visibleText()).includes(status)).toBe(true)
    expect(await hints.count(CHECK_UPDATE)).toBe(0)
    expect(await hints.openTips()).toBe(0)
  })
})
