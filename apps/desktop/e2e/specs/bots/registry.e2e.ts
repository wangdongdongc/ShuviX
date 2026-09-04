/**
 * Bot 注册表 e2e（M1′ / v3）—— 纯 md 驱动的端到端断言：
 * 往 ~/.shuvix/bots 丢一份 md，`bot:list` 立即看得见；非法文件不进列表但进 invalid 通道。
 *
 * **不内置任何 bot**（设计 §4.2）：目录里有什么就是什么，没有「内置 + 用户覆盖」两源之分；
 * 「新建 bot」走 `bot:template`（内置管线 + 两个必填槽位预填内置门控与主会话基座档案 +
 * 用户取的名字）。
 *
 * v3 起 bot 是一份**绑定**（身份 + 管线绑定块 + 正文），自己不再是 agent：
 * `shuvix-tools` / `shuvix-model` / `shuvix-bot-respond{,-to}` / `shuvix-bot-notes` /
 * `shuvix-bot-greeting` / `shuvix-bot-suggestions` 这些键写在 bot 上只是被忽略（不判非法）。
 * 列表项因此换成 `agents` + `bodyChars`；`bot:inspect` 换成按管线 input schema 现算的槽位表。
 *
 * 管线绑定是一个嵌套块 `shuvix-bot-pipeline: { workflow, agents, input }`，**workflow 必填、
 * 没有缺省**（模板会填内置 bot-chat，那是模板的事）。改制前的顶层 `shuvix-bot-agents` /
 * `shuvix-bot-input` 与标量 `shuvix-bot-pipeline` 不再读：撞见即整份拒绝并指明新写法（不迁移）——
 * 这两个键与上面那批「忽略」的键刻意不同待遇，因为它们承载的是真实配置，静默忽略等于把一个
 * 能跑的 bot 悄悄变成跑不起来的。
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
    // 管线 = 块里的 workflow 原样（种子写的是内置 bot-chat；解析器没有缺省）
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
    // 形状不对 = 整份文件非法（块经 rawLines 手写：种子的 agents 选项只会写映射）
    writeBotMd(app, 'e2e-badslots', {
      omitPipeline: true,
      rawLines: ['shuvix-bot-pipeline:', '  workflow: bot-chat', '  agents: 5']
    })
    expect((await list()).some((b) => b.name === 'e2e-badslots')).toBe(false)
    const entry = (await listInvalid()).find((i) => i.fileName === 'e2e-badslots.md')
    expect(entry).toBeDefined()
    expect(entry!.error).toContain("'shuvix-bot-pipeline.agents' must be a mapping")
  })

  it('rejects the retired flat keys with a message that points at the nested block', async () => {
    // 改制前的顶层写法（标量管线名 + 顶层槽位表）：存量文件视为失效、不迁移 —— 拒绝理由要
    // 指明新写法，而不是一句「缺 workflow」
    writeBotMd(app, 'e2e-flat', {
      omitPipeline: true,
      rawLines: [
        'shuvix-bot-pipeline: bot-chat',
        'shuvix-bot-agents:',
        '  intent: bot-intent',
        '  task: default'
      ]
    })
    expect((await list()).some((b) => b.name === 'e2e-flat')).toBe(false)
    const flat = (await listInvalid()).find((i) => i.fileName === 'e2e-flat.md')
    expect(flat?.error).toContain("'shuvix-bot-agents' is no longer supported")
    expect(flat?.error).toContain("'shuvix-bot-pipeline'")
    // 顶层 input 表同样退场 —— 哪怕新块写对了
    writeBotMd(app, 'e2e-flat-input', { rawLines: ['shuvix-bot-input:', '  greeting: hi'] })
    expect((await list()).some((b) => b.name === 'e2e-flat-input')).toBe(false)
    const flatInput = (await listInvalid()).find((i) => i.fileName === 'e2e-flat-input.md')
    expect(flatInput?.error).toContain("'shuvix-bot-input' is no longer supported")
  })

  it('has no default pipeline: no block, or a block without workflow, is invalid', async () => {
    writeBotMd(app, 'e2e-noblock', { omitPipeline: true })
    const noBlock = (await listInvalid()).find((i) => i.fileName === 'e2e-noblock.md')
    expect(noBlock?.error).toContain("'shuvix-bot-pipeline' is required")
    writeBotMd(app, 'e2e-noflow', {
      omitPipeline: true,
      rawLines: ['shuvix-bot-pipeline:', '  agents:', '    intent: bot-intent']
    })
    const noFlow = (await listInvalid()).find((i) => i.fileName === 'e2e-noflow.md')
    expect(noFlow?.error).toContain("'shuvix-bot-pipeline.workflow' must be the name of a workflow")
    const names = (await list()).map((b) => b.name)
    expect(names).not.toContain('e2e-noblock')
    expect(names).not.toContain('e2e-noflow')
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
    // 模板预填管线绑定块：内置 bot-chat（解析器没有缺省，这一行是模板写的）+ 两个必填槽位
    // （内置门控 + 主会话基座档案；没有缺省表，漏填会在会话里可见地失败）—— 槽位在 workflow 之下
    // 再嵌一层（4 空格）
    expect(tpl.text).toMatch(
      /shuvix-bot-pipeline:\n {2}workflow: bot-chat\n {2}agents:\n(?: {4}[\w-]+: \S+\n)* {4}intent: bot-intent\n/
    )
    expect(tpl.text).toMatch(
      /shuvix-bot-pipeline:\n {2}workflow: bot-chat\n {2}agents:\n(?: {4}[\w-]+: \S+\n)* {4}task: default\n/
    )
    expect(tpl.text).not.toContain('shuvix-bot-agents')

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
          'shuvix-bot-pipeline:\n  workflow: bot-chat\n  agents: nope\n---\n\nBODY.\n'
      )} })`
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shuvix-bot-pipeline\.agents/)
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
