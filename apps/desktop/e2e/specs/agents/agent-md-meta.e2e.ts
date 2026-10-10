/**
 * md 扩展元数据第二期：agent 的 `shuvix-model` / `shuvix-thinking` 由数据库补缺，写入只经属性卡的
 * 「ShuviX 设置」条（app-shell FrontmatterMetaStrip → IPC `mdMeta:*` → mdMetaService → md_attrs）。
 * 设计见 docs/md-metadata-design.md；契约在 chat-protocol mdMeta.ts。
 *
 *   E-1  内置 explore 的只读笔记：条显示 `agent:builtin:explore`、两行、标题行没有任何按钮（只读不给换新）；编辑器不可编辑
 *        而下拉可用；选 high → 注册表里 explore 的档位 = high、库里存着、随包 md 一个字节都没动；选回未设置 → 档位没了
 *   E-2  没有 id 的用户档案（用户裁决 2026-10-10：没有「分配 id」按钮）：控件照样出来、不显示 id、标题行没有按钮；
 *        打开不写文件；第一次选 low → 自动分配：文件恰多一行 `shuvix-id: <uuidv7>`（紧跟标记，其余逐字节不变），
 *        注册表 objectId 一致且档位 = low、库里存着；条就绪、出现「换新 id」。卡片字段槽位数不把条算进去
 *   E-2b 没有 id 时一口气连改两档 → 只分配一个 id；注册表与库都是后一档
 *   E-2c 写坏的 id（`shuvix-id: nope`）：同样直接出控件；第一次改设置把那一行**原地**换成 UUIDv7
 *   E-3  文件写了 low、补 high → 只有档位行注「以文件为准」、注册表仍 low；文件去掉那行 → 注册表 high、注没了
 *   E-4  内置 titler 写了 off → 注在；补 high 不改 off
 *   E-5  给 explore 补档位与模型 → 建覆盖副本：副本带内置 id、不带补缺行；生效的用户档案带两个补缺值、内置行被覆盖；
 *        副本的条照样显示这两个值、标题行恰有「换新 id」；换新 → 磁盘 id 变 UUID、explore 失去补缺、Saving… 收住
 *   E-6  内置 hook 与 bot 的笔记：有卡片、没有条；mdMeta.get 回 fillKeys []
 *   E-7  项目里的 agent md（项目笔记本）：没有条；mdMeta.get 回 null
 *   E-8  IPC 拒绝：旧 id → no-object-id；shuvix-tools → key-not-allowed；max → invalid-value；注册表不变
 *   E-9  A 的笔记里点 `[[meta-b]]` 在右侧预览 meta-b：预览里的卡片**没有**条（不借 A 的会话显示 A 的设置）
 *   E-11 两份文件共用一个 id → 两份都补上、两份的条都显示
 *   E-10 补缺值跨重启还在（stop({keepHome}) + launchApp({home})）—— 放最后，它换了实例
 *
 * ⚠️ 内置 md 是本仓的真目录（隔离实例只换 HOME）：这里只读它，绝不往里写 —— 条写的是数据库，不是文件。
 * 界面语言钉成 en（文案按 en.json 比）。用例间有顺序依赖：同一个主窗口一路点下去（E-10 依赖 E-2 的 meta-noid = low）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { MdMetaNoteView, MdMetaWriteResult } from '@shuvix/chat-protocol/mdMeta'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  agentsSidebarPane,
  botsPane,
  fmCardPane,
  hooksSidebarPane,
  mdMetaStripPane,
  notebookEditorPane,
  registryNotePane,
  sidebarPane,
  type AgentsSidebarPane,
  type MdMetaStripPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  createProject,
  waitFileWritten,
  waitRendererReady,
  writeAgentMd,
  writeBotMd
} from '../../harness/seed'

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const V = '0199d3a2-0000-7000-8000-000000000000'
/** E-11 两份文件共用的 id */
const W = '0199d3a2-1111-7111-8111-111111111111'
/** E-9 里 A 的 id */
const A_ID = '0199d3a2-2222-7222-8222-222222222222'
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MODEL = 'shuvix-model'
const THINKING = 'shuvix-thinking'
const EXPLORE_ID = 'agent:builtin:explore'
/** 模型 ref 原样存取（本层不对模型目录解析）—— 随便一串即可 */
const MODEL_REF = 'e2e-provider/e2e-model'

interface AgentRow {
  name: string
  source: 'builtin' | 'user'
  basePath: string
  objectId?: string
  model?: string
  thinkingLevel?: string
  overridden?: boolean
}

let app: E2EApp
let agents: AgentsSidebarPane
let note: RegistryNotePane
let strip: MdMetaStripPane

const agentPath = (fileName: string): string => join(app.agentsDir, fileName)
const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')
const agentRow = async (name: string, source: 'builtin' | 'user'): Promise<AgentRow | undefined> =>
  (await listAgents()).find((a) => a.name === name && a.source === source)
/** 生效的那一行（没被覆盖的） */
const activeRow = async (name: string): Promise<AgentRow | undefined> =>
  (await listAgents()).find((a) => a.name === name && !a.overridden)

const metaGet = (sessionId: string): Promise<MdMetaNoteView | null> =>
  app.main.eval(`window.api.mdMeta.get(${JSON.stringify({ sessionId })})`)
const metaSet = (params: {
  sessionId: string
  objectId: string
  key: string
  value: unknown
}): Promise<MdMetaWriteResult> =>
  app.main.eval(`window.api.mdMeta.setFill(${JSON.stringify(params)})`)

const userNoteId = (fileName: string): Promise<string> =>
  app.main.eval(`window.api.subAgent.openNote(${JSON.stringify({ fileName })}).then((s) => s.id)`)
const builtinNoteId = (name: string): Promise<string> =>
  app.main.eval(
    `window.api.subAgent.openBuiltinNote(${JSON.stringify({ name })}).then((s) => s.id)`
  )

/** 一份带 id 行（紧跟标记）的用户档案；回路径 */
function writeIdAgent(name: string, id: string, extra: string[] = [], body = 'BODY.'): string {
  mkdirSync(app.agentsDir, { recursive: true })
  const path = agentPath(`${name}.md`)
  writeFileSync(
    path,
    [
      '---',
      'shuvix: agent v1',
      `shuvix-id: ${id}`,
      `name: ${name}`,
      `description: ${name} fixture`,
      ...extra,
      '---',
      '',
      body,
      ''
    ].join('\n')
  )
  return path
}

const thinkingRow = async (): Promise<{ value: string; declared: boolean } | undefined> =>
  (await strip.state())?.rows.find((r) => r.key === THINKING)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  agents = agentsSidebarPane(app.main)
  note = registryNotePane(app.main)
  strip = mdMetaStripPane(app.main)
  await agents.expand()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await until(
    async () => (await agents.label()) === en.sidebar.agentsGroup,
    'agents group label in en'
  )
})

afterAll(async () => {
  await app.stop()
})

describe('属性卡「ShuviX 设置」条 —— agent 的补缺值', () => {
  it('E-1 内置 explore：条显示内置 id、两行、标题行没有按钮；只读编辑器里下拉照样能改；选 high → 注册表 high、库里存着、随包 md 不动；选回未设置 → 没了', async () => {
    const explore = (await agentRow('explore', 'builtin'))!
    const shipped = readFileSync(explore.basePath)

    await agents.openBuiltin('explore')
    await note.waitCard()
    await strip.waitReady(EXPLORE_ID)
    const s = (await strip.state())!
    expect(s.rows.map((r) => r.key)).toEqual([MODEL, THINKING])
    expect(s.headerButtons).toEqual([])
    expect(s.regenerate).toBe(false)
    expect(s.saving).toBe(false)
    expect(await note.editorEditable()).toBe(false)
    expect(s.rows.find((r) => r.key === THINKING)?.disabled).toBe(false)

    await strip.chooseThinking('high')
    await until(
      async () => (await agentRow('explore', 'builtin'))?.thinkingLevel === 'high',
      'registry explore thinking = high'
    )
    const sid = await builtinNoteId('explore')
    expect((await metaGet(sid))?.fill).toEqual({ [THINKING]: 'high' })
    await until(async () => (await thinkingRow())?.value === 'high', 'strip shows high')
    expect(readFileSync(explore.basePath).equals(shipped)).toBe(true)

    await strip.chooseThinking('')
    await until(
      async () => (await agentRow('explore', 'builtin'))?.thinkingLevel === undefined,
      'registry explore thinking cleared'
    )
    expect((await metaGet(sid))?.fill).toEqual({})
    expect(readFileSync(explore.basePath).equals(shipped)).toBe(true)
    await until(async () => (await strip.state())?.saving === false, 'no Saving… left')
  })

  it('E-2 没有 id 的用户档案：控件直接出来、没有按钮、打开不写文件；第一次选 low → 自动分配一行 UUIDv7（紧跟标记、其余逐字节不变）→ 注册表 objectId 一致、档位 low、库里存着；条就绪、出现换新；卡片字段槽位不把条算进去', async () => {
    const path = writeAgentMd(app, 'meta-noid', { description: 'E-2 fixture' })
    const original = readFileSync(path, 'utf8')
    await agents.refresh()
    await agents.selectUserRow('meta-noid.md')
    await note.waitCard()
    await strip.waitRows()

    const before = (await strip.state())!
    expect(before.objectId).toBeNull()
    expect(before.headerButtons).toEqual([])
    expect(before.regenerate).toBe(false)
    expect(before.saving).toBe(false)
    expect(before.rows.map((r) => r.key)).toEqual([MODEL, THINKING])
    expect(before.rows.find((r) => r.key === THINKING)?.value).toBe('')
    expect(before.warnings).toEqual([])
    // 卡片自己的四个字段槽位（模型 / 档位 / 工具 / 指令文件）—— 条的控件槽另起类名，不进这个数
    const [noIdCard] = await strip.cards()
    expect(noIdCard.strip).toBe(true)
    expect(noIdCard.fieldSlots).toBe(4)
    expect(noIdCard.metaSlots).toBe(2)
    await fmCardPane(app.main).waitReady({ slots: 4 })

    // 打开本身不写文件（id 只在第一次改设置时才分配）
    await sleep(500)
    expect(readFileSync(path, 'utf8')).toBe(original)

    await strip.chooseThinking('low')
    const written = await waitFileWritten(path, original, 'id line saved')
    const lines = written.split('\n')
    expect(lines[1]).toBe('shuvix: agent v1')
    expect(lines[2]).toMatch(/^shuvix-id: /)
    const id = lines[2].slice('shuvix-id: '.length)
    expect(id).toMatch(V7)
    expect(written.match(/^shuvix-id:/gm)).toHaveLength(1)
    expect(lines.filter((_, i) => i !== 2).join('\n')).toBe(original)

    await until(async () => {
      const row = await agentRow('meta-noid', 'user')
      return row?.objectId === id && row.thinkingLevel === 'low'
    }, 'registry meta-noid: objectId = assigned id, thinking = low')
    const sid = await userNoteId('meta-noid.md')
    expect((await metaGet(sid))?.fill).toEqual({ [THINKING]: 'low' })

    await strip.waitReady(id)
    const ready = (await strip.state())!
    expect(ready.rows.find((r) => r.key === THINKING)?.value).toBe('low')
    expect(ready.regenerate).toBe(true)
    expect(ready.headerButtons).toEqual(['regenerate'])
    expect(ready.saving).toBe(false)
    expect(ready.warnings).toEqual([])
    const [card] = await strip.cards()
    expect(card.strip).toBe(true)
    expect(card.fieldSlots).toBe(4)
    expect(card.metaSlots).toBe(2)
    await fmCardPane(app.main).waitReady({ slots: 4 })
    // meta-noid 留在 low：E-10 跨重启看的就是它
  })

  it('E-2b 没有 id 时一口气连改两档 → 只分配一个 id；注册表与库都是后一档，没有 Saving… 残留', async () => {
    const path = writeAgentMd(app, 'meta-burst', { description: 'E-2b fixture' })
    const original = readFileSync(path, 'utf8')
    await agents.refresh()
    await agents.selectUserRow('meta-burst.md')
    await note.waitCard()
    await strip.waitRows()

    await strip.chooseThinkingBurst(['low', 'medium'])
    const written = await waitFileWritten(path, original, 'burst id line saved')
    expect(written.match(/^shuvix-id:/gm)).toHaveLength(1)
    const id = /^shuvix-id: (.*)$/m.exec(written)?.[1] ?? ''
    expect(id).toMatch(V7)

    await until(async () => {
      const row = await agentRow('meta-burst', 'user')
      return row?.objectId === id && row.thinkingLevel === 'medium'
    }, 'registry meta-burst thinking = medium')
    const sid = await userNoteId('meta-burst.md')
    expect((await metaGet(sid))?.fill).toEqual({ [THINKING]: 'medium' })
    await strip.waitReady(id)
    expect((await thinkingRow())?.value).toBe('medium')
    // 稍等再读一次：文件里仍只有一行 id（没有第二次分配追着写进来）
    await sleep(500)
    expect(readFileSync(path, 'utf8').match(/^shuvix-id:/gm)).toHaveLength(1)
  })

  it('E-2c 写坏的 id（shuvix-id: nope）：控件直接出来、不显示 id、没有按钮；选 high → 那一行原地换成 UUIDv7，其余逐字节不变；注册表 objectId 一致、档位 high', async () => {
    const path = writeAgentMd(app, 'meta-malformed', {
      description: 'E-2c fixture',
      rawLines: ['shuvix-id: nope']
    })
    const original = readFileSync(path, 'utf8')
    await agents.refresh()
    await agents.selectUserRow('meta-malformed.md')
    await note.waitCard()
    await strip.waitRows()
    const before = (await strip.state())!
    expect(before.objectId).toBeNull()
    expect(before.headerButtons).toEqual([])
    expect(before.rows.map((r) => r.key)).toEqual([MODEL, THINKING])

    await strip.chooseThinking('high')
    const written = await waitFileWritten(path, original, 'malformed id replaced')
    expect(written.match(/^shuvix-id:/gm)).toHaveLength(1)
    const id = /^shuvix-id: (.*)$/m.exec(written)?.[1] ?? ''
    expect(id).toMatch(V7)
    // 原地替换：把新 id 换回 nope 就是原文件
    expect(written.replace(`shuvix-id: ${id}`, 'shuvix-id: nope')).toBe(original)

    await until(async () => {
      const row = await agentRow('meta-malformed', 'user')
      return row?.objectId === id && row.thinkingLevel === 'high'
    }, 'registry meta-malformed: objectId = new id, thinking = high')
    await strip.waitReady(id)
    expect((await thinkingRow())?.value).toBe('high')
  })

  it('E-3 文件写了 low、补 high：只有档位行注「以文件为准」、注册表仍 low；文件去掉那行 → 注册表 high、注没了', async () => {
    const path = writeIdAgent('meta-declared', U, ['shuvix-thinking: low'])
    await agents.refresh()
    await agents.selectUserRow('meta-declared.md')
    await note.waitCard()
    await strip.waitReady(U)

    await strip.chooseThinking('high')
    await until(async () => (await thinkingRow())?.value === 'high', 'strip shows high')
    const rows = (await strip.state())!.rows
    expect(rows.find((r) => r.key === THINKING)?.declared).toBe(true)
    expect(rows.find((r) => r.key === MODEL)?.declared).toBe(false)
    expect((await agentRow('meta-declared', 'user'))?.thinkingLevel).toBe('low')

    writeFileSync(path, readFileSync(path, 'utf8').replace('shuvix-thinking: low\n', ''))
    await agents.refresh()
    await until(
      async () => (await agentRow('meta-declared', 'user'))?.thinkingLevel === 'high',
      'registry falls back to the fill once the file stops declaring'
    )
    await until(
      async () => (await thinkingRow())?.declared === false,
      'declared note gone after the file changed'
    )
  })

  it('E-4 内置 titler 写了 off：档位行注着；补 high 不改 off', async () => {
    await agents.openBuiltin('titler')
    await note.waitCard()
    await strip.waitReady('agent:builtin:titler')
    const rows = (await strip.state())!.rows
    expect(rows.find((r) => r.key === THINKING)?.declared).toBe(true)
    expect(rows.find((r) => r.key === MODEL)?.declared).toBe(false)

    await strip.chooseThinking('high')
    const sid = await builtinNoteId('titler')
    await until(async () => (await metaGet(sid))?.fill[THINKING] === 'high', 'titler fill stored')
    expect((await agentRow('titler', 'builtin'))?.thinkingLevel).toBe('off')
    // 收尾：别让这条补缺漏进后面的用例
    await strip.chooseThinking('')
    await until(
      async () => (await metaGet(sid))?.fill[THINKING] === undefined,
      'titler fill cleared'
    )
  })

  it('E-5 explore 补上档位与模型 → 覆盖副本带内置 id、不带补缺行；生效的副本带两个值、内置被覆盖；副本的条照显并给换新；换新 → 磁盘 id 变 UUID、explore 失去补缺', async () => {
    await agents.openBuiltin('explore')
    await note.waitCard()
    await strip.waitReady(EXPLORE_ID)
    await strip.chooseThinking('high')
    await until(
      async () => (await agentRow('explore', 'builtin'))?.thinkingLevel === 'high',
      'explore thinking = high'
    )
    const sid = await builtinNoteId('explore')
    expect(
      await metaSet({ sessionId: sid, objectId: EXPLORE_ID, key: MODEL, value: MODEL_REF })
    ).toEqual({ success: true })
    await until(
      async () => (await agentRow('explore', 'builtin'))?.model === MODEL_REF,
      'explore model filled'
    )

    await agents.pickBuiltinRowMenu('explore', 'create-override')
    const copyPath = agentPath('explore.md')
    await until(() => existsSync(copyPath), 'explore.md written')
    const copy = readFileSync(copyPath, 'utf8')
    expect(copy.split('\n')[2]).toBe(`shuvix-id: ${EXPLORE_ID}`)
    expect(copy).not.toMatch(/^shuvix-thinking:/m)
    expect(copy).not.toMatch(/^shuvix-model:/m)

    await until(async () => {
      const active = await activeRow('explore')
      return (
        active?.source === 'user' && active.thinkingLevel === 'high' && active.model === MODEL_REF
      )
    }, 'override copy carries both fills')
    expect((await agentRow('explore', 'builtin'))?.overridden).toBe(true)

    await until(
      async () => (await agents.activeRow())?.row === 'explore.md',
      'override note active'
    )
    await strip.waitReady(EXPLORE_ID)
    await until(async () => (await thinkingRow())?.value === 'high', 'copy strip shows high')
    const copyStrip = (await strip.state())!
    expect(copyStrip.regenerate).toBe(true)
    expect(copyStrip.headerButtons).toEqual(['regenerate'])

    await strip.regenerate()
    const rewritten = await waitFileWritten(copyPath, copy, 'regenerated id saved')
    const newId = /^shuvix-id: (.*)$/m.exec(rewritten)?.[1] ?? ''
    expect(newId).toMatch(V7)
    expect(rewritten.replace(`shuvix-id: ${newId}`, `shuvix-id: ${EXPLORE_ID}`)).toBe(copy)
    await until(async () => {
      const active = await activeRow('explore')
      return (
        active?.source === 'user' &&
        active.objectId === newId &&
        active.thinkingLevel === undefined &&
        active.model === undefined
      )
    }, 'explore copy lost the fill with its new id')
    // waitReady 也等 Saving… 收住（换新 id 走同一个写入队列）
    await strip.waitReady(newId)
    expect((await strip.state())?.saving).toBe(false)
    expect((await thinkingRow())?.value).toBe('')
  })

  it('E-6 内置 hook 与 bot 的笔记：有卡片、没有条；mdMeta.get 回 fillKeys []', async () => {
    const hooks = hooksSidebarPane(app.main)
    await hooks.expand()
    await hooks.openBuiltin('auto-title')
    await note.waitCard()
    const hookSid = await app.main.eval<string>(
      `window.api.hook.openBuiltinNote({ name: 'auto-title' }).then((s) => s.id)`
    )
    const hookView = await metaGet(hookSid)
    expect(hookView).toMatchObject({ kind: 'hook', fillKeys: [], fill: {} })
    await sleep(500)
    expect(await strip.present()).toBe(false)

    writeBotMd(app, 'meta-bot')
    const bots = botsPane(app.main)
    await bots.expand()
    await bots.refresh()
    await bots.selectRow('meta-bot')
    await note.waitCard()
    const botSid = await app.main.eval<string>(
      `window.api.bot.openNote({ fileName: 'meta-bot.md' }).then((s) => s.id)`
    )
    expect(await metaGet(botSid)).toMatchObject({ kind: 'bot', fillKeys: [], fill: {} })
    await sleep(500)
    expect(await strip.present()).toBe(false)
  })

  it('E-7 项目里的 agent md（项目笔记本）：有卡片、没有条；mdMeta.get 回 null', async () => {
    const projDir = join(app.home, 'proj-md-meta')
    mkdirSync(projDir, { recursive: true })
    const notePath = join(projDir, 'project-agent.md')
    writeFileSync(
      notePath,
      [
        '---',
        'shuvix: agent v1',
        `shuvix-id: ${V}`,
        'name: project-agent',
        '---',
        '',
        'P.',
        ''
      ].join('\n')
    )
    const project = await createProject(app.main, { name: 'MdMetaProj', path: projDir })
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ projectId: project.id, notebookPath: notePath })}).then((s) => s.id)`
    )
    expect(await metaGet(sid)).toBeNull()
    await until(
      () => sidebarPane(app.main).openSession('project-agent.md'),
      'project notebook opened'
    )
    await note.waitCard()
    await sleep(500)
    expect(await strip.present()).toBe(false)
  })

  it('E-8 IPC 拒绝：旧 id → no-object-id；shuvix-tools → key-not-allowed；max → invalid-value；注册表不变', async () => {
    writeIdAgent('meta-refuse', U)
    await agents.refresh()
    const sid = await userNoteId('meta-refuse.md')
    const before = await agentRow('meta-refuse', 'user')
    expect(before?.objectId).toBe(U)

    expect(await metaSet({ sessionId: sid, objectId: V, key: THINKING, value: 'high' })).toEqual({
      success: false,
      reason: 'no-object-id'
    })
    expect(
      await metaSet({ sessionId: sid, objectId: U, key: 'shuvix-tools', value: 'bash' })
    ).toEqual({ success: false, reason: 'key-not-allowed' })
    expect(
      await metaSet({ sessionId: sid, objectId: U, key: THINKING, value: 'max' })
    ).toMatchObject({ success: false, reason: 'invalid-value' })
    expect(await agentRow('meta-refuse', 'user')).toEqual(before)
  })

  it('E-9 A 的笔记里点 [[meta-b]] → 右侧预览 meta-b 的卡片没有条（不借 A 的会话显示 A 的设置）', async () => {
    writeIdAgent('meta-b', V, [], 'B BODY.')
    writeIdAgent('meta-a', A_ID, [], 'See [[meta-b]] for details.')
    await agents.refresh()
    await agents.selectUserRow('meta-a.md')
    await note.waitCard()
    await strip.waitReady(A_ID)

    const editor = notebookEditorPane(app.main)
    await until(
      async () => (await editor.wikiLinkStatus('meta-b')) === 'resolved',
      '[[meta-b]] resolved'
    )
    await editor.clickWikiLink('meta-b')
    await until(async () => (await strip.cards()).length === 2, 'preview card mounted')
    // 预览里的卡片挂完之后再多等一会儿：条是异步挂的（get 回来才渲染）
    await sleep(800)
    const cards = await strip.cards()
    const own = cards.find((c) => c.name === 'meta-a')
    const preview = cards.find((c) => c.name === 'meta-b')
    expect(own?.strip).toBe(true)
    expect(preview).toBeDefined()
    expect(preview!.strip).toBe(false)
    expect(preview!.metaSlots).toBe(0)
    expect(preview!.text).not.toContain(en.notebook.frontmatter.metaSaving)
    expect(preview!.text).not.toContain(en.notebook.frontmatter.metaTitle)
  })

  it('E-11 两份文件共用一个 id：两份都补上，两份的条都显示同一个值', async () => {
    writeIdAgent('meta-twin-a', W)
    writeIdAgent('meta-twin-b', W)
    await agents.refresh()
    const sid = await userNoteId('meta-twin-a.md')
    expect(await metaSet({ sessionId: sid, objectId: W, key: THINKING, value: 'medium' })).toEqual({
      success: true
    })
    await until(async () => {
      const [a, b] = await Promise.all([
        agentRow('meta-twin-a', 'user'),
        agentRow('meta-twin-b', 'user')
      ])
      return a?.thinkingLevel === 'medium' && b?.thinkingLevel === 'medium'
    }, 'both twins filled')

    await agents.selectUserRow('meta-twin-b.md')
    await note.waitCard()
    await strip.waitReady(W)
    await until(async () => (await thinkingRow())?.value === 'medium', 'twin-b strip shows medium')
  })

  it('E-10 补缺值跨重启还在', async () => {
    const home = app.home
    await app.stop({ keepHome: true })
    app = (await launchApp({ home })) as E2EApp
    await waitRendererReady(app.main)
    await until(
      async () => (await agentRow('meta-noid', 'user'))?.thinkingLevel === 'low',
      'meta-noid fill survived the restart'
    )
    expect((await agentRow('meta-twin-a', 'user'))?.thinkingLevel).toBe('medium')
    expect((await agentRow('explore', 'builtin'))?.model).toBe(MODEL_REF)
  })
})
