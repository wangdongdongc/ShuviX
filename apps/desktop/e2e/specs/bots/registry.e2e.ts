/**
 * Bot 注册表 e2e（M1′ / v3）—— 纯 md 驱动的端到端断言：
 * 往 ~/.shuvix/bots 丢一份 md，`bot:list` 立即看得见；非法文件不进列表但进 invalid 通道。
 *
 * **不内置任何 bot**（设计 §4.2）：目录里有什么就是什么，没有「内置 + 用户覆盖」两源之分；
 * 「新建 bot」走 `bot:template`（内置管线 + 两个必填槽位预填内置门控与主会话基座档案 +
 * 用户取的名字）。
 *
 * v3 起 bot 是一份**绑定**（身份 + 管线 + 槽位表 + 正文），自己不再是 agent：
 * `shuvix-tools` / `shuvix-model` / `shuvix-bot-respond{,-to}` / `shuvix-bot-notes` /
 * `shuvix-bot-greeting` / `shuvix-bot-suggestions` 这些键写在 bot 上只是被忽略（不判非法）。
 * 列表项因此换成 `agents` + `bodyChars`；`bot:inspect` 换成按管线 input schema 现算的槽位表。
 *
 * 断言走 IPC（window.api.bot.*），不碰 DOM —— 设置页 UI 归 settings-tab.e2e.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { launchApp, type E2EApp } from '../../harness/launch'
import { DEFAULT_BOT_AGENTS, writeBotMd } from '../../harness/seed'

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
  agents: Record<string, string>
  bodyChars: number
  basePath: string
  warnings: string[]
}

/** `bot:inspect` 的形状（与 preload BotInspect 对齐） */
interface ShuvixBotInspect {
  pipeline: { name: string; exists: boolean; concurrency?: string }
  slots: Array<{
    role: string
    required: boolean
    description?: string
    ref?: string
    missing: boolean
  }>
  gateDegraded?: string
  body: { chars: number }
}

const list = (): Promise<ShuvixBotInfo[]> => app.main.eval('window.api.bot.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.bot.listInvalid()')
const inspect = (name: string): Promise<ShuvixBotInspect | { error: string }> =>
  app.main.eval(`window.api.bot.inspect({ name: ${JSON.stringify(name)} })`)

describe('bot registry', () => {
  it('ships no builtin bot — the directory is the whole truth', async () => {
    expect(await list()).toEqual([])
  })

  it('picks up a bot file with no enable switch', async () => {
    writeBotMd(app, 'e2e-scout', {
      description: 'e2e scout bot',
      displayName: 'Scout',
      body: 'SCOUT PERSONA.'
    })
    const scout = (await list()).find((b) => b.name === 'e2e-scout')
    expect(scout).toBeDefined()
    expect(scout!.displayName).toBe('Scout')
    expect(scout!.description).toBe('e2e scout bot')
    expect(scout!.basePath).toContain('e2e-scout.md')
    // 管线缺省即内置的 bot-chat —— 用户不写这一行也有一条能跑的管线
    expect(scout!.pipeline).toBe('bot-chat')
    // 槽位表原样外传（种子缺省填满内置管线的两个必填槽位）
    expect(scout!.agents).toEqual(DEFAULT_BOT_AGENTS)
    // 正文体量：它会进每个参与 agent 的系统提示词，设置页据此提醒
    expect(scout!.bodyChars).toBe('SCOUT PERSONA.'.length)
    expect(scout!.warnings).toEqual([])
  })

  it('ignores the retired agent-ish and v2 keys instead of rejecting the file', async () => {
    // 与 agent md 同口径：未知键忽略。曾经的 bot 键（respond / notes / greeting / suggestions）
    // 与写错地方的 agent 键（tools / model）如今都只是未知键 —— 一份老 bot md 升级后照常可用
    writeBotMd(app, 'e2e-legacy', {
      description: 'written against the v2 format',
      rawLines: [
        'shuvix-tools: read, grep',
        'shuvix-model: openai/gpt-4o',
        'shuvix-bot-respond: mention-only',
        'shuvix-bot-respond-to: all',
        'shuvix-bot-notes: false',
        'shuvix-bot-greeting: hello from the past',
        'shuvix-bot-suggestions: ["what changed"]'
      ]
    })
    const legacy = (await list()).find((b) => b.name === 'e2e-legacy')
    expect(legacy).toBeDefined()
    // 忽略是**静默**的：既不进 invalid 通道，也不产生「接受但有话说」的提示
    expect(legacy!.warnings).toEqual([])
    expect((await listInvalid()).some((i) => i.fileName === 'e2e-legacy.md')).toBe(false)
    // 被忽略的键不会漏进任何字段
    expect(legacy!.agents).toEqual(DEFAULT_BOT_AGENTS)
  })

  it('surfaces an unparseable definition through the invalid channel instead of dropping it', async () => {
    // description 是 bot md 的必填项（意图段的相关性判据）—— 定义区硬失败
    writeBotMd(app, 'e2e-broken', { description: '', rawLines: ['description: '] })
    expect((await list()).some((b) => b.name === 'e2e-broken')).toBe(false)
    const entry = (await listInvalid()).find((i) => i.fileName === 'e2e-broken.md')
    expect(entry).toBeDefined()
    expect(entry!.error).toMatch(/description/i)
  })

  it('rejects a slot table that is not a mapping', async () => {
    // 槽位表只校验形状（映射 + 合法槽位名 + 字符串值），槽位名本身开放给管线定义；
    // 形状不对 = 整份文件非法
    writeBotMd(app, 'e2e-badslots', { agents: {}, rawLines: ['shuvix-bot-agents: 5'] })
    expect((await list()).some((b) => b.name === 'e2e-badslots')).toBe(false)
    const entry = (await listInvalid()).find((i) => i.fileName === 'e2e-badslots.md')
    expect(entry).toBeDefined()
    expect(entry!.error).toContain('shuvix-bot-agents')
  })

  it('inspect resolves the slot table against the pipeline schema', async () => {
    writeBotMd(app, 'e2e-inspected', {
      description: 'inspect me',
      body: 'PERSONA.',
      // 两个必填槽位 + 一个管线没声明的额外槽位（指向不存在的 agent）
      agents: { intent: 'bot-intent', task: 'default', extra: 'ghost-agent' }
    })
    const r = await inspect('e2e-inspected')
    if ('error' in r) throw new Error(r.error)

    expect(r.pipeline).toEqual({ name: 'bot-chat', exists: true, concurrency: 'parallel' })
    // 管线声明的槽位按声明序在前（intent / task 必填，recheck 可选），bot 额外填的缀尾
    expect(r.slots.map((s) => [s.role, s.required])).toEqual([
      ['intent', true],
      ['task', true],
      ['recheck', false],
      ['extra', false]
    ])
    const byRole = Object.fromEntries(r.slots.map((s) => [s.role, s]))
    expect(byRole.intent).toMatchObject({ ref: 'bot-intent', missing: false })
    expect(byRole.task).toMatchObject({ ref: 'default', missing: false })
    // 没填 = 没有 ref，也谈不上 missing
    expect(byRole.recheck.ref).toBeUndefined()
    expect(byRole.recheck.missing).toBe(false)
    // 填了但那个 agent 不存在
    expect(byRole.extra).toMatchObject({ ref: 'ghost-agent', missing: true })
    // 管线里写的说明随槽位带出（设置页当提示语用）
    expect(typeof byRole.intent.description).toBe('string')
    expect(typeof byRole.task.description).toBe('string')

    expect(r.body).toEqual({ chars: 'PERSONA.'.length })
    expect(r.gateDegraded).toBeUndefined()
    // 笔记段没了，读数里也不该再有它的影子
    expect(r).not.toHaveProperty('notes')
  })

  it('creates a usable bot from the builtin template with just a name', async () => {
    const tpl = await app.main.eval<{ text: string }>(
      `window.api.bot.template({ name: 'e2e-fresh', description: 'made from the template' })`
    )
    expect(tpl.text).toContain('shuvix: bot v1')
    expect(tpl.text).toContain('name: e2e-fresh')
    // 模板预填两个必填槽位：内置门控 + 主会话基座档案（没有缺省表，漏填会在会话里可见地失败）
    expect(tpl.text).toMatch(/shuvix-bot-agents:\n(?:\s+\S+: \S+\n)*\s+intent: bot-intent\n/)
    expect(tpl.text).toMatch(/shuvix-bot-agents:\n(?:\s+\S+: \S+\n)*\s+task: default\n/)

    const created = await app.main.eval<{ success: boolean; name?: string; error?: string }>(
      `window.api.bot.create({ text: ${JSON.stringify(tpl.text)} })`
    )
    expect(created).toMatchObject({ success: true, name: 'e2e-fresh' })
    const fresh = (await list()).find((b) => b.name === 'e2e-fresh')
    expect(fresh?.pipeline).toBe('bot-chat')
    expect(fresh?.agents).toEqual({ intent: 'bot-intent', task: 'default' })
  })

  it('rejects an invalid save and leaves the file on disk untouched', async () => {
    const filePath = writeBotMd(app, 'e2e-keeper', { description: 'keeps its old content' })
    const before = readFileSync(filePath, 'utf-8')
    const res = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.bot.save({ originalName: 'e2e-keeper', text: ${JSON.stringify(
        '---\nshuvix: bot v1\nname: e2e-keeper\ndescription: still described\n' +
          'shuvix-bot-agents: nope\n---\n\nBODY.\n'
      )} })`
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shuvix-bot-agents/)
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
