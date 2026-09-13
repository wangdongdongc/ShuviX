/**
 * 同名的几份 bot 文件（BS-*）：`bot.list` 的 bots / shadowed、侧栏 Bots 分组、头部身份胶囊三处说的是
 * 同一次同名裁决 —— 文件名就是名字的那份生效；其余几份紧跟在胜出行后面、划线带覆盖徽标，title 说清
 * 被谁压过，菜单只剩按文件名删除。
 *
 * 夹具刻意让「文件名即名字」与「更短 / 排序更前」打架：a.md 比 ace.md 短、码点序也更前，只有那一条
 * 规则能让 ace.md 胜出；zed.md 是既不短也不靠前的第三份。displayName 三份各不相同，胶囊上的名字
 * 因此直接说出「此刻生效的是哪一份文件」。
 *
 * 用例有顺序依赖（BS-2 接着 BS-1 的盘面删）。全程无 LLM。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createBotSession,
  sessionsBoundTo,
  waitRendererReady,
  writeBotMd
} from '../../harness/seed'
import {
  botChip,
  botsPane,
  confirmPane,
  sidebarPane,
  type BotChipPane,
  type BotChipSnapshot,
  type BotsPane,
  type SidebarPane
} from '../../harness/pages'

/** 绑着 ace 的 bot 会话 */
const TITLE = 'BS-ace'

/** `bot.list` 的一行（IPC 投影，见 preload 的 BotInfo） */
interface BotRow {
  name: string
  displayName: string
  description: string
  basePath: string
  fileName: string
}

interface BotListing {
  bots: BotRow[]
  shadowed: Array<BotRow & { shadowedBy: string }>
  invalid: Array<{ fileName: string; error: string }>
}

let app: E2EApp
let bots: BotsPane
let sidebar: SidebarPane
let chip: BotChipPane
let sid = ''

const botPath = (fileName: string): string => join(app.botsDir, fileName)
const listBots = (): Promise<BotListing> => app.main.eval<BotListing>('window.api.bot.list()')

/** 等胶囊落定到 ace 的某个显示名 —— 名字换成它，才说明替这一版注册表查的那一轮回来了 */
const waitChip = (name: string): Promise<BotChipSnapshot> =>
  until(async () => {
    const shot = await chip.snapshot()
    return shot.bot === 'ace' && shot.name === name ? shot : null
  }, `header chip settled on ace / "${name}"`)

/** 在 ms 时间窗里反复取样，任何一次不成立即失败 ——「保持不变」类断言用 */
async function expectHolds(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (!(await check())) throw new Error(`expected to hold for ${ms}ms, but broke: ${what}`)
    if (Date.now() >= deadline) return
    await sleep(100)
  }
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  bots = botsPane(app.main)
  sidebar = sidebarPane(app.main)
  chip = botChip(app.main)

  writeBotMd(app, 'ace', { displayName: 'Ace Canon' })
  writeBotMd(app, 'ace', { displayName: 'Ace Short', fileName: 'a.md' })
  writeBotMd(app, 'ace', { displayName: 'Ace Zed', fileName: 'zed.md' })
  sid = await createBotSession(app.main, { bot: 'ace', title: TITLE })

  await until(async () => (await sidebar.titles()).includes(TITLE), `sidebar row "${TITLE}"`)
  // 首次展开 = 首次扫描（分组是懒扫的）
  await bots.expand()
  if (!(await sidebar.openSession(TITLE))) throw new Error(`seed: session "${TITLE}" not found`)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('同名三份 bot 文件', () => {
  it('BS-1 IPC、侧栏与头部胶囊说的是同一个胜者：ace.md 生效，a.md / zed.md 依次跟在它后面、划线带徽标、title 指向 ace.md；两种行各有各的菜单', async () => {
    const listing = await listBots()
    expect(listing.bots.map((b) => [b.name, b.fileName, b.displayName])).toEqual([
      ['ace', 'ace.md', 'Ace Canon']
    ])
    expect(listing.shadowed.map((s) => [s.fileName, s.shadowedBy])).toEqual([
      ['a.md', 'ace.md'],
      ['zed.md', 'ace.md']
    ])
    expect(listing.invalid).toEqual([])

    expect(await bots.rows()).toEqual(['ace'])
    const shadowed = await bots.shadowedRows()
    expect(shadowed.map(({ fileName, after }) => ({ fileName, after }))).toEqual([
      { fileName: 'a.md', after: 'row:ace' },
      { fileName: 'zed.md', after: 'shadowed:a.md' }
    ])
    for (const row of shadowed) {
      expect(row.struck, row.fileName).toBe(true)
      expect(row.badge, row.fileName).toBe(true)
      expect(row.title, row.fileName).toContain('ace.md')
    }

    // 生效行照常有「新建 Bot 会话 / 删除」；输掉的行只能按文件名删（按名删会删到生效的那份）
    expect(await bots.rowMenuIds('ace')).toEqual(['new-bot-chat', 'delete-bot'])
    expect(await bots.shadowedRowMenuIds('zed.md')).toEqual(['delete-bot-file'])

    expect(await waitChip('Ace Canon')).toMatchObject({ bot: 'ace', missing: false })
  })

  it('BS-2 从菜单删：删输掉的 zed.md 只动它自己，胶囊纹丝不动；按名删 ace 删的是生效的 ace.md —— a.md 接班，胶囊换成 Ace Short、不标缺失，会话绑定不迁', async () => {
    const confirm = confirmPane(app.main)

    await bots.pickShadowedRowMenu('zed.md', 'delete-bot-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('zed.md')
    await confirm.confirm()

    await until(() => !existsSync(botPath('zed.md')), 'zed.md deleted')
    expect(existsSync(botPath('ace.md'))).toBe(true)
    expect(existsSync(botPath('a.md'))).toBe(true)
    await until(async () => {
      const rows = await bots.shadowedRows()
      return rows.length === 1 && rows[0].fileName === 'a.md'
    }, 'only a.md left shadowed')
    // 删除立刻广播 bot.changed、胶囊随之重查 —— 胜者没变，查回来的还是 Ace Canon
    await expectHolds('chip stays on Ace Canon, not missing', 500, async () => {
      const shot = await chip.snapshot()
      return shot.bot === 'ace' && shot.name === 'Ace Canon' && !shot.missing
    })

    await bots.pickRowMenu('ace', 'delete-bot')
    await confirm.waitOpen()
    await confirm.confirm()

    await until(() => !existsSync(botPath('ace.md')), 'ace.md deleted')
    const listing = await listBots()
    expect(listing.bots.map((b) => [b.name, b.fileName, b.displayName])).toEqual([
      ['ace', 'a.md', 'Ace Short']
    ])
    expect(listing.shadowed).toEqual([])
    await until(async () => (await bots.shadowedRows()).length === 0, 'no shadowed rows left')
    expect(await bots.rows()).toEqual(['ace'])
    // 名字落定之后「不缺失」才算数（加载中同样不标缺失）
    expect(await waitChip('Ace Short')).toMatchObject({ missing: false })
    // 名字没变、只是换了一份文件在用 —— 不是改名，会话绑定原样
    expect(await sessionsBoundTo(app.main, 'ace')).toEqual([sid])
  })
})
