/**
 * A4 · 成员管理与聊天会话空态 —— 头部成员条（BotMembersBar）/ manage 模式对话框
 * （BotSessionDialog 复用）/ 幽灵成员逃生口 / 缺失标注 / 多 bot 空态与建议问题。
 *
 * 契约要点：
 *   - 成员条按 settings.bots 的**名单序**铺胶囊（不是注册表字典序）；非聊天会话不渲染；
 *   - manage 模式：当前名单预勾选、项目区不渲染（会话归属早已定死）；
 *   - 保存按 bot.list() 的列表序（`bot:list` 按 name.localeCompare 排序），仍被勾着的
 *     幽灵成员按原名单相对序缀尾；新增成员的开场白即刻落库（行上自带署名）；
 *   - 幽灵成员（名单里有、注册表里没有）灰行呈现且可取消勾选 —— updateBots 刻意不校验
 *     名字，这个对话框就是名单写坏之后的逃生口；
 *   - 空态：成员介绍卡（注册表缺失者不自我介绍）+ 建议问题 chip（shuvix-bot-suggestions），
 *     点击 = 草稿带提及胶囊 token 进输入框（隐式定向本 bot，走 A3 的 draft-rebuild）。
 *
 * manage 的错误框留驻路径（onSubmit 返回错误文案 / 抛异常 → setError 同待遇）在此
 * **刻意缺席**：对话框先挡空名单、成员条只在聊天会话上渲染，updateBots 仅有的两个
 * 拒绝分支（非聊天会话 / 空名单）经这条 UI 都构造不出自然通路 —— 不伪造 IPC 故障去
 * 敲开它（risk-9：缺席成因明示于此，而不是硬造一条假路径）。
 */
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'
import { createBotSession, waitRendererReady, writeBotMd } from '../../harness/seed'
import {
  botDialogPane,
  botSessionPane,
  chatPane,
  sidebarPane,
  type BotDialogPane,
  type BotSessionPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let sidebar: SidebarPane
let chat: ChatPane
let dialog: BotDialogPane
let pane: BotSessionPane

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: { sender?: { name: string; displayName: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const getBots = (sid: string): Promise<string[] | undefined> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s?.settings?.bots)`)

const unreadOf = (sid: string): Promise<number> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s?.settings?.unreadCount ?? 0)`
  )

/** 打开一个已存在的会话并等对话区就绪 */
async function open(title: string): Promise<void> {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 成员条胶囊名序（DOM 序） */
const chipNames = async (): Promise<string[]> => (await pane.membersBar()).chips.map((c) => c.name)

let s1: string // A4-M22：manage 主场（22/23/24/27/28）
let s2: string // A4-M25：幽灵逃生口
let s3: string // A4-M26：幽灵保序

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)
  dialog = botDialogPane(app.main)
  pane = botSessionPane(app.main)

  writeBotMd(app, 'm-alpha', { description: 'member a', displayName: 'MemA' })
  writeBotMd(app, 'm-beta', { description: 'member b', displayName: 'MemB' })
  writeBotMd(app, 'm-gamma', {
    description: 'member c',
    displayName: 'MemC',
    greeting: 'gamma 报到'
  })
  writeBotMd(app, 'g-live', { description: 'stays', displayName: 'GLive' })
  writeBotMd(app, 'g-ghost', { description: 'md will be deleted', displayName: 'GGhost' })
  writeBotMd(app, 'g2-live', { description: 'stays too', displayName: 'G2Live' })
  writeBotMd(app, 'g2-ghost', { description: 'md will be deleted', displayName: 'G2Ghost' })
  writeBotMd(app, 'g2-new', { description: 'joins later', displayName: 'G2New' })
  // 空态语料：displayName ≠ name（31 号要证 token 展示名走 displayName）
  writeBotMd(app, 's-nova', {
    description: 'nova knows the repo',
    displayName: 'Nova星',
    suggestions: ['最近有什么变化？', '给我一份摘要']
  })
  writeBotMd(app, 's-quiet', { description: 'quiet member', displayName: 'Quiet' })

  // 名单序刻意与字典序相反（22 号要证胶囊跟名单不跟注册表）
  s1 = await createBotSession(app.main, { bots: ['m-beta', 'm-alpha'], title: 'A4-M22' })
  s2 = await createBotSession(app.main, { bots: ['g-live', 'g-ghost'], title: 'A4-M25' })
  // 幽灵在头部（26 号要证「存留幽灵缀尾」是搬位置，不是本来就在尾部）
  s3 = await createBotSession(app.main, { bots: ['g2-ghost', 'g2-live'], title: 'A4-M26' })
  // 空态两场（29/31 与 30）：断言全按标题走 UI，不需要留 id
  await createBotSession(app.main, { bots: ['s-nova', 's-quiet'], title: 'A4-M29' })
  await createBotSession(app.main, { bots: ['s-nova', 'zombie-x'], title: 'A4-M30' })
  await app.main.eval(`window.api.session.create({ title: 'A4-M-plain' })`)
  await until(async () => (await sidebar.titles()).includes('A4-M-plain'), 'sessions listed')
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('头部成员条', () => {
  // A4-22
  it('聊天会话头部有 data-bot-members，胶囊按名单序；非聊天会话没有', async () => {
    await open('A4-M22')
    await until(async () => (await pane.membersBar()).present, 'members bar mounted')

    // 名单序 [m-beta, m-alpha]，不是注册表字典序
    expect(await chipNames()).toEqual(['m-beta', 'm-alpha'])
    // 注册表就位后胶囊显示 displayName、无缺失标注
    await until(
      async () => (await pane.membersBar()).chips.every((c) => c.display !== c.name),
      'registry resolved'
    )
    expect((await pane.membersBar()).chips).toEqual([
      { name: 'm-beta', display: 'MemB', missing: false },
      { name: 'm-alpha', display: 'MemA', missing: false }
    ])

    // 对照：普通会话头部没有成员条
    await open('A4-M-plain')
    expect((await pane.membersBar()).present).toBe(false)
  })

  // A4-23
  it('manage 打开：当前名单全预勾选、项目区不渲染', async () => {
    await open('A4-M22')
    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()

    const rows = await dialog.rows()
    // 名单内的预勾选，名单外的不勾
    for (const r of rows) {
      expect(r.checked).toBe(['m-alpha', 'm-beta'].includes(r.name))
    }
    expect(await dialog.ghostRows()).toEqual([])
    // 项目区仅 create 模式渲染：manage 下页脚归属文案不存在，且 projectId=null
    // 也**不**出现无项目警示块 —— 区块整体没渲染，不是渲染了个空值
    expect(await dialog.projectLabelText()).toBe('')
    expect(await dialog.noProjectHintShown()).toBe(false)

    await dialog.pressEscape()
    await dialog.waitClosed()
  })

  // A4-24（含 A4-32：有消息之后不出空态）
  it('加成员保存：名单按列表序落库、胶囊更新、新成员开场白落库、看着即读归 0', async () => {
    await open('A4-M22')
    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()
    expect(await dialog.toggle('m-gamma')).toBe(true)
    await dialog.create()
    await dialog.waitClosed()

    // IPC：保存按 bot.list() 的列表序（localeCompare）——原名单 [m-beta, m-alpha] 被规整
    expect(await getBots(s1)).toEqual(['m-alpha', 'm-beta', 'm-gamma'])
    // 胶囊即时跟上新名单
    await until(
      async () => (await chipNames()).join() === 'm-alpha,m-beta,m-gamma',
      'chips updated'
    )
    // 只有新增成员补开场白，消息行自带落库当时的 displayName
    const msgs = await listMessages(s1)
    const assistants = msgs.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].content).toBe('gamma 报到')
    expect(assistants[0].metadata?.sender).toMatchObject({ name: 'm-gamma', displayName: 'MemC' })
    // 会话开着且被看着：开场白到即读（A4-32 的另一半：有消息之后不出空态）
    await until(async () => (await unreadOf(s1)) === 0, 'watched session auto-read')
    expect((await pane.emptyState()).present).toBe(false)
  })

  // A4-27
  it('全不勾时保存禁用（名单不得清空由对话框先挡）', async () => {
    await open('A4-M22')
    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()

    for (const name of ['m-alpha', 'm-beta', 'm-gamma']) {
      expect(await dialog.toggle(name)).toBe(true)
    }
    expect((await dialog.rows()).every((r) => !r.checked)).toBe(true)
    expect(await dialog.createDisabled()).toBe(true)

    await dialog.pressEscape()
    await dialog.waitClosed()
    // 没保存：名单原样
    expect(await getBots(s1)).toEqual(['m-alpha', 'm-beta', 'm-gamma'])
  })

  // A4-28
  it('缺失标注：md 删后经 manage 开合触发 refetch，胶囊带 data-bot-member-missing', async () => {
    await open('A4-M22')
    unlinkSync(join(app.botsDir, 'm-beta.md'))

    // 成员条的注册表在挂载时拉过一次 —— 删文件不自动生效，manage 开合各触发一次 refetch
    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()
    await dialog.pressEscape()
    await dialog.waitClosed()

    await until(
      async () =>
        (await pane.membersBar()).chips.find((c) => c.name === 'm-beta')?.missing === true,
      'missing badge on deleted member'
    )
    const chips = (await pane.membersBar()).chips
    // 缺失成员回落身份键灰显；未缺失的没有标注
    expect(chips.find((c) => c.name === 'm-beta')).toEqual({
      name: 'm-beta',
      display: 'm-beta',
      missing: true
    })
    expect(chips.filter((c) => c.name !== 'm-beta').every((c) => !c.missing)).toBe(true)
  })
})

describe('幽灵成员（名单里有、注册表里没有）', () => {
  // A4-25
  it('逃生口：幽灵行呈现且勾着 → 取消勾选保存 → 名单只剩活着的', async () => {
    unlinkSync(join(app.botsDir, 'g-ghost.md'))
    await open('A4-M25')
    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()

    // 幽灵以专属灰行呈现（不混进注册表行），且保持勾选态
    expect((await dialog.rows()).map((r) => r.name)).not.toContain('g-ghost')
    expect(await dialog.ghostRows()).toEqual([{ name: 'g-ghost', checked: true }])

    expect(await dialog.toggleGhost('g-ghost')).toBe(true)
    expect(await dialog.ghostRows()).toEqual([{ name: 'g-ghost', checked: false }])
    await dialog.create()
    await dialog.waitClosed()

    expect(await getBots(s2)).toEqual(['g-live'])
    await until(async () => (await chipNames()).join() === 'g-live', 'ghost chip gone')
  })

  // A4-26
  it('保序：[ghost, live] 留幽灵加新人 → 恰 [live, new, ghost]（存留幽灵缀尾）', async () => {
    unlinkSync(join(app.botsDir, 'g2-ghost.md'))
    await open('A4-M26')
    // 名单序还是 [g2-ghost, g2-live] —— 幽灵在头部
    await until(async () => (await chipNames()).join() === 'g2-ghost,g2-live', 'roster chips')

    expect(await pane.clickManageMembers()).toBe(true)
    await dialog.waitOpen()
    expect(await dialog.ghostRows()).toEqual([{ name: 'g2-ghost', checked: true }])
    expect(await dialog.toggle('g2-new')).toBe(true)
    await dialog.create()
    await dialog.waitClosed()

    // 已知成员按列表序、存留幽灵按原名单相对序缀尾 —— 精确序，不许 sort 兜底
    expect(await getBots(s3)).toEqual(['g2-live', 'g2-new', 'g2-ghost'])
  })
})

describe('聊天会话空态（成员介绍 + 建议问题）', () => {
  // A4-29
  it('无 greeting 的双成员会话：data-bot-empty、两张成员卡、建议数各归各；普通会话没有', async () => {
    await open('A4-M29')
    await until(async () => (await pane.emptyState()).present, 'empty state mounted')
    // 注册表落定后恰两张卡（成员序），建议 chip 数 2 / 0
    await until(async () => (await pane.emptyState()).cards.length === 2, 'both cards')
    expect((await pane.emptyState()).cards).toEqual([
      { name: 's-nova', suggestions: ['最近有什么变化？', '给我一份摘要'] },
      { name: 's-quiet', suggestions: [] }
    ])

    // 对照：普通空会话的空态没有 data-bot-empty（走通用引导）
    await open('A4-M-plain')
    expect((await pane.emptyState()).present).toBe(false)
  })

  // A4-30
  it('注册表缺失的成员不自我介绍：[s-nova, zombie-x] 只出 s-nova 一张卡', async () => {
    await open('A4-M30')
    await until(async () => (await pane.emptyState()).present, 'empty state mounted')
    // 注册表落定前 zombie 卡可能闪现（registry===null 的回落分支）——等它收敛到恰一张
    await until(
      async () =>
        JSON.stringify((await pane.emptyState()).cards.map((c) => c.name)) ===
        JSON.stringify(['s-nova']),
      'zombie card hidden'
    )
  })

  // A4-31
  it('建议 chip 点击：输入框恰为 `@<displayName> <建议>`，不含裸 token 标记', async () => {
    await open('A4-M29')
    await until(
      async () => ((await pane.emptyState()).cards[0]?.suggestions.length ?? 0) === 2,
      'suggestions ready'
    )
    expect(await pane.clickSuggestion('s-nova', 0)).toBe(true)

    // 草稿经 A3 的 draft-rebuild 进输入框：提及胶囊显示 `@<displayName>`（≠ name），
    // 裸 {{shuvixInlineToken:…}} 标记绝不能漏进可编辑明文
    await until(
      async () => (await chat.inputValue()) === '@Nova星 最近有什么变化？',
      'draft with mention capsule'
    )
    expect(await chat.inputValue()).not.toContain('{{shuvixInlineToken')
  })
})
