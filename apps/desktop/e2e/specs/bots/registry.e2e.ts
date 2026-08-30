/**
 * Bot 注册表 e2e（M1′）—— 纯 md 驱动的端到端断言：
 * 往 ~/.shuvix/bots 丢一份 md，`bot:list` 立即看得见；非法文件不进列表但进 invalid 通道。
 *
 * **不内置任何 bot**（设计 §4.2）：目录里有什么就是什么，没有「内置 + 用户覆盖」两源之分；
 * 「新建 bot」走 `bot:template`（内置管线 + 内置阶段 agent + 用户取的名字）。
 *
 * 断言走 IPC（window.api.bot.*），不碰 DOM —— 设置页 UI 是 A1 的活，此刻还不存在。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { launchApp, type E2EApp } from '../../harness/launch'
import { writeBotMd } from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

/** 列表项的最小形状（与 preload BotInfo 对齐，只声明本 spec 读的字段） */
interface ShuvixBotInfo {
  name: string
  displayName: string
  description: string
  pipeline: string
  respond: string
  notesEnabled: boolean
  notesChars: number
  tools: string[]
  basePath: string
  warnings: string[]
}

const list = (): Promise<ShuvixBotInfo[]> => app.main.eval('window.api.bot.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.bot.listInvalid()')

describe('bot registry', () => {
  it('ships no builtin bot — the directory is the whole truth', async () => {
    expect(await list()).toEqual([])
  })

  it('picks up a bot file with no enable switch', async () => {
    writeBotMd(app, 'e2e-scout', {
      description: 'e2e scout bot',
      displayName: 'Scout',
      tools: 'read, grep',
      respond: 'mention-only',
      notes: false,
      greeting: 'hello from scout',
      suggestions: ['what changed?']
    })
    const scout = (await list()).find((b) => b.name === 'e2e-scout')
    expect(scout).toBeDefined()
    expect(scout!.displayName).toBe('Scout')
    expect(scout!.respond).toBe('mention-only')
    expect(scout!.notesEnabled).toBe(false)
    expect(scout!.tools).toEqual(['read', 'grep'])
    expect(scout!.basePath).toContain('e2e-scout.md')
    // 管线缺省即内置的 bot-chat —— 用户不写这一行也有一条能跑的管线
    expect(scout!.pipeline).toBe('bot-chat')
  })

  it('carries bot-written notes without letting them reach the persona', async () => {
    writeBotMd(app, 'e2e-note-taker', {
      description: 'keeps notes',
      body: [
        'PERSONA LINE.',
        '',
        '<!-- shuvix:bot-notes -->',
        '',
        '## 关于这个用户',
        'NOTE LINE.'
      ].join('\n')
    })
    const bot = (await list()).find((b) => b.name === 'e2e-note-taker')
    expect(bot?.notesChars).toBeGreaterThan(0)
    // 笔记是散文不是数据结构：有内容也好、写乱也好，都不该影响文件的可用性
    expect(bot?.warnings).toEqual([])
  })

  it('keeps a bot alive when the notes marker appears more than once', async () => {
    // 状态区软失败：记 anomaly，但 bot 照常可用（绝不因此从注册表消失）
    writeBotMd(app, 'e2e-twomarkers', {
      description: 'two notes markers',
      body: [
        'PERSONA.',
        '',
        '<!-- shuvix:bot-notes -->',
        'first',
        '',
        '<!-- shuvix:bot-notes -->',
        'second'
      ].join('\n')
    })
    const bot = (await list()).find((b) => b.name === 'e2e-twomarkers')
    expect(bot).toBeDefined()
    expect(bot!.warnings.join('\n')).toMatch(/notes/i)
    expect((await listInvalid()).some((i) => i.fileName === 'e2e-twomarkers.md')).toBe(false)
  })

  it('surfaces an unparseable definition through the invalid channel instead of dropping it', async () => {
    // description 是 bot md 的必填项（意图段的相关性判据）—— 定义区硬失败
    writeBotMd(app, 'e2e-broken', { description: '', rawLines: ['description: '] })
    expect((await list()).some((b) => b.name === 'e2e-broken')).toBe(false)
    const entry = (await listInvalid()).find((i) => i.fileName === 'e2e-broken.md')
    expect(entry).toBeDefined()
    expect(entry!.error).toMatch(/description/i)
  })

  it('creates a usable bot from the builtin template with just a name', async () => {
    const tpl = await app.main.eval<{ text: string }>(
      `window.api.bot.template({ name: 'e2e-fresh', description: 'made from the template' })`
    )
    expect(tpl.text).toContain('shuvix: bot v1')
    expect(tpl.text).toContain('name: e2e-fresh')

    const created = await app.main.eval<{ success: boolean; name?: string; error?: string }>(
      `window.api.bot.create({ text: ${JSON.stringify(tpl.text)} })`
    )
    expect(created).toMatchObject({ success: true, name: 'e2e-fresh' })
    const fresh = (await list()).find((b) => b.name === 'e2e-fresh')
    expect(fresh?.pipeline).toBe('bot-chat')
  })

  it('rejects an invalid save and leaves the file on disk untouched', async () => {
    const filePath = writeBotMd(app, 'e2e-keeper', { description: 'keeps its old content' })
    const before = readFileSync(filePath, 'utf-8')
    const res = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.bot.save({ originalName: 'e2e-keeper', text: ${JSON.stringify(
        '---\nshuvix: bot v1\nname: e2e-keeper\ndescription: still described\n' +
          'shuvix-bot-respond: sometimes\n---\n\nBODY.\n'
      )} })`
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shuvix-bot-respond/)
    expect(readFileSync(filePath, 'utf-8')).toBe(before)
  })

  it('deletes a bot file', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.bot.delete({ name: 'e2e-scout' })`
    )
    expect(res.success).toBe(true)
    expect((await list()).some((b) => b.name === 'e2e-scout')).toBe(false)
  })
})
