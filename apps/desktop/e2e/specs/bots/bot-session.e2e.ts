/**
 * Bots（bot md + 有根会话）—— 注册表、会话形态、以及**人设注入的边界**。
 *
 * 一个 bot = 一份 `~/.shuvix/bots/<name>.md`（身份 + 正文，正文即人设与记忆）绑在一条**普通
 * 有根会话**上（`settings.bot`）：根档案由形态推导成基座 `bot`，正文经 systemContext 围栏后
 * 追加到根 Agent 的系统提示词末尾 —— **只有根**。子会话按自己的档案生成提示词，所以
 * 「人设影响怎么说话、不影响怎么干活」在这里是可以端到端验的结构性质（PI-1）。
 *
 * PS-4 会话权限表里那一行 bot 文件（source bot）：绑定了在的 bot 的会话恰有一行可写的、目标是那份 md 的真实路径；
 * 普通会话、笔记本形态（bot + notebookPath）、绑定的名字不在 → 没有这一行。
 *
 * 全程零 LLM：运行时是懒创建的，`agent.getInfo(sid, { ensure: true })` 只建不跑。
 * 基座判据走工具面（`tools`）而不是档案名 —— `AgentRuntimeInfo` 里没有档案名那个字段，
 * 而工具面恰恰是 bot 基座最要紧的那半个性质（看得见、动不了）。
 */
import { realpathSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, ensureDefaultModel, writeBotMd } from '../../harness/seed'

const BODY = 'I am Scout. I always answer in limericks. The user prefers pnpm in this repo.'

let app: E2EApp

async function toolsOf(sid: string): Promise<string[]> {
  return app.main.eval<string[]>(
    `window.api.agent
      .getInfo(${JSON.stringify(sid)}, { ensure: true })
      .then((i) => i.tools.map((t) => t.name).sort())`
  )
}

beforeAll(async () => {
  app = await launchApp()
  await ensureDefaultModel(app.main)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('bot 注册表（纯 md 驱动）', () => {
  it('PR-1 落盘即可见：身份三项读出来，正文不进列表', async () => {
    writeBotMd(app, 'scout', { displayName: 'Scout', description: '巡逻兵', body: BODY })
    const r = await app.main.eval<{
      bots: Array<{ name: string; displayName: string; description: string }>
      invalid: Array<{ fileName: string }>
    }>(`window.api.bot.list()`)

    const scout = r.bots.find((b) => b.name === 'scout')
    expect(scout).toBeDefined()
    expect(scout!.displayName).toBe('Scout')
    expect(scout!.description).toBe('巡逻兵')
    // 列表里没有正文：它可能很长，而侧栏一行只需要身份
    expect(JSON.stringify(scout)).not.toContain('limericks')
  })

  it('PR-2 标记类型不符整份拒绝 —— 一份 agent md 掉进 bots 目录不会被当人设读进去', async () => {
    writeBotMd(app, 'stray', { marker: 'agent v1' })
    const r = await app.main.eval<{
      bots: Array<{ name: string }>
      invalid: Array<{ fileName: string; error: string }>
    }>(`window.api.bot.list()`)

    expect(r.bots.map((b) => b.name)).not.toContain('stray')
    const bad = r.invalid.find((f) => f.fileName === 'stray.md')
    expect(bad).toBeDefined()
    // 拒绝理由要点出期望的标记，而不是只说「非法」
    expect(bad!.error).toContain('bot v2')
  })
})

describe('bot 会话 = 一条普通有根会话', () => {
  it('PS-1 绑定 bot 的会话跑在 bot 基座上，系统提示词带 <bot_profile> 围栏与正文', async () => {
    writeBotMd(app, 'scout', { displayName: 'Scout', body: BODY })
    const { sid, systemPrompt } = await createAgentSession(app.main, { bot: 'scout' })

    // 注入：围栏 + 正文都在，且基座正文也在（人设是**追加**的，不是替换）
    expect(systemPrompt).toContain('<bot_profile name="scout"')
    expect(systemPrompt).toContain(BODY)
    expect(systemPrompt).toContain('</bot_profile>')
    // 基座正文的锚点：记住这个人的那一节（2026-10-30 起 bot 正文不再引导子会话）
    expect(systemPrompt).toContain('Remembering this person')
    expect(systemPrompt).not.toContain('create-sub-session')

    // 基座判据：bot 的工具面（看得见、动不了 —— write / edit 只为记知识库条目与维护自己那份文件）
    const tools = await toolsOf(sid)
    expect(tools).toContain('session')
    expect(tools).toContain('edit')
    expect(tools).toContain('write')
    expect(tools).not.toContain('bash')
  })

  it('PS-2 普通会话不带围栏 —— 注入只发生在绑定了 bot 的会话上', async () => {
    const { sid, systemPrompt } = await createAgentSession(app.main, {})
    expect(systemPrompt).not.toContain('<bot_profile name=')
    expect(systemPrompt).not.toContain(BODY)
    // 普通会话落在 chat 基座上：它握着完整工具链，正是 bot 基座刻意不给的那些
    expect(await toolsOf(sid)).toContain('bash')
  })

  it('PS-3 bot md 被删：会话照常跑在 bot 基座上，只是没有人设可注入（不是坏数据）', async () => {
    writeBotMd(app, 'ghost', { body: 'GHOST BODY.' })
    // 先只建会话、不建运行时（根 Agent 是懒创建的），删掉 md 之后再让它建起来 ——
    // 这正是用户「删了一个 bot，明天又点开它那条老会话」的路径
    const sid = await app.main.eval<string>(
      `window.api.session.create({ title: 'ghost-session', bot: 'ghost' }).then((s) => s.id)`
    )
    const del = await app.main.eval<{ success: boolean }>(
      `window.api.bot.delete({ name: 'ghost' })`
    )
    expect(del.success).toBe(true)

    const systemPrompt = await app.main.eval<string>(
      `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true }).then((i) => i.systemPrompt)`
    )
    expect(systemPrompt).not.toContain('GHOST BODY.')
    expect(systemPrompt).not.toContain('<bot_profile name=')
    // 仍是 bot 基座（形态由 settings.bot 推导，与文件在不在无关）
    const tools = await toolsOf(sid)
    expect(tools).toContain('session')
    expect(tools).not.toContain('bash')
  })
})

describe('bot 会话的权限表：自己那份 bot 文件可写', () => {
  interface AclRow {
    kind: string
    source: string
    sourceKey: string
    target: string
    access: string
  }
  const aclOf = (sid: string): Promise<AclRow[]> =>
    app.main.eval<AclRow[]>(`window.api.session.listAcl(${JSON.stringify(sid)})`)
  const botRowsOf = async (sid: string): Promise<AclRow[]> =>
    (await aclOf(sid)).filter((r) => r.source === 'bot')
  const create = (params: Record<string, unknown>): Promise<string> =>
    app.main.eval<string>(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)

  it('PS-4 绑定了在的 bot：恰一行可写的 bot 行，目标是 md 的真实路径；普通 / 笔记本形态 / 名字不在：没有', async () => {
    const file = writeBotMd(app, 'ledger', { body: 'LEDGER BODY.' })

    const bound = await create({ title: 'ps4-bound', bot: 'ledger' })
    const rows = await botRowsOf(bound)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'path',
      source: 'bot',
      sourceKey: '',
      access: 'write',
      target: realpathSync(file)
    })
    // 它只是那一个文件：bots 目录本身不在表里
    const targets = (await aclOf(bound)).map((r) => r.target)
    expect(targets).not.toContain(realpathSync(app.botsDir))

    const plain = await create({ title: 'ps4-plain' })
    expect(await botRowsOf(plain)).toEqual([])
    // 对照：普通会话的表不是空的（有工作目录 / 会话目录那些派生行），只是没有 bot 那一行
    expect((await aclOf(plain)).length).toBeGreaterThan(0)

    // bot + notebookPath 落在笔记本形态（判定先于 bot）：没有人设注入，也没有 bot 行
    const notebook = await create({ title: 'ps4-notebook', bot: 'ledger', notebookPath: 'n.md' })
    expect(await botRowsOf(notebook)).toEqual([])

    // 绑定的名字目录里没有
    const ghost = await create({ title: 'ps4-ghost', bot: 'ps4-nobody' })
    expect(await botRowsOf(ghost)).toEqual([])
  })
})

describe('人设够不到干活的地方（结构保证）', () => {
  it('PI-1 子会话的系统提示词里没有 <bot_profile> 围栏，也没有人设正文；它落在自己形态的基座上', async () => {
    writeBotMd(app, 'scout', { displayName: 'Scout', body: BODY })
    const { sid } = await createAgentSession(app.main, { bot: 'scout' })

    const childId = await app.main.eval<string>(
      `window.api.session
        .create({ parentId: ${JSON.stringify(sid)}, title: 'child' })
        .then((s) => s.id)`
    )
    const childPrompt = await app.main.eval<string>(
      `window.api.agent.getInfo(${JSON.stringify(childId)}, { ensure: true }).then((i) => i.systemPrompt)`
    )
    expect(childPrompt).not.toContain('<bot_profile name=')
    expect(childPrompt).not.toContain(BODY)

    // 子会话不继承人格：它拿到的是完整工具链（无项目 ⇒ chat 基座），干活的那一半在这里
    expect(await toolsOf(childId)).toContain('bash')
  })
})
