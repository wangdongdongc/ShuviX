/**
 * md 扩展元数据：agent 的 `shuvix-model` / `shuvix-thinking` 由数据库补缺，**就在属性卡自己的那一行上改**
 * （用户裁决 2026-10-10：app-shell FrontmatterFillField → metaWriteQueue → IPC `mdMeta:*` → mdMetaService →
 * md_attrs）；卡片下面的「ShuviX 设置」条只剩内置 hook / 安全策略的停用开关。
 * 设计见 docs/md-metadata-design.md；契约在 chat-protocol mdMeta.ts。
 *
 *   E-1  内置 explore 的只读笔记：编辑器不可编辑、工具行禁用，档位与模型两行可改、挂「ShuviX 设置」小标；选 high →
 *        注册表 high、库里存着、随包 md 一个字节都没动；选回未设置 → 没了；agent 卡上没有条
 *   E-2  没有 id 的用户档案：选 low → 写进文件（`shuvix-thinking: low`，自动保存），不插 shuvix-id、库里没有、
 *        注册表 low、没有条
 *   E-3  文件写了 low、库里补了 high（经 IPC，文件带 id）→ 行是 low 不挂小标、注册表 low；外部改掉那一行 →
 *        行显示 high 挂小标、注册表 high；在这一行选「未设置」→ 清掉补缺值（不写文件）→ 注册表没有档位、小标没了
 *   E-4  内置 titler 写了 off：档位行 off、禁用、不挂小标；模型行可改、挂小标；库里补 high 不改 off
 *   E-5  给 explore 补档位与模型 → 建覆盖副本：副本带内置 id、不带补缺行；生效的副本带两个补缺值；副本卡片两行都挂
 *        小标；在副本上选 low → 写进文件、小标没了、注册表 low、模型照旧补着
 *   E-6  内置 auto-title 的笔记：有条、开关是开着的、没有补缺行；mdMeta.get {kind:'hook', fillKeys:[], enabled:true}；
 *        bot 的笔记没有条，它的 mdMeta.get 没有 enabled
 *   E-7  项目里的 agent md（项目笔记本）：mdMeta.get 回 null、没有条；它的 id 下存着补缺值，档位行也不挂小标
 *   E-8  IPC 拒绝：旧 id → no-object-id；shuvix-tools → key-not-allowed；minimal → invalid-value；setEnabled 收到 agent id /
 *        UUID / 不存在的内置 → key-not-allowed、非布尔 → invalid-value；注册表不变
 *   E-9  A 的卡片有补缺行、显示 A 存的值并挂小标；A 的笔记里点 `[[meta-b]]` → meta-b.md 在它自己的 md 窗口打开
 *        （它也存着补缺值）：那条内存会话不是注册表笔记，卡上不显示 B 的补缺值、没有小标、没有条（也不借 A 的会话）；
 *        主窗口里仍只有 A 那一张卡
 *   E-11 两份文件共用一个 id：经 IPC 补 medium → twin-b 的档位行显示 medium、挂小标
 *   E-10 补缺值跨重启还在（stop({keepHome}) + launchApp({home}))—— 放最后，它换了实例
 *
 * ⚠️ 内置 md 是本仓的真目录（隔离实例只换 HOME）：这里只读它，绝不往里写 —— 只读笔记写的是数据库，不是文件。
 * 界面语言钉成 en（文案按 en.json 比）。用例间有顺序依赖：同一个主窗口一路点下去（E-10 依赖 E-5 与 E-11 存的值）。
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
  fmFillPane,
  hooksSidebarPane,
  metaStripPane,
  notebookEditorPane,
  registryNotePane,
  sidebarPane,
  type AgentsSidebarPane,
  type FmFillPane,
  type MetaStripPane,
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
/** E-7 项目文件（以及借来存补缺值的那份用户档案）共用的 id */
const P_ID = '0199d3a2-3333-7333-8333-333333333333'
/** E-8 那份档案的 id */
const R_ID = '0199d3a2-4444-7444-8444-444444444444'
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
let fill: FmFillPane
let strip: MetaStripPane

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
const metaUnset = (params: {
  sessionId: string
  objectId: string
  key: string
}): Promise<MdMetaWriteResult> =>
  app.main.eval(`window.api.mdMeta.unsetFill(${JSON.stringify(params)})`)
const metaSetEnabled = (params: unknown): Promise<MdMetaWriteResult> =>
  app.main.eval(`window.api.mdMeta.setEnabled(${JSON.stringify(params)})`)

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

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  agents = agentsSidebarPane(app.main)
  note = registryNotePane(app.main)
  fill = fmFillPane(app.main)
  strip = metaStripPane(app.main)
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

describe('属性卡上的补缺值 —— agent 的模型与思考档位', () => {
  it('E-1 内置 explore：编辑器只读、工具行禁用，档位与模型两行可改并挂小标；选 high → 注册表 high、库里存着、随包 md 不动；选回未设置 → 没了；没有条', async () => {
    const explore = (await agentRow('explore', 'builtin'))!
    const shipped = readFileSync(explore.basePath)

    await agents.openBuiltin('explore')
    await note.waitCard()
    const thinking = await fill.waitRow(
      THINKING,
      (r) => r.wrapped && !r.disabled,
      'explore thinking row editable'
    )
    expect(thinking).toMatchObject({ value: '', tagged: true, error: false, warning: false })
    const model = await fill.waitRow(MODEL, (r) => r.wrapped && !r.disabled, 'model row editable')
    expect(model.tagged).toBe(true)
    expect((await fill.row('shuvix-tools'))?.disabled).toBe(true)
    expect(await note.editorEditable()).toBe(false)

    await fill.chooseThinking('high')
    await until(
      async () => (await agentRow('explore', 'builtin'))?.thinkingLevel === 'high',
      'registry explore thinking = high'
    )
    const sid = await builtinNoteId('explore')
    expect((await metaGet(sid))?.fill).toEqual({ [THINKING]: 'high' })
    await fill.waitRow(THINKING, (r) => r.value === 'high' && r.tagged, 'row shows high')
    expect(readFileSync(explore.basePath).equals(shipped)).toBe(true)

    await fill.chooseThinking('')
    await until(
      async () => (await agentRow('explore', 'builtin'))?.thinkingLevel === undefined,
      'registry explore thinking cleared'
    )
    expect((await metaGet(sid))?.fill).toEqual({})
    await fill.waitRow(THINKING, (r) => r.value === '' && !r.error, 'row cleared')
    expect(readFileSync(explore.basePath).equals(shipped)).toBe(true)
    expect(await strip.present()).toBe(false)
    expect((await fill.cards())[0].strip).toBe(false)
  })

  it('E-2 没有 id 的用户档案：选 low → 写进文件（不插 shuvix-id）、库里没有、注册表 low、没有条', async () => {
    const path = writeAgentMd(app, 'meta-noid', { description: 'E-2 fixture' })
    const original = readFileSync(path, 'utf8')
    await agents.refresh()
    await agents.selectUserRow('meta-noid.md')
    await note.waitCard()
    const before = await fill.waitRow(THINKING, (r) => r.wrapped, 'thinking fill row mounted')
    expect(before).toMatchObject({ value: '', disabled: false, tagged: false })

    await fill.chooseThinking('low')
    const written = await waitFileWritten(path, original, 'thinking written into the file')
    expect(written).toMatch(/^shuvix-thinking: low$/m)
    expect(written).not.toMatch(/^shuvix-id:/m)

    await until(
      async () => (await agentRow('meta-noid', 'user'))?.thinkingLevel === 'low',
      'registry meta-noid thinking = low'
    )
    expect((await agentRow('meta-noid', 'user'))?.objectId).toBeUndefined()
    const sid = await userNoteId('meta-noid.md')
    expect((await metaGet(sid))?.fill).toEqual({})
    await fill.waitRow(THINKING, (r) => r.value === 'low' && !r.tagged, 'row shows the file value')
    expect(await strip.present()).toBe(false)
  })

  it('E-3 文件写了 low、库里补 high → 行 low 不挂小标、注册表 low；外部去掉那一行 → 行 high 挂小标、注册表 high；在这一行选未设置 → 清掉补缺值', async () => {
    const path = writeIdAgent('meta-declared', U, ['shuvix-thinking: low'])
    await agents.refresh()
    const sid = await userNoteId('meta-declared.md')
    expect(await metaSet({ sessionId: sid, objectId: U, key: THINKING, value: 'high' })).toEqual({
      success: true
    })
    await agents.selectUserRow('meta-declared.md')
    await note.waitCard()
    await fill.waitRow(
      THINKING,
      (r) => r.wrapped && r.value === 'low' && !r.tagged,
      'declared low wins, no tag'
    )
    expect((await agentRow('meta-declared', 'user'))?.thinkingLevel).toBe('low')

    writeFileSync(path, readFileSync(path, 'utf8').replace('shuvix-thinking: low\n', ''))
    await agents.refresh()
    await until(
      async () => (await agentRow('meta-declared', 'user'))?.thinkingLevel === 'high',
      'registry falls back to the fill once the file stops declaring'
    )
    await fill.waitRow(
      THINKING,
      (r) => r.value === 'high' && r.tagged,
      'row shows the stored fill, tagged'
    )
    const onDisk = readFileSync(path, 'utf8')

    await fill.chooseThinking('')
    await until(
      async () => (await agentRow('meta-declared', 'user'))?.thinkingLevel === undefined,
      'fill cleared from the row'
    )
    expect((await metaGet(sid))?.fill).toEqual({})
    await fill.waitRow(THINKING, (r) => r.value === '' && !r.tagged, 'row plain again')
    // 清的是补缺值：文件一个字节都没动
    await sleep(500)
    expect(readFileSync(path, 'utf8')).toBe(onDisk)
  })

  it('E-4 内置 titler 写了 off：档位行 off、禁用、不挂小标；模型行可改并挂小标；库里补 high 不改 off', async () => {
    await agents.openBuiltin('titler')
    await note.waitCard()
    const thinking = await fill.waitRow(THINKING, (r) => r.wrapped, 'titler thinking row mounted')
    expect(thinking).toMatchObject({ value: 'off', disabled: true, tagged: false })
    await fill.waitRow(MODEL, (r) => r.wrapped && !r.disabled && r.tagged, 'titler model row')

    const sid = await builtinNoteId('titler')
    expect(
      await metaSet({
        sessionId: sid,
        objectId: 'agent:builtin:titler',
        key: THINKING,
        value: 'high'
      })
    ).toEqual({ success: true })
    expect((await metaGet(sid))?.fill[THINKING]).toBe('high')
    await sleep(300)
    expect(await fill.row(THINKING)).toMatchObject({ value: 'off', disabled: true, tagged: false })
    expect((await agentRow('titler', 'builtin'))?.thinkingLevel).toBe('off')
    // 收尾：别让这条补缺漏进后面的用例
    expect(
      await metaUnset({ sessionId: sid, objectId: 'agent:builtin:titler', key: THINKING })
    ).toEqual({ success: true })
  })

  it('E-5 explore 补上档位与模型 → 覆盖副本带内置 id、不带补缺行；生效的副本带两个值；副本卡片两行挂小标；在副本上选 low → 写进文件、小标没了、注册表 low、模型照旧', async () => {
    await agents.openBuiltin('explore')
    await note.waitCard()
    await fill.waitRow(THINKING, (r) => r.wrapped && !r.disabled, 'explore thinking row editable')
    await fill.chooseThinking('high')
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
    await fill.waitRow(
      THINKING,
      (r) => r.value === 'high' && r.tagged && !r.disabled,
      'copy thinking row shows the fill'
    )
    await fill.waitRow(MODEL, (r) => r.tagged && !r.disabled, 'copy model row shows the fill')

    await fill.chooseThinking('low')
    const rewritten = await waitFileWritten(copyPath, copy, 'thinking written into the copy')
    expect(rewritten).toMatch(/^shuvix-thinking: low$/m)
    expect(rewritten.split('\n')[2]).toBe(`shuvix-id: ${EXPLORE_ID}`)
    await until(async () => {
      const active = await activeRow('explore')
      return (
        active?.source === 'user' && active.thinkingLevel === 'low' && active.model === MODEL_REF
      )
    }, 'copy: thinking from the file, model still filled')
    await fill.waitRow(THINKING, (r) => r.value === 'low' && !r.tagged, 'tag gone once declared')
    expect((await fill.row(MODEL))?.tagged).toBe(true)
  })

  it('E-6 内置 auto-title 的笔记：有条、开关开着、没有补缺行；mdMeta.get 带 enabled:true；bot 的笔记没有条、视图没有 enabled', async () => {
    const hooks = hooksSidebarPane(app.main)
    await hooks.expand()
    await hooks.openBuiltin('auto-title')
    await note.waitCard()
    const hookSid = await app.main.eval<string>(
      `window.api.hook.openBuiltinNote({ name: 'auto-title' }).then((s) => s.id)`
    )
    expect(await metaGet(hookSid)).toMatchObject({
      kind: 'hook',
      fillKeys: [],
      fill: {},
      enabled: true
    })
    await strip.waitStrip()
    expect(await strip.state()).toMatchObject({
      state: 'on',
      disabledNote: null,
      rows: ['enabled']
    })
    const [hookCard] = await fill.cards()
    expect(hookCard.strip).toBe(true)
    expect(hookCard.fillWrappers).toBe(0)

    writeBotMd(app, 'meta-bot')
    const bots = botsPane(app.main)
    await bots.expand()
    await bots.refresh()
    await bots.selectRow('meta-bot')
    await note.waitCard()
    const botSid = await app.main.eval<string>(
      `window.api.bot.openNote({ fileName: 'meta-bot.md' }).then((s) => s.id)`
    )
    const botView = await metaGet(botSid)
    expect(botView).toMatchObject({ kind: 'bot', fillKeys: [], fill: {} })
    expect(botView).not.toHaveProperty('enabled')
    await sleep(500)
    expect(await strip.present()).toBe(false)
  })

  it('E-7 项目里的 agent md（项目笔记本）：mdMeta.get 回 null、没有条；同一个 id 下存着补缺值，档位行也不挂小标', async () => {
    // 借一份用户档案（同一个 id）把补缺值存进去：项目文件本身不是注册表笔记，写不进
    writeIdAgent('meta-proj-twin', P_ID)
    await agents.refresh()
    const twinSid = await userNoteId('meta-proj-twin.md')
    expect(
      await metaSet({ sessionId: twinSid, objectId: P_ID, key: THINKING, value: 'high' })
    ).toEqual({ success: true })

    const projDir = join(app.home, 'proj-md-meta')
    mkdirSync(projDir, { recursive: true })
    const notePath = join(projDir, 'project-agent.md')
    writeFileSync(
      notePath,
      [
        '---',
        'shuvix: agent v1',
        `shuvix-id: ${P_ID}`,
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
    await until(
      async () => (await fill.cards())[0]?.name === 'project-agent',
      'project agent card in front'
    )
    await sleep(500)
    expect(await strip.present()).toBe(false)
    const row = await fill.row(THINKING)
    expect(row).not.toBeNull()
    expect(row!.value).toBe('')
    expect(row!.tagged).toBe(false)
  })

  it('E-8 IPC 拒绝：旧 id / 白名单外的键 / 不合法的值 / setEnabled 的 agent id、UUID、不存在的内置、非布尔；注册表不变', async () => {
    writeIdAgent('meta-refuse', R_ID)
    await agents.refresh()
    const id = R_ID
    const sid = await userNoteId('meta-refuse.md')
    const before = await agentRow('meta-refuse', 'user')
    expect(before?.objectId).toBe(id)

    expect(await metaSet({ sessionId: sid, objectId: V, key: THINKING, value: 'high' })).toEqual({
      success: false,
      reason: 'no-object-id'
    })
    expect(
      await metaSet({ sessionId: sid, objectId: id, key: 'shuvix-tools', value: 'bash' })
    ).toEqual({ success: false, reason: 'key-not-allowed' })
    expect(
      await metaSet({ sessionId: sid, objectId: id, key: THINKING, value: 'minimal' })
    ).toMatchObject({ success: false, reason: 'invalid-value' })

    for (const objectId of [EXPLORE_ID, id, 'hook:builtin:nonexistent']) {
      expect(await metaSetEnabled({ objectId, enabled: false }), objectId).toMatchObject({
        success: false,
        reason: 'key-not-allowed'
      })
    }
    expect(
      await metaSetEnabled({ objectId: 'hook:builtin:auto-title', enabled: 'false' })
    ).toMatchObject({ success: false, reason: 'invalid-value' })
    expect(await agentRow('meta-refuse', 'user')).toEqual(before)
    const titleHook = (
      await app.main.eval<Array<{ name: string; source: string; disabled?: boolean }>>(
        'window.api.hook.list()'
      )
    ).find((h) => h.name === 'auto-title' && h.source === 'builtin')
    expect(titleHook?.disabled).toBeUndefined()
  })

  it('E-9 A 的卡片有补缺行、显示 A 存的值并挂小标；点 [[meta-b]] 在 md 窗口打开 meta-b，那张卡（它自己也存着值）不显示补缺值、没有小标、没有条', async () => {
    writeIdAgent('meta-b', V, [], 'B BODY.')
    writeIdAgent('meta-a', A_ID, [], 'See [[meta-b]] for details.')
    await agents.refresh()
    const aSid = await userNoteId('meta-a.md')
    const bSid = await userNoteId('meta-b.md')
    expect(
      await metaSet({ sessionId: aSid, objectId: A_ID, key: THINKING, value: 'high' })
    ).toEqual({ success: true })
    expect(await metaSet({ sessionId: bSid, objectId: V, key: THINKING, value: 'medium' })).toEqual(
      { success: true }
    )

    await agents.selectUserRow('meta-a.md')
    await note.waitCard()
    await fill.waitRow(THINKING, (r) => r.value === 'high' && r.tagged, "A's own fill shown")

    const editor = notebookEditorPane(app.main)
    await until(
      async () => (await editor.wikiLinkStatus('meta-b')) === 'resolved',
      '[[meta-b]] resolved'
    )
    await editor.clickWikiLink('meta-b')
    // 点开的 md 不再落到右侧预览：meta-b.md 在它自己的协作编辑窗口（#markdown-window）里打开
    const mdWin = await until(
      () => app.connectMarkdownWindow('meta-b.md'),
      'meta-b.md opened in a markdown window'
    )
    try {
      const winFill = fmFillPane(mdWin)
      await until(async () => (await winFill.cards()).length === 1, 'md window card mounted')
      // 补缺行与条都是异步挂的（get 回来才渲染）—— 挂完再多等一会儿
      await sleep(800)
      // md 窗口是一条内存会话，不是 `__agents__` 下的注册表笔记：主进程认不出它是哪份注册表文件，
      // 所以 B 存着的补缺值（medium）不显示、不挂来源说明，也没有条；更不借 A 的会话显示 A 的值
      const [winCard] = await winFill.cards()
      expect(winCard.name).toBe('meta-b')
      expect(winCard.fillTags).toBe(0)
      expect(winCard.strip).toBe(false)
      expect(winCard.text).not.toContain(en.notebook.frontmatter.metaTitle)
      const winThinking = await winFill.row(THINKING)
      expect(winThinking?.value).toBe('')
      expect(winThinking?.tagged).toBe(false)
    } finally {
      await mdWin.eval('window.close()').catch(() => undefined)
      mdWin.close()
    }
    await until(
      async () => !(await app.markdownWindows()).some((w) => w.path.includes('meta-b.md')),
      'md window closed'
    )

    // 主窗口里仍只有 A 自己那一张卡（没有右侧预览了），A 的补缺行照旧
    const cards = await fill.cards()
    expect(cards).toHaveLength(1)
    const own = cards[0]
    expect(own.name).toBe('meta-a')
    expect(own.fillWrappers).toBe(2)
    expect(own.fillTags).toBe(1)
    expect(own.strip).toBe(false)
  })

  it('E-11 两份文件共用一个 id：经 IPC 补 medium → twin-b 的档位行显示 medium、挂小标', async () => {
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
    await fill.waitRow(
      THINKING,
      (r) => r.value === 'medium' && r.tagged,
      'twin-b row shows medium, tagged'
    )
  })

  it('E-10 补缺值跨重启还在', async () => {
    const home = app.home
    await app.stop({ keepHome: true })
    app = (await launchApp({ home })) as E2EApp
    await waitRendererReady(app.main)
    await until(
      async () => (await agentRow('meta-twin-a', 'user'))?.thinkingLevel === 'medium',
      'twin fill survived the restart'
    )
    expect((await agentRow('meta-twin-b', 'user'))?.thinkingLevel).toBe('medium')
    expect((await agentRow('explore', 'builtin'))?.model).toBe(MODEL_REF)
  })
})
