/**
 * 设置页「Hooks」tab（HookSettings + RegistryNoteView）。
 *
 * 与智能体 / 安全策略 tab 同形：内置 hook 随包发布、没有文件，是原文的只读查看（给「创建覆盖副本」）；
 * 用户 hook 的详情**就是这份 md 的笔记本会话**（隐藏项目 `__hooks__`，自动保存，没有保存按钮），
 * 列表选中项按文件名认。呈现上的差异：行多一行 `agent · 触发器` 副标题（hint），选中一份解析不过的
 * 文件时，头部与笔记之间挂着解析器的拒绝原因红框（reasonText，与属性卡横幅同源）。
 *
 * 断言优先走 IPC（window.api.hook.*）+ fs 直读；DOM 一律经 pages.ts。写入只走 `noteWrite`（写路径
 * IPC）或属性卡 `commitField`，绝不往 CodeMirror 里打字。
 * 用例间有顺序依赖：同一个设置窗口一路点下去（openSettings 对已存在的窗口只聚焦、不切 tab）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  hooksPane,
  registryNotePane,
  settingsTabsPane,
  type HooksPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  noteWrite,
  openRegistryNote,
  registryNoteSessions
} from '../../harness/seed'

const HOOKS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.hook
const PROMPT_ACCEPTED = 'session.prompt-accepted'
const TURN_COMPLETED = 'session.turn-completed'
/** Hooks tab 的导航文案（en / zh 都是 Hooks，ja 是フック） */
const HOOKS_TAB_LABELS = ['Hooks', 'フック']
const RETIRED_TAB_LABELS = ['Workflows', '工作流', 'ワークフロー']

interface HookItem {
  name: string
  displayName: string
  agent: string
  triggers: string[]
  source: 'builtin' | 'user'
  basePath: string
  overridden?: boolean
  overriddenBy?: string
}

interface Binding {
  trigger: string
  when?: string
}

const md = (frontmatter: string[], body: string): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

const hookMd = (name: string, opts: { agent: string; on: Binding[]; body: string }): string =>
  md(
    [
      'shuvix: hook v1',
      `name: ${name}`,
      `shuvix-hook-agent: ${opts.agent}`,
      'shuvix-hook-on:',
      ...opts.on.flatMap((b) => [
        `  - trigger: ${b.trigger}`,
        ...(b.when ? [`    when: ${b.when}`] : [])
      ])
    ],
    opts.body
  )

/** 丢了前缀的裸 `on:` —— 解析器整份拒绝 */
const bareOnMd = (name: string, agent: string, trigger: string, body: string): string =>
  md(
    [
      'shuvix: hook v1',
      `name: ${name}`,
      `shuvix-hook-agent: ${agent}`,
      'on:',
      `  - trigger: ${trigger}`
    ],
    body
  )

const hkUser = (agent: string): string =>
  hookMd('hk-user', { agent, on: [{ trigger: PROMPT_ACCEPTED }], body: 'HK USER BODY.' })

let app: E2EApp
let settings: CdpClient
let pane: HooksPane
let note: RegistryNotePane
/** 内置 auto-title 的显示名（随界面语言本地化，经 IPC 取） */
let autoTitleLabel = ''

const hookPath = (fileName: string): string => join(app.hooksDir, fileName)
const listHooks = (): Promise<HookItem[]> => app.main.eval('window.api.hook.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.hook.listInvalid()')
const projectIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.project.list().then((ps) => ps.map((p) => p.id))`)

beforeAll(async () => {
  app = await launchApp()
  mkdirSync(app.hooksDir, { recursive: true })
  writeFileSync(hookPath('hk-user.md'), hkUser('explore'))
  autoTitleLabel =
    (await listHooks()).find((h) => h.name === 'auto-title' && h.source === 'builtin')
      ?.displayName ?? ''
  settings = await app.openSettings('hooks')
  pane = await hooksPane(settings)
  note = registryNotePane(settings)
})

afterAll(async () => {
  await app?.stop()
})

describe('Hooks 设置页', () => {
  it('HST-0 设置导航里有 Hooks 且处于选中态，旧的「工作流」tab 不在了', async () => {
    const tabs = await settingsTabsPane(settings)
    const labels = await tabs.labels()
    const hooksLabel = labels.find((l) => HOOKS_TAB_LABELS.includes(l))
    expect(hooksLabel).toBeTruthy()
    for (const retired of RETIRED_TAB_LABELS) expect(labels).not.toContain(retired)
    expect(await tabs.activeLabel()).toBe(hooksLabel)
  })

  it('HST-1 内置 auto-title：行副标题是 agent · 触发器；详情只读（没有笔记、输入框全禁用），头部只有覆盖副本入口', async () => {
    expect(autoTitleLabel).not.toBe('')
    const row = (await pane.rows()).find((r) => r.name === autoTitleLabel && r.builtin)
    expect(row?.hint).toBe(`titler · ${PROMPT_ACCEPTED}, ${TURN_COMPLETED}`)

    await pane.selectRow(autoTitleLabel, 'builtin')
    expect(await pane.noteFile()).toBe('')
    const inputs = await pane.inputs()
    expect(inputs.count).toBeGreaterThan(0)
    expect(inputs.disabled).toBe(true)
    expect(await pane.headerIcons()).toEqual({ copy: true, trash: false, save: false })
    expect(await pane.headerTitle()).toBe(autoTitleLabel)
  })

  it('HST-2 用户 hook 的详情就是它的笔记：一份文件一条 __hooks__ 会话、没有保存按钮、删除在头部；hook 属性卡校验通过；载体项目不进项目列表', async () => {
    await pane.selectRow('hk-user')
    expect(await pane.noteFile()).toBe('hk-user.md')
    const notes = await registryNoteSessions(app.main, HOOKS_PROJECT)
    expect(notes.map((n) => n.notebookPath)).toEqual(['hk-user.md'])
    const opened = await openRegistryNote(app.main, 'hook', 'hk-user.md')
    expect(opened.ok && opened.id).toBe(notes[0].id)

    expect(await pane.headerIcons()).toEqual({ save: false, trash: true, copy: false })
    expect(await projectIds()).not.toContain(HOOKS_PROJECT)

    expect(await note.cardBadge()).toBe('ShuviX hook · v1')
    await note.waitStatus('ok')
    expect(await note.fieldValue('shuvix-hook-agent')).toBe('explore')
    expect((await pane.rows()).find((r) => r.name === 'hk-user')?.hint).toBe(
      `explore · ${PROMPT_ACCEPTED}`
    )
  })

  it('HST-3 经笔记写进非法版本：选中项翻成「无法解析」行，红框 / 横幅 / listInvalid 同一个原因，笔记不重开；写回合法版翻回来', async () => {
    await note.mark()
    const broken = bareOnMd('hk-user', 'explore', PROMPT_ACCEPTED, 'HK USER BODY.')
    expect(await noteWrite(app.main, 'hook', 'hk-user.md', broken)).toEqual({ ok: true })

    await until(async () => (await pane.selectedInvalid()) === 'hk-user.md', 'invalid row selected')
    await until(
      async () => (await pane.reasonText()).includes("bare 'on' key is not read"),
      'reason box above the note'
    )
    await note.waitStatus('err')
    expect(await note.bannerText()).toContain("bare 'on' key is not read")
    expect((await listInvalid()).find((f) => f.fileName === 'hk-user.md')?.error).toContain(
      "bare 'on' key is not read"
    )
    expect((await listHooks()).some((h) => h.name === 'hk-user')).toBe(false)
    expect(await pane.headerTitle()).toBe('hk-user.md')
    expect(await note.isMarked()).toBe(true)

    expect(await noteWrite(app.main, 'hook', 'hk-user.md', hkUser('explore'))).toEqual({ ok: true })
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'hk-user' && !r.builtin && r.selected),
      'valid row selected again'
    )
    expect(await pane.reasonText()).toBe('')
    await note.waitStatus('ok')
    expect(await note.isMarked()).toBe(true)
  })

  it('HST-3b 同样的翻面走真实编辑路径：卡上把 agent 改成基座 work → 行翻成非法（点名基座），改回 explore → 翻回来，笔记始终没重开', async () => {
    await note.commitField('shuvix-hook-agent', 'work')
    await until(
      () => readFileSync(hookPath('hk-user.md'), 'utf8').includes('shuvix-hook-agent: work'),
      'agent field committed to disk'
    )
    await until(async () => (await pane.selectedInvalid()) === 'hk-user.md', 'invalid row selected')
    await until(
      async () => (await pane.reasonText()).includes('names a session base profile'),
      'reason names the base profile'
    )

    await note.commitField('shuvix-hook-agent', 'explore')
    await until(
      () => readFileSync(hookPath('hk-user.md'), 'utf8').includes('shuvix-hook-agent: explore'),
      'agent field restored on disk'
    )
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'hk-user' && !r.builtin && r.selected),
      'valid row selected again'
    )
    expect(await pane.reasonText()).toBe('')
    expect(await note.isMarked()).toBe(true)
  })

  it('HST-4 覆盖内置 auto-title → 写坏这份覆盖 → 内置恢复生效；删除按文件名走、删完回到内置', async () => {
    await pane.selectRow(autoTitleLabel, 'builtin')
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.hook.getSource({ name: 'auto-title', source: 'builtin' })`
    )
    expect(source.error).toBeUndefined()

    expect(await pane.clickCreateOverride()).toBe('auto-title.md')
    expect(readFileSync(hookPath('auto-title.md'), 'utf8')).toBe(source.text)
    const rows = (await listHooks()).filter((h) => h.name === 'auto-title')
    expect(rows.find((h) => h.source === 'builtin')).toMatchObject({
      overridden: true,
      overriddenBy: 'auto-title.md'
    })
    expect(rows.find((h) => h.source === 'user')?.overridden).toBeFalsy()
    await until(
      async () =>
        (await pane.rows()).some((r) => r.name === autoTitleLabel && !r.builtin && r.selected),
      'override row selected'
    )
    expect((await pane.rows()).find((r) => r.name === autoTitleLabel && r.builtin)).toMatchObject({
      struck: true,
      overriddenBadge: true
    })

    const broken = bareOnMd('auto-title', 'titler', PROMPT_ACCEPTED, 'Broken override.')
    expect(await noteWrite(app.main, 'hook', 'auto-title.md', broken)).toEqual({ ok: true })
    const after = (await listHooks()).filter((h) => h.name === 'auto-title')
    expect(after).toHaveLength(1)
    expect(after[0].source).toBe('builtin')
    expect(after[0].overridden).toBeFalsy()

    // 等选中项翻成非法行再删：头部此刻才按文件名删（它已解析不出 name）
    await until(
      async () => (await pane.selectedInvalid()) === 'auto-title.md',
      'broken override selected as an invalid file'
    )
    await pane.clickDelete()
    expect((await pane.confirmDialog()).description).toContain('auto-title.md')
    await pane.confirmDialogConfirm()

    await until(() => !existsSync(hookPath('auto-title.md')), 'auto-title.md deleted')
    await until(
      async () =>
        (await pane.rows()).some((r) => r.name === autoTitleLabel && r.builtin && r.selected),
      'builtin auto-title selected'
    )
    expect(await pane.noteFile()).toBe('')
    await until(async () => (await pane.headerIcons()).copy, 'create-override action back')
  })

  it('HST-5 「新建」两次：my-hook.md、my-hook-2.md 都是合法 hook（模板派 explore、绑 turn-completed），后建的那份被选中', async () => {
    expect(await pane.clickNew()).toBe('my-hook.md')
    expect(await pane.clickNew()).toBe('my-hook-2.md')

    const users = (await listHooks()).filter((h) => h.source === 'user')
    for (const name of ['my-hook', 'my-hook-2']) {
      expect(users.find((h) => h.name === name)).toMatchObject({
        agent: 'explore',
        triggers: [TURN_COMPLETED]
      })
    }
    const invalid = (await listInvalid()).map((f) => f.fileName)
    expect(invalid).not.toContain('my-hook.md')
    expect(invalid).not.toContain('my-hook-2.md')

    await until(
      async () => (await pane.rows()).some((r) => r.name === 'my-hook-2' && r.selected),
      'second new row selected'
    )
    expect(await pane.noteFile()).toBe('my-hook-2.md')
    expect((await pane.rows()).find((r) => r.name === 'my-hook-2')?.hint).toBe(
      `explore · ${TURN_COMPLETED}`
    )
    expect(
      readFileSync(hookPath('my-hook-2.md'), 'utf8').startsWith(
        '---\nshuvix: hook v1\nname: my-hook-2'
      )
    ).toBe(true)
  })

  it('HST-6 外部写入的文件要重扫才可见；解析不过的外部文件能点开（原因红框、只有删除），按文件名删掉', async () => {
    // 先离开开着的笔记：笔记视图订阅着 hooks 目录的 files.changed、会替列表重拉。选中内置行时没有
    // 笔记视图挂着，列表只在挂载与「重扫描」时加载 —— 「外部文件要重扫才可见」这才测得到
    await pane.selectRow(autoTitleLabel, 'builtin')
    writeFileSync(
      hookPath('ext.md'),
      hookMd('ext', { agent: 'explore', on: [{ trigger: PROMPT_ACCEPTED }], body: 'EXT BODY.' })
    )
    writeFileSync(
      hookPath('ext-bad.md'),
      md(
        [
          'name: ext-bad',
          'shuvix-hook-agent: explore',
          'shuvix-hook-on:',
          `  - trigger: ${PROMPT_ACCEPTED}`
        ],
        'EXT BAD BODY.'
      )
    )
    // 跨过笔记视图的重载防抖（300ms）再看：没有任何东西替它重新拉列表
    await sleep(600)
    expect((await pane.rows()).some((r) => r.name === 'ext')).toBe(false)
    expect(await pane.invalidRows()).not.toContain('ext-bad.md')

    await pane.refresh()
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'ext' && !r.builtin),
      'ext listed after rescan'
    )
    expect(await pane.invalidRows()).toContain('ext-bad.md')

    await pane.selectInvalidRow('ext-bad.md')
    expect(await pane.noteFile()).toBe('ext-bad.md')
    expect(await pane.headerTitle()).toBe('ext-bad.md')
    await until(
      async () => (await pane.reasonText()).includes('missing file marker'),
      'reason box names the missing marker'
    )
    expect(await pane.headerIcons()).toEqual({ trash: true, copy: false, save: false })

    await pane.clickDelete()
    expect((await pane.confirmDialog()).description).toContain('ext-bad.md')
    await pane.confirmDialogConfirm()
    await until(() => !existsSync(hookPath('ext-bad.md')), 'ext-bad.md deleted')
    await until(async () => (await pane.invalidRows()).length === 0, 'invalid group empty')
  })

  it('HST-7 同名两份用户文件：输的那行划线带覆盖徽标、头部点名压过它的文件；按文件名删掉它，胜出的那份仍被选中', async () => {
    writeFileSync(
      hookPath('zz.md'),
      hookMd('hk-user', { agent: 'explore', on: [{ trigger: TURN_COMPLETED }], body: 'ZZ BODY.' })
    )
    await pane.refresh()
    await until(
      async () => (await pane.rows()).filter((r) => r.name === 'hk-user').length === 2,
      'both hk-user copies listed'
    )
    const loser = (await pane.rows()).find((r) => r.name === 'hk-user' && r.struck)
    expect(loser?.overriddenBadge).toBe(true)
    expect((await listHooks()).find((h) => h.basePath === hookPath('zz.md'))).toMatchObject({
      name: 'hk-user',
      overridden: true,
      overriddenBy: 'hk-user.md'
    })

    await pane.selectRow('hk-user', 'user', { overridden: true })
    expect(await pane.noteFile()).toBe('zz.md')
    expect((await pane.headerLines())[2]).toContain('hk-user.md')

    await pane.clickDelete()
    expect((await pane.confirmDialog()).description).toContain('zz.md')
    await pane.confirmDialogConfirm()
    await until(() => !existsSync(hookPath('zz.md')), 'zz.md deleted')
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'hk-user' && !r.struck && r.selected),
      'winning copy stays selected'
    )
    expect(await pane.noteFile()).toBe('hk-user.md')
  })
})
