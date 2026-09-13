/**
 * Bot 文件经笔记本会话编辑（bot.openNote / createNew / delete + botService 的写入回执）。
 *
 * 打开一份 bot 就是打开它的笔记本会话：没有显式保存、没有写前校验 —— 属性卡失焦提交、200ms 防抖
 * 自动保存落盘，写到一半解析不过的版本照样落盘（列进琥珀行）。botService 只在写入前后被告知一声
 * （noteWriting / noteWritten），据此补上两件事：**改名迁移会话绑定**（名字变了、且新名字独占、
 * 旧名字无人再用时才迁）与**合并窗口内广播一次 bot.changed**（侧栏分组据此重扫）。
 *
 * 用例间有顺序依赖（同一份 ranger.md 一路改下去），按列出顺序执行。写入只走两条路：属性卡
 * `commitField`（真实编辑路径）或 `noteWrite`（写路径 IPC，与自动保存同一个 writeSessionFile）——
 * 绝不往 CodeMirror 里打字。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  appEventRecorder,
  createBotSession,
  expectFileUnchanged,
  noteWrite,
  openRegistryNote,
  registryNoteSessions,
  sessionsBoundTo,
  waitFileWritten,
  waitRendererReady,
  type AppEventRecorder
} from '../../harness/seed'
import {
  botsPane,
  confirmPane,
  registryNotePane,
  type BotsPane,
  type RegistryNotePane
} from '../../harness/pages'

const BOTS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.bot

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
  /** 同名里输掉的几份（侧栏列在胜出行之后）；shadowedBy = 胜出那份的文件名 */
  shadowed: Array<BotRow & { shadowedBy: string }>
  invalid: Array<{ fileName: string; error: string }>
}

/** 种子文本以 `\n` 结尾：卡片改一行之后的全字节期望才稳定 */
const botMd = (opts: { name: string; displayName: string; body: string }): string =>
  [
    '---',
    'shuvix: bot v2',
    `name: ${opts.name}`,
    `description: e2e ${opts.name} bot`,
    `shuvix-displayName: ${opts.displayName}`,
    '---',
    '',
    opts.body,
    ''
  ].join('\n')

const RANGER = botMd({ name: 'ranger', displayName: 'Ranger', body: 'RANGER BODY.' })
const SCOUT = botMd({ name: 'scout', displayName: 'Scout', body: 'SCOUT BODY.' })

let app: E2EApp
let bots: BotsPane
let note: RegistryNotePane
let events: AppEventRecorder
let rangerSid = ''
let scoutSid = ''

const botPath = (fileName: string): string => join(app.botsDir, fileName)
const readBot = (fileName: string): string => readFileSync(botPath(fileName), 'utf8')
const listBots = (): Promise<BotListing> => app.main.eval<BotListing>('window.api.bot.list()')
const boundTo = (name: string): Promise<string[]> => sessionsBoundTo(app.main, name)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  mkdirSync(app.botsDir, { recursive: true })
  writeFileSync(botPath('ranger.md'), RANGER)
  writeFileSync(botPath('scout.md'), SCOUT)
  rangerSid = await createBotSession(app.main, { bot: 'ranger', title: 'bn-ranger-chat' })
  scoutSid = await createBotSession(app.main, { bot: 'scout', title: 'bn-scout-chat' })

  bots = botsPane(app.main)
  note = registryNotePane(app.main)
  events = appEventRecorder(app.main)
  await events.install()
  // 首次展开 = 首次扫描：botService 记下每份文件此刻的名字（改名迁移的基线）
  await bots.expand()
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('属性卡改名 → 自动保存 + 会话绑定迁移', () => {
  it('BN-1 卡上把 name 改成 hunter：只动那一行，绑定 ranger 的会话迁到 hunter，侧栏行随之换名并保持选中', async () => {
    await bots.selectRow('ranger')
    await note.waitBody('RANGER BODY.')
    const before = readBot('ranger.md')
    expect(before).toBe(RANGER)

    await note.commitField('name', 'hunter')
    expect(await waitFileWritten(botPath('ranger.md'), before)).toBe(
      before.replace('name: ranger\n', 'name: hunter\n')
    )

    await until(async () => (await boundTo('hunter')).includes(rangerSid), 'binding migrated')
    expect(await boundTo('hunter')).toEqual([rangerSid])
    expect(await boundTo('ranger')).toEqual([])
    expect(await boundTo('scout')).toEqual([scoutSid])

    // 不手动刷新：写入回执广播的 bot.changed 让分组自己重扫
    await until(async () => {
      const rows = await bots.rows()
      return rows.includes('hunter') && !rows.includes('ranger')
    }, 'sidebar row renamed')
    expect(await bots.activeRow()).toEqual({ row: 'hunter' })
    expect((await listBots()).bots).toContainEqual(
      expect.objectContaining({ name: 'hunter', fileName: 'ranger.md' })
    )
  })

  it('BN-2 中途撞上另一份文件的名字（scout）：不迁移；两份都列出 —— 文件名即名字的 scout.md 生效，ranger.md 跟在它后面划线带徽标、仍是活动行；改成独占的 scout-2 才一步迁过去，遮蔽随之解开', async () => {
    let before = readBot('ranger.md')
    await events.clear()
    await note.commitField('name', 'scout')
    expect(await waitFileWritten(botPath('ranger.md'), before)).toBe(
      before.replace('name: hunter\n', 'name: scout\n')
    )
    // 迁移判定在写入回执里同步跑完，bot.changed 再晚 300ms —— 等到它才下「没迁」的否定结论
    await until(async () => (await events.count('bot.changed')) >= 1, 'bot.changed after collision')
    expect(await boundTo('hunter')).toEqual([rangerSid])
    expect(await boundTo('scout')).toEqual([scoutSid])
    // 两份文件同名：两份都列出 —— scout.md 的文件名就是名字，它生效；ranger.md 进 shadowed 并指向它
    const collided = await listBots()
    expect(collided.bots.filter((b) => b.name === 'scout')).toEqual([
      expect.objectContaining({ fileName: 'scout.md', displayName: 'Scout' })
    ])
    expect(collided.shadowed).toEqual([
      {
        name: 'scout',
        displayName: 'Ranger',
        description: 'e2e ranger bot',
        basePath: botPath('ranger.md'),
        fileName: 'ranger.md',
        shadowedBy: 'scout.md'
      }
    ])
    expect(collided.invalid).toEqual([])

    // 侧栏（bot.changed 让分组自己重扫）：输掉的那份紧跟胜出行、划线带徽标；正开着的就是它自己的
    // 笔记，活动行不丢
    await until(
      async () => (await bots.shadowedRows()).some((r) => r.fileName === 'ranger.md'),
      'shadowed row listed'
    )
    expect(await bots.rows()).toEqual(['scout'])
    expect(
      (await bots.shadowedRows()).map(({ fileName, after, struck, badge }) => ({
        fileName,
        after,
        struck,
        badge
      }))
    ).toEqual([{ fileName: 'ranger.md', after: 'row:scout', struck: true, badge: true }])
    expect(await bots.activeRow()).toEqual({ shadowedRow: 'ranger.md' })

    before = readBot('ranger.md')
    await note.commitField('name', 'scout-2')
    expect(await waitFileWritten(botPath('ranger.md'), before)).toBe(
      before.replace('name: scout\n', 'name: scout-2\n')
    )
    await until(async () => (await boundTo('scout-2')).includes(rangerSid), 'binding migrated')
    expect(await boundTo('scout-2')).toEqual([rangerSid])
    expect(await boundTo('hunter')).toEqual([])
    expect(await boundTo('scout')).toEqual([scoutSid])

    // 撞名解开：谁也不再被遮蔽，两行各自生效，活动行回到普通行
    expect((await listBots()).shadowed).toEqual([])
    await until(async () => {
      const rows = await bots.rows()
      return rows.includes('scout-2') && (await bots.shadowedRows()).length === 0
    }, 'sidebar rescanned after the collision resolved')
    expect((await bots.rows()).sort()).toEqual(['scout', 'scout-2'])
    expect(await bots.activeRow()).toEqual({ row: 'scout-2' })
  })

  it('BN-3 写到一半解析不过的版本照原样落盘：进琥珀行（仍是活动行、正文照常），绑定不动；写成合法的 hunter-final 一步迁到位', async () => {
    const half = ['---', 'shuvix: bot v2', 'name: [unclosed', '---', '', 'HALF WRITTEN.', ''].join(
      '\n'
    )
    expect(await noteWrite(app.main, 'bot', 'ranger.md', half)).toEqual({ ok: true })
    expect(readBot('ranger.md')).toBe(half)

    const listing = await listBots()
    expect(listing.invalid.find((f) => f.fileName === 'ranger.md')?.error).toBeTruthy()
    expect(listing.bots.some((b) => b.fileName === 'ranger.md')).toBe(false)

    await until(
      async () => (await bots.activeRow())?.invalidRow === 'ranger.md',
      'amber row is the active one'
    )
    await note.waitBody('HALF WRITTEN.')
    // 解析不过的版本不动记录：绑定停在最后一个合法名字上
    expect(await boundTo('scout-2')).toEqual([rangerSid])

    // noteWrite 在写入回执（重扫 + 迁移）跑完之后才返回 —— 这里的读数是确定的
    const final = botMd({ name: 'hunter-final', displayName: 'Hunter', body: 'FINAL BODY.' })
    expect(await noteWrite(app.main, 'bot', 'ranger.md', final)).toEqual({ ok: true })
    expect(await boundTo('hunter-final')).toEqual([rangerSid])
    expect(await boundTo('scout-2')).toEqual([])
    await until(
      async () => (await bots.activeRow())?.row === 'hunter-final',
      'normal row active under the final name'
    )
  })
})

describe('bot.changed 合并窗口', () => {
  it('BN-4 三笔连续写入只广播一次 bot.changed；隔开再写一笔，再广播一次', async () => {
    const base = readBot('ranger.md')
    // 上一条用例的回执窗口先走完
    await sleep(700)
    await events.clear()

    // 一次 eval 里串行 await 三笔（不走 Promise.all：同一文件的并发写会互相踩临时文件）——
    // 三次 CDP 往返的抖动不该混进「窗口内」这个判断
    const bodies = [1, 2, 3].map((i) => base.replace('FINAL BODY.', `FINAL BODY ${i}.`))
    await app.main.eval(`(async () => {
      for (const content of ${JSON.stringify(bodies)}) {
        const session = await window.api.bot.openNote({ fileName: 'ranger.md' })
        const r = await window.api.files.write({ sessionId: session.id, path: 'ranger.md', content })
        if (!r.ok) throw new Error(r.error)
      }
      return true
    })()`)
    await sleep(1000)
    expect(await events.count('bot.changed')).toBe(1)

    const fourth = base.replace('FINAL BODY.', 'FINAL BODY 4.')
    expect(await noteWrite(app.main, 'bot', 'ranger.md', fourth)).toEqual({ ok: true })
    await sleep(1000)
    expect(await events.count('bot.changed')).toBe(2)
  })
})

describe('外部改动与零写盘', () => {
  it('BN-5 空闲时外部改盘 → 正文自动重载（不必重开），且没有回写', async () => {
    const external = readBot('ranger.md').replace('FINAL BODY 4.', 'EXTERNAL MARKER.')
    expect(external).toContain('EXTERNAL MARKER.')
    writeFileSync(botPath('ranger.md'), external)
    await note.waitBody('EXTERNAL MARKER.')
    await expectFileUnchanged(botPath('ranger.md'), external, 700)
  })

  it('BN-6 第一次打开一份 bot、只看不改 → 零写盘（字节与 mtime 都不变）', async () => {
    const before = readBot('scout.md')
    const mtime = statSync(botPath('scout.md')).mtimeMs
    await bots.selectRow('scout')
    await note.waitBody('SCOUT BODY.')
    await sleep(700)
    expect(readBot('scout.md')).toBe(before)
    expect(statSync(botPath('scout.md')).mtimeMs).toBe(mtime)
  })
})

describe('新建与删除', () => {
  it('BN-7 组头「新建 bot」→ my-bot.md 落盘并打开它的笔记（成为活动行）；再建一份是 my-bot-2.md', async () => {
    await bots.newBot()
    await until(() => existsSync(botPath('my-bot.md')), 'my-bot.md created')
    await until(async () => (await bots.activeRow())?.row === 'my-bot', 'my-bot row active')
    expect((await listBots()).bots).toContainEqual(
      expect.objectContaining({ name: 'my-bot', fileName: 'my-bot.md' })
    )
    // 模板正文预置两段小标题（bot 维护自己的文件要靠 edit 锚定既有文本）
    await note.waitBody('我是谁')

    await bots.newBot()
    await until(() => existsSync(botPath('my-bot-2.md')), 'my-bot-2.md created')
    await until(async () => (await bots.activeRow())?.row === 'my-bot-2', 'my-bot-2 row active')
  })

  it('BN-8 删掉正开着的 bot：文件没了且不被自动保存写回，主区离开它；笔记本会话本身留着，重建同名文件复用它', async () => {
    const orphan = (await registryNoteSessions(app.main, BOTS_PROJECT)).find(
      (n) => n.notebookPath === 'my-bot-2.md'
    )
    expect(orphan).toBeDefined()

    await bots.pickRowMenu('my-bot-2', 'delete-bot')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(() => !existsSync(botPath('my-bot-2.md')), 'my-bot-2.md deleted')
    await until(async () => (await bots.activeRow()) === null, 'no active bot row')
    expect(await note.bodyText()).not.toContain('我是谁')
    await sleep(700)
    expect(existsSync(botPath('my-bot-2.md'))).toBe(false)

    // 不级联：会话是用户资产，删 md 不带走它；但文件不在了，openNote 按白名单拒绝
    const remaining = await registryNoteSessions(app.main, BOTS_PROJECT)
    expect(remaining.filter((n) => n.notebookPath === 'my-bot-2.md').map((n) => n.id)).toEqual([
      orphan!.id
    ])
    const reopened = await openRegistryNote(app.main, 'bot', 'my-bot-2.md')
    expect(reopened.ok).toBe(false)
    expect(reopened.ok ? '' : reopened.error).toContain('Invalid bot file')

    // 再新建：第一个没被占用的名字又是 my-bot-2，同名文件的笔记复用那条会话
    await bots.newBot()
    await until(() => existsSync(botPath('my-bot-2.md')), 'my-bot-2.md recreated')
    await until(async () => (await bots.activeRow())?.row === 'my-bot-2', 'recreated row active')
    const again = (await registryNoteSessions(app.main, BOTS_PROJECT)).filter(
      (n) => n.notebookPath === 'my-bot-2.md'
    )
    expect(again.map((n) => n.id)).toEqual([orphan!.id])
  })

  it('BN-9 删掉一份没开着的 bot：开着的笔记不受影响', async () => {
    await bots.selectRow('scout')
    await note.waitBody('SCOUT BODY.')

    await bots.pickRowMenu('my-bot', 'delete-bot')
    const confirm = confirmPane(app.main)
    await confirm.waitOpen()
    await confirm.confirm()

    await until(() => !existsSync(botPath('my-bot.md')), 'my-bot.md deleted')
    await until(async () => !(await bots.rows()).includes('my-bot'), 'my-bot row gone')
    expect(await bots.activeRow()).toEqual({ row: 'scout' })
    expect(await note.bodyText()).toContain('SCOUT BODY.')
  })
})

describe('IPC 白名单', () => {
  it('BN-10 bot.openNote 只认 bots 目录里已存在的单个 .md：越界 / 不存在一律拒绝，不建会话', async () => {
    // 让越界那一份真实存在：拒绝必须来自白名单，而不是「碰巧没有这个文件」
    writeFileSync(join(app.home, '.shuvix', 'x.md'), 'outside the bots dir\n')
    const before = (await registryNoteSessions(app.main, BOTS_PROJECT)).length

    for (const fileName of ['../x.md', 'nope.md']) {
      const r = await openRegistryNote(app.main, 'bot', fileName)
      expect(r.ok, fileName).toBe(false)
      expect(r.ok ? '' : r.error, fileName).toContain('Invalid bot file')
    }
    expect(await registryNoteSessions(app.main, BOTS_PROJECT)).toHaveLength(before)
  })
})
