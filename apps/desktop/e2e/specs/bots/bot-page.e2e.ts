/**
 * 主窗 Bot 档案页 —— 侧栏置顶「Bots」分组（BotGroup）+ 主区 BotPage。原设置页「Bots」tab
 * 的 C 组叙事线整体搬家（列表 → 修非法 → 管线块 → 槽位 → 换工作流 → 冲突 → 保存 → 新建会话 →
 * 新建 → 重扫 → 旧格式 → 缺管线 → 管线遮蔽），外加主窗独有的几处（M 组）：设置窗口不再有
 * Bots tab、档案页与活动会话互斥、组头 / 行菜单的 id 集、行菜单的新建会话与删除（ConfirmDialog）、
 * 保存后侧栏行随 `bot.changed` 自更新（displayName / 改名）。
 *
 * 管线绑定 `shuvix-bot-pipeline: { workflow, agents, input }` 在页面上只有一处：属性卡的块行
 * （工作流下拉 + 按所选工作流联动的槽位下拉 + 只读入参）；管线 / 槽位 / agent 的存在性提示走
 * 卡片的校验横幅。原来的运行时读数条与门控模型行都退场了（见 botsPane.retiredAnchors）。
 * 下拉改的是**编辑器文档**，磁盘要等头部保存 —— 每个改下拉的用例都断两次：先断文档（下拉值 /
 * 校验态变了、文件没动），再断保存后的文件。
 *
 * DOM 一律经 harness/pages 的 botsPane / sidebarPane / confirmPane / settingsTabsPane
 * （data-* 锚点）；能走 IPC 断的（文件内容、session.list、bot.list、shuvixMd.botPipelineOptions）
 * 不碰 DOM。**用例有序**：一条叙事线，后面的用例依赖前面留下的注册表状态 —— 各自的 bot 名互不
 * 复用；冲突用例一律以**外部 fs 改动**制造分歧，属性卡字段经 setField（裸 DOM 文本框 + blur 提交）
 * 改、下拉经 pickWorkflow / setSlot（原生 setter + change）改，全程不驱动 CM6 打字。
 *
 * 分组是懒扫的：磁盘外写入的文件不广播 `bot.changed`，种完要走组头菜单 refresh；而经
 * botService 落盘的每一次（保存 / 新建 / 删除 / 修好）都会广播，那些用例**刻意不 refresh** ——
 * 断的就是「行自己更新」。
 *
 * 属性卡按 (文件名, YAML) 缓存校验结果：同一个 bot 的 YAML 没变就不重新问主进程，所以
 * 「注册表变了、卡片该换脸」的用例（C17 遮蔽管线）一律种**新** bot，不重开旧的。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'
import {
  botsPane,
  confirmPane,
  settingsTabsPane,
  sidebarPane,
  type BotsCardStatus,
  type BotsPane,
  type BotsPipelineShot,
  type ConfirmPane,
  type MenuItemShot,
  type SidebarPane
} from '../../harness/pages'
import { waitRendererReady, writeAgentMd, writeBotMd } from '../../harness/seed'

let app: E2EApp
let pane: BotsPane
let sidebar: SidebarPane
let confirm: ConfirmPane

const botPath = (name: string): string => join(app.botsDir, `${name}.md`)
const wfDir = (): string => join(app.home, '.shuvix', 'workflows')

/** items → 自定义项的 id（分隔符滤掉，同 sidebarPane.lastMenuIds 的口径） */
const idsOf = (items: MenuItemShot[] | null): string[] =>
  (items ?? []).filter((it) => it.id).map((it) => it.id as string)

interface SessionRow {
  id: string
  title: string
  settings?: { bot?: string; bots?: string[] }
}
const listSessions = (): Promise<SessionRow[]> => app.main.eval(`window.api.session.list()`)

/** 等 session.list 里长出绑定了 name 的那条聊天会话（一对一：`settings.bot` 一个名字） */
const findBotSession = (name: string): Promise<SessionRow> =>
  until(
    async () => (await listSessions()).find((s) => s.settings?.bot === name) ?? null,
    `bot session with settings.bot=${name}`
  )

/** `shuvixMd.botPipelineOptions` 的形状（与 chat-protocol BotPipelineOptions 对齐，只声明本 spec 读的字段） */
interface PipelineOptions {
  workflows: Array<{
    name: string
    source: string
    concurrency: string
    slots: Array<{ role: string; required: boolean }>
  }>
  agents: string[]
}
const pipelineOptions = (): Promise<PipelineOptions> =>
  app.main.eval(`window.api.shuvixMd.botPipelineOptions()`)
const listBots = (): Promise<Array<{ name: string }>> => app.main.eval('window.api.bot.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.bot.listInvalid()')

/** 管线块就绪（候选项已拉回、下拉可交互）的快照 */
const pipelineReady = (what: string): Promise<BotsPipelineShot> =>
  until(async () => {
    const p = await pane.pipeline()
    return p.present && p.loaded ? p : null
  }, what)

/** 校验态落定到某个 chip 的快照（文档改动后卡片重建、重新校验，中间有一段没 chip 的空窗） */
const statusIs = (chip: BotsCardStatus['chip'], what: string): Promise<BotsCardStatus> =>
  until(async () => {
    const s = await pane.cardStatus()
    return s.chip === chip ? s : null
  }, what)

/** 管线块里某个槽位的下拉值（块未就绪 / 槽位不存在 → undefined） */
async function slotValue(role: string): Promise<string | undefined> {
  const p = await pane.pipeline()
  return p.present && p.loaded ? p.slots.find((x) => x.role === role)?.value : undefined
}

/** 槽位行的 [role, required, value] 三元组（顺序 = DOM 序） */
const slotTuples = (p: BotsPipelineShot): Array<[string, boolean, string]> =>
  p.slots.map((s) => [s.role, s.required, s.value])

/** 头部保存：等按钮可点（文档改动经编辑器的防抖回调才重新亮起保存钮）再点 */
async function save(): Promise<void> {
  await until(() => pane.saveEnabled(), 'bot page save button enabled')
  await pane.clickSave()
}

/** 只替换恰好出现一次的那段 —— 内置原文改了形状时让用例在这里炸，而不是静默 fork 出一份别的东西 */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at < 0 || text.indexOf(from, at + 1) >= 0) {
    throw new Error(`expected exactly one ${JSON.stringify(from)} in the builtin bot-chat source`)
  }
  return text.replace(from, to)
}

/**
 * 从内置 bot-chat 原文整份 fork 一份用户工作流写进 ~/.shuvix/workflows/<name>.md，只改 edit
 * 指定的几处 —— 手写最小 workflow 反而测不到「同名遮蔽 / 换工作流」的真实形态。
 */
async function forkBotChat(name: string, edit: (text: string) => string): Promise<string> {
  const src = await app.main.eval<{ text: string } | { error: string }>(
    `window.api.workflow.getSource({ name: 'bot-chat', source: 'builtin' })`
  )
  if ('error' in src) throw new Error(`builtin bot-chat source: ${src.error}`)
  mkdirSync(wfDir(), { recursive: true })
  const filePath = join(wfDir(), `${name}.md`)
  writeFileSync(filePath, edit(src.text))
  return filePath
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  pane = botsPane(app.main)
  confirm = confirmPane(app.main)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('主窗 Bot 档案页', () => {
  it('M1 openSettings("bots") 不再落到任何 Bots tab：设置窗口的导航里没有这一项', async () => {
    const tabs = await settingsTabsPane(await app.openSettings('bots'))
    const labels = await tabs.labels()
    expect(labels.length).toBeGreaterThan(0)
    // 精确匹配：「Telegram Bots」是另一个 tab
    expect(labels.filter((l) => /^bots$/i.test(l))).toEqual([])
    const active = await tabs.activeLabel()
    expect(active).not.toBe('')
    expect(active).not.toMatch(/^bots$/i)
  })

  it('C1 分组缺省折叠且未扫描；首次展开才扫 → 零 bot 空态（无行、无非法行、无档案页）', async () => {
    expect(await pane.expanded()).toBe(false)
    expect(await pane.scanned()).toBe(false)
    await pane.expand()
    expect(await pane.expanded()).toBe(true)
    expect(await pane.rows()).toEqual([])
    expect(await pane.invalidRows()).toEqual([])
    expect(await pane.emptyState()).toBe(true)
    expect((await pane.editor()).present).toBe(false)
  })

  it('C2 列表：localeCompare 排序、行显 displayName + description（title）；没开档案页 → 无选中行', async () => {
    writeBotMd(app, 'zeta-bot', { description: 'zeta desc', displayName: 'Zeta' })
    writeBotMd(app, 'alpha-bot', { description: 'alpha desc', displayName: 'Alpha' })
    await pane.refresh()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.length === 2 ? r : null
    }, 'two bot rows listed')
    expect(rows.map((r) => r.name)).toEqual(['alpha-bot', 'zeta-bot'])
    expect(rows[0]).toMatchObject({
      displayName: 'Alpha',
      description: 'alpha desc',
      selected: false
    })
    expect(rows[1]).toMatchObject({
      displayName: 'Zeta',
      description: 'zeta desc',
      selected: false
    })
    expect(await pane.emptyState()).toBe(false)
  })

  it('M2 档案页与活动会话互斥：开页 → 无活动会话行、data-bot-page=edit；点会话行 → 页关', async () => {
    await app.main.eval(`window.api.session.create({ title: 'M2-session' })`)
    await until(
      async () => (await sidebar.titles()).includes('M2-session'),
      'seeded session listed'
    )

    await pane.selectRow('alpha-bot')
    const editor = await pane.editor()
    expect(editor).toMatchObject({
      present: true,
      kind: 'edit',
      transient: false,
      headerTitle: 'Alpha',
      newSessionPresent: true,
      error: '',
      invalidError: ''
    })
    expect(editor.headerPath).toBe(botPath('alpha-bot'))
    expect(await sidebar.activeTitle()).toBe('')
    expect((await pane.rows()).find((r) => r.name === 'alpha-bot')?.selected).toBe(true)

    // 选中会话即离开档案页（chatStore.active 单一来源）
    expect(await sidebar.openSession('M2-session')).toBe(true)
    await until(
      async () => !(await pane.editor()).present,
      'bot page closed by selecting a session'
    )
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)

    // 再开回来：会话行失活
    await pane.selectRow('alpha-bot')
    expect(await sidebar.activeTitle()).toBe('')
  })

  it('M3 菜单 id 集：组头 = new-bot / open-folder / refresh，bot 行 = new-bot-chat / delete-bot；⋮ 与右键同一份', async () => {
    const groupViaButton = await pane.groupMenuShots()
    const groupViaContext = await pane.groupMenuShots('contextmenu')
    expect(idsOf(groupViaButton)).toEqual(['new-bot', 'open-folder', 'refresh'])
    expect(groupViaContext).toEqual(groupViaButton)

    const rowViaButton = await pane.rowMenuShots('alpha-bot')
    const rowViaContext = await pane.rowMenuShots('alpha-bot', 'contextmenu')
    expect(idsOf(rowViaButton)).toEqual(['new-bot-chat', 'delete-bot'])
    expect(rowViaContext).toEqual(rowViaButton)
    // 打开菜单只是取消，不该把页面或列表怎么样
    expect((await pane.editor()).kind).toBe('edit')
    expect((await pane.rows()).find((r) => r.name === 'alpha-bot')?.selected).toBe(true)
  })

  it('C3 非法文件：琥珀行 → 点开即修复页（横幅显解析理由）→ 坏着存被拒 → 属性卡补 description → 存好切成 edit、行自迁入合法列表', async () => {
    // description 是 bot md 必填 —— 缺它整份被拒（文件名取 aa- 前缀，修好后恰为列表首项）。
    // 管线块照常写上：解析器没有缺省管线，缺块是另一种非法（C16），这里只让 description 一处坏
    writeFileSync(
      botPath('aa-fixed'),
      [
        '---',
        'shuvix: bot v1',
        'name: aa-fixed',
        'shuvix-bot-pipeline:',
        '  workflow: bot-chat',
        '  agents:',
        '    intent: bot-intent',
        '    task: default',
        '---',
        '',
        'BROKEN BODY.',
        ''
      ].join('\n')
    )
    await pane.refresh()
    await until(async () => (await pane.invalidRows()).length === 1, 'invalid row listed')
    expect(await pane.invalidRows()).toEqual(['aa-fixed.md'])
    // 非法行的菜单只有删除（没有「新建 Bot 会话」—— 它不是一个 bot）
    expect(idsOf(await pane.invalidMenuShots('aa-fixed.md'))).toEqual(['delete-bot-file'])

    // 点行直接进修复页：原文（含正文）如实落进编辑器，解析器的拒绝理由挂在编辑器正上方
    await pane.selectInvalid('aa-fixed.md')
    const fix = await until(async () => {
      const e = await pane.editor()
      return e.text.includes('BROKEN BODY.') ? e : null
    }, 'fix editor filled with raw text')
    expect(fix).toMatchObject({
      kind: 'fix',
      transient: true,
      headerTitle: 'aa-fixed.md',
      newSessionPresent: false,
      error: ''
    })
    expect(fix.invalidError).toContain("'description' is required")
    expect((await pane.invalidRows()).length).toBe(1)

    // 没改就存：解析器照样拒 → 红色横幅上屏、仍是修复页、磁盘不动
    await pane.clickSave()
    const rejected = await until(async () => {
      const e = await pane.editor()
      return e.error ? e : null
    }, 'still-broken save rejected')
    expect(rejected.error).toContain("'description' is required")
    expect(rejected.kind).toBe('fix')
    expect(readFileSync(botPath('aa-fixed'), 'utf-8')).not.toContain('description')

    // 属性卡补上 description（裸 DOM 文本框 + blur 提交 → 卡片给 md 打补丁）；套件不驱动 CM6 打字
    expect(await pane.setField('description', 'fixed by e2e')).toBe(true)
    await until(
      async () => (await pane.editor()).text.includes('fixed by e2e'),
      'description patched into the doc'
    )
    await pane.clickSave()
    // 修好即合法 bot：页切成 edit 目标（page 重挂），列表随 bot.changed 自迁 —— 这里刻意不 refresh
    await until(async () => {
      const e = await pane.editor()
      return e.kind === 'edit' && e.headerPath === botPath('aa-fixed')
    }, 'fix page switched to the edit page of aa-fixed')
    await until(
      async () => (await pane.invalidRows()).length === 0,
      'amber row gone without manual refresh'
    )
    const rows = await pane.rows()
    expect(rows.map((r) => r.name)).toEqual(['aa-fixed', 'alpha-bot', 'zeta-bot'])
    expect(rows[0]).toMatchObject({ name: 'aa-fixed', selected: true })
    const content = readFileSync(botPath('aa-fixed'), 'utf-8')
    expect(content).toContain('description: fixed by e2e')
    expect(content).toContain('BROKEN BODY.')
  })

  it('C4 健康 bot 的属性卡：chip ok 无横幅；管线块 = bot-chat 已选、无 meta、三个槽位（intent*/task* 已填、recheck 未设）、入参 0；退场锚点不在', async () => {
    writeBotMd(app, 'c4-full', { description: 'c4 bot', displayName: 'C4' })
    await pane.refresh()
    await pane.selectRow('c4-full')

    const shot = await pipelineReady('pipeline block for c4-full')
    expect(shot.workflow).toBe('bot-chat')
    expect(shot.workflowOptions).toContain('bot-chat')
    // 选中项文案带来源与并发（内置 bot-chat 声明 parallel）；来源词是 i18n，只认并发
    expect(shot.workflowLabel).toContain('bot-chat')
    expect(shot.workflowLabel).toContain('parallel')
    expect(shot.workflowWarned).toBe(false)
    expect(shot.meta).toBe('')
    // 槽位 = 管线 input schema 的 agents.properties，顺序与声明序一致；必填带星标
    expect(shot.declaredCount).toBe(3)
    expect(slotTuples(shot)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['recheck', false, '']
    ])
    // 下拉候选 = 「未设置」+ 注册表里的 agent 名（内置在列，用户档案此刻还没有）
    for (const s of shot.slots) {
      expect(s.options[0]).toBe('')
      expect(s.options).toContain('bot-intent')
      expect(s.options).toContain('default')
      expect(s.warned).toBe(false)
      expect(s.extra).toBe(false)
    }
    expect(shot.inputCount).toBe(0)
    // 校验：合法，注册表层面也没话说
    expect(await statusIs('ok', 'card validated ok for c4-full')).toEqual({
      chip: 'ok',
      banner: []
    })
    // IPC 同一份事实：候选项里 bot-chat 是内置、parallel、三槽位
    const wf = (await pipelineOptions()).workflows.find((w) => w.name === 'bot-chat')
    expect(wf).toMatchObject({ source: 'builtin', concurrency: 'parallel' })
    expect(wf!.slots.map((s) => [s.role, s.required])).toEqual([
      ['intent', true],
      ['task', true],
      ['recheck', false]
    ])
    // 退场的锚点：运行时读数条 / 正文字数 / 门控模型行 / 笔记状态 / 循环上限
    expect(await pane.retiredAnchors()).toEqual([])
  })

  it('C5 管线不存在：下拉仍显那个名字（候选里补一项，不静默换值）+ 警示配色 + meta；两个槽位以「额外」身份列出；横幅点名管线', async () => {
    writeBotMd(app, 'c5-warn', { description: 'warn bot', pipeline: 'no-such-flow' })
    await pane.refresh()
    await pane.selectRow('c5-warn')
    const shot = await pipelineReady('pipeline block for c5-warn')
    expect(shot.workflow).toBe('no-such-flow')
    expect(shot.workflowOptions).toContain('no-such-flow')
    expect(shot.workflowOptions).toContain('bot-chat')
    expect(shot.workflowWarned).toBe(true)
    // meta 是 i18n 的「not found」—— 只认「有话说且不是并发提示」
    expect(shot.meta).not.toBe('')
    expect(shot.meta).not.toContain('≠')
    // 管线没声明槽位：bot 填的两个都是额外槽位（不必填、警示）
    expect(shot.declaredCount).toBe(0)
    expect(shot.slots.map((s) => [s.role, s.required, s.value, s.extra, s.warned])).toEqual([
      ['intent', false, 'bot-intent', true, true],
      ['task', false, 'default', true, true]
    ])
    const status = await statusIs('warn', 'card warned for c5-warn')
    expect(status.banner).toEqual([
      expect.stringContaining("pipeline 'no-such-flow' does not exist")
    ])
  })

  it('C5b 必填槽位未填：chip warn + 横幅点名 task + 该下拉警示；下拉选一个 agent → 文档变了（卡片重新校验成 ok、磁盘未动）→ 保存 → 文件长出那一行', async () => {
    // 没有缺省表：task 漏填就是漏填 —— 档案页得在跑之前说出来，而不是等会话里失败
    writeBotMd(app, 'c5-unset', {
      description: 'task slot left unset',
      agents: { intent: 'bot-intent' }
    })
    await pane.refresh()
    await pane.selectRow('c5-unset')
    const shot = await pipelineReady('pipeline block for c5-unset')
    expect(slotTuples(shot)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, ''],
      ['recheck', false, '']
    ])
    expect(shot.slots.find((s) => s.role === 'task')).toMatchObject({ warned: true, extra: false })
    expect(shot.slots.find((s) => s.role === 'intent')!.warned).toBe(false)
    const status = await statusIs('warn', 'card warned for c5-unset')
    expect(status.banner).toEqual([
      expect.stringContaining("slot 'task' is required by the pipeline but not set")
    ])

    // 下拉改槽位 = 只改编辑器文档：下拉显新值、卡片按新 YAML 重新校验、磁盘还是旧的
    expect(await pane.setSlot('task', 'default')).toBe(true)
    await until(async () => (await slotValue('task')) === 'default', 'task select shows default')
    expect(await statusIs('ok', 'card re-validated after filling the slot')).toEqual({
      chip: 'ok',
      banner: []
    })
    expect(readFileSync(botPath('c5-unset'), 'utf-8')).not.toContain('task: default')

    // 保存：文件长出 `    task: default`（块嵌套一层，4 空格缩进），其余行不动
    await save()
    const content = await until(() => {
      const c = readFileSync(botPath('c5-unset'), 'utf-8')
      return /shuvix-bot-pipeline:\n {2}workflow: bot-chat\n {2}agents:\n(?: {4}[\w-]+: [^\n]+\n)* {4}task: default\n/.test(
        c
      )
        ? c
        : null
    }, 'task slot written into the md')
    expect(content).toContain('    intent: bot-intent\n')
    expect(content).toContain('task slot left unset')
    expect(content).toContain('BOT BODY.')
  })

  it('C5c 槽位指向不存在的 agent：下拉仍显那个名字（候选里补一项）+ 警示配色，横幅点名槽位与 agent', async () => {
    writeBotMd(app, 'c5-ghost', {
      description: 'task points at a ghost',
      agents: { intent: 'bot-intent', task: 'ghost-agent' }
    })
    await pane.refresh()
    await pane.selectRow('c5-ghost')
    const shot = await pipelineReady('pipeline block for c5-ghost')
    const task = shot.slots.find((s) => s.role === 'task')!
    // 填了一个不存在的名字：下拉仍显示那个值（不静默换成别的），并带警示配色
    expect(task).toMatchObject({ required: true, value: 'ghost-agent', warned: true, extra: false })
    expect(task.options).toContain('ghost-agent')
    expect(task.options).toContain('default')
    expect(shot.slots.find((s) => s.role === 'intent')!.warned).toBe(false)
    const status = await statusIs('warn', 'card warned for c5-ghost')
    expect(status.banner).toEqual([
      expect.stringContaining("slot 'task': agent 'ghost-agent' does not exist")
    ])
  })

  it('C6 用户档案进候选：intent 指向自建的 my-gate → 下拉显它、候选里有它、不警示；卡片 ok', async () => {
    writeAgentMd(app, 'my-gate', { description: 'custom gate agent' })
    writeBotMd(app, 'c6-gate', {
      description: 'custom gated bot',
      agents: { intent: 'my-gate', task: 'default' }
    })
    await pane.refresh()
    await pane.selectRow('c6-gate')
    const shot = await pipelineReady('pipeline block for c6-gate')
    const intent = shot.slots.find((s) => s.role === 'intent')!
    expect(intent).toMatchObject({ value: 'my-gate', warned: false })
    expect(intent.options).toContain('my-gate')
    expect((await pipelineOptions()).agents).toContain('my-gate')
    expect(await statusIs('ok', 'card ok for c6-gate')).toEqual({ chip: 'ok', banner: [] })
  })

  it('C6b 可选槽位写穿：recheck 选 my-gate → 保存后 agents 块长出 4 空格缩进的那一行；清回「未设置」→ 保存后行消失、块其余不动', async () => {
    await pane.selectRow('c4-full')
    await until(async () => (await slotValue('recheck')) === '', 'recheck slot unset')

    expect(await pane.setSlot('recheck', 'my-gate')).toBe(true)
    await until(
      async () => (await slotValue('recheck')) === 'my-gate',
      'recheck select shows my-gate'
    )
    // my-gate 真实存在 → 重新校验仍是 ok；磁盘未动
    expect(await statusIs('ok', 'card ok after picking recheck')).toEqual({
      chip: 'ok',
      banner: []
    })
    expect(readFileSync(botPath('c4-full'), 'utf-8')).not.toContain('recheck')
    await save()
    const withRecheck = await until(() => {
      const c = readFileSync(botPath('c4-full'), 'utf-8')
      return /shuvix-bot-pipeline:\n {2}workflow: bot-chat\n {2}agents:\n(?: {4}[\w-]+: [^\n]+\n)* {4}recheck: my-gate\n/.test(
        c
      )
        ? c
        : null
    }, 'recheck slot written into the md')
    expect(withRecheck).toContain('    intent: bot-intent\n')
    expect(withRecheck).toContain('    task: default\n')

    // 清回「未设置」：只拔掉那一行
    expect(await pane.setSlot('recheck', '')).toBe(true)
    await until(async () => (await slotValue('recheck')) === '', 'recheck select back to unset')
    await save()
    const cleared = await until(() => {
      const c = readFileSync(botPath('c4-full'), 'utf-8')
      return c.includes('recheck') ? null : c
    }, 'recheck line removed from the md')
    expect(cleared).toContain(
      'shuvix-bot-pipeline:\n  workflow: bot-chat\n  agents:\n    intent: bot-intent\n    task: default\n'
    )
  })

  it('C7 门控模型行退场：intent 指向内置 bot-intent 的档案页上也没有 data-bot-gate-model（门控模型改去 Agents 设置页的 bot-intent 档案）', async () => {
    await pane.selectRow('c4-full')
    const shot = await pipelineReady('pipeline block for c4-full')
    // 旧读数条只在 intent = bot-intent 时才挂门控模型行 —— 正是这种 bot 上也不该再有
    expect(shot.slots.find((s) => s.role === 'intent')!.value).toBe('bot-intent')
    expect(await pane.retiredAnchors()).toEqual([])
  })

  it('C7b 换工作流：选一份 fork 的用户工作流（skip、recheck 槽位改名 reviewer）→ 槽位改挂、meta skip ≠ parallel、横幅有重入提示；保存后文件换 workflow、留 intent/task、删 recheck、留 input', async () => {
    const FORK = 'e2e-bot-chat-fork'
    await forkBotChat(FORK, (text) =>
      replaceOnce(
        replaceOnce(
          replaceOnce(text, '\nname: bot-chat\n', `\nname: ${FORK}\n`),
          'shuvix-workflow-concurrency: parallel',
          'shuvix-workflow-concurrency: skip'
        ),
        '\n        recheck:\n',
        '\n        reviewer:\n'
      )
    )
    // IPC 先断：fork 进了候选，声明的槽位 = intent* / task* / reviewer
    const fork = (await pipelineOptions()).workflows.find((w) => w.name === FORK)
    expect(fork).toMatchObject({ source: 'user', concurrency: 'skip' })
    expect(fork!.slots.map((s) => [s.role, s.required])).toEqual([
      ['intent', true],
      ['task', true],
      ['reviewer', false]
    ])

    // recheck 已填、带 input 的 bot：换工作流该只删 recheck、留下其余
    writeBotMd(app, 'c7-refork', {
      description: 'switches pipeline',
      agents: { intent: 'bot-intent', task: 'default', recheck: 'bot-intent' },
      botInput: { greeting: 'hi' }
    })
    await pane.refresh()
    await pane.selectRow('c7-refork')
    const before = await pipelineReady('pipeline block for c7-refork')
    expect(before.workflow).toBe('bot-chat')
    expect(before.workflowOptions).toContain(FORK)
    expect(slotTuples(before)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['recheck', false, 'bot-intent']
    ])
    expect(before.inputCount).toBe(1)
    expect(await statusIs('ok', 'card ok before the switch')).toEqual({ chip: 'ok', banner: [] })

    expect(await pane.pickWorkflow(FORK)).toBe(true)
    const after = await until(async () => {
      const p = await pane.pipeline()
      return p.present && p.loaded && p.workflow === FORK ? p : null
    }, 'pipeline block relinked to the fork')
    // 槽位按新工作流改挂：reviewer 现身（未设）、recheck 行没了、没有任何「额外」槽位
    expect(after.declaredCount).toBe(3)
    expect(slotTuples(after)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['reviewer', false, '']
    ])
    expect(after.slots.some((s) => s.extra)).toBe(false)
    expect(after.workflowLabel).toContain('skip')
    expect(after.meta).toBe('skip ≠ parallel')
    expect(after.inputCount).toBe(1)
    // 卡片按新 YAML 重新校验：合法但有话说 —— 只有重入模式这一条
    const status = await statusIs('warn', 'card re-validated after the switch')
    expect(status.banner).toEqual([
      expect.stringContaining(`pipeline '${FORK}' declares 'skip' reentry`)
    ])
    // 换工作流只改编辑器文档：磁盘还是旧的
    expect(readFileSync(botPath('c7-refork'), 'utf-8')).toContain('  workflow: bot-chat\n')

    await save()
    const content = await until(() => {
      const c = readFileSync(botPath('c7-refork'), 'utf-8')
      return c.includes(`  workflow: ${FORK}\n`) ? c : null
    }, 'fork written into the md')
    expect(content).toContain('    intent: bot-intent\n')
    expect(content).toContain('    task: default\n')
    expect(content).not.toContain('recheck')
    expect(content).toContain('  input:\n    greeting: hi\n')
    expect(content).toContain('switches pipeline')
  })

  it('C8 冲突 → 加载磁盘版本：对话框上屏（三个决议钮都在）、磁盘未覆写、重挂含外部改动、再保存成功', async () => {
    writeBotMd(app, 'c8-conflict', { description: 'conflict reload bot' })
    await pane.refresh()
    await pane.selectRow('c8-conflict')

    // 编辑器挂载**之后**外部改盘（模拟 bot 在答话途中改自己的正文）
    appendFileSync(botPath('c8-conflict'), '\n\nEXTERNAL NOTE C8.\n')

    await pane.clickSave()
    await until(() => pane.conflictOpen(), 'conflict dialog shown')
    expect(await pane.conflictShot()).toEqual({
      open: true,
      reload: true,
      overwrite: true,
      cancel: true
    })
    // 磁盘未被覆写：外部改动还在
    expect(readFileSync(botPath('c8-conflict'), 'utf-8')).toContain('EXTERNAL NOTE C8.')

    await pane.clickConflictReload()
    // 编辑器重挂，磁盘版本（含外部改动）进屏
    await until(
      async () => (await pane.editor()).text.includes('EXTERNAL NOTE C8.'),
      'editor remounted with disk version'
    )

    // 再保存：指纹已对上 → 写盘成功（内容逐字节同，以 mtime 前进为写入证据）
    const before = statSync(botPath('c8-conflict')).mtimeMs
    await pane.clickSave()
    await until(
      () => statSync(botPath('c8-conflict')).mtimeMs > before,
      'second save wrote through'
    )
    expect(await pane.conflictOpen()).toBe(false)
    expect(readFileSync(botPath('c8-conflict'), 'utf-8')).toContain('EXTERNAL NOTE C8.')
  })

  it('C9 冲突 → 仍然覆盖：编辑器缓冲无指纹重存胜，磁盘不再含外部改动', async () => {
    writeBotMd(app, 'c9-conflict', { description: 'conflict overwrite bot' })
    await pane.refresh()
    await pane.selectRow('c9-conflict')

    appendFileSync(botPath('c9-conflict'), '\n\nEXTERNAL NOTE C9.\n')
    await pane.clickSave()
    await until(() => pane.conflictOpen(), 'conflict dialog shown')

    await pane.clickConflictOverwrite()
    await until(
      () => !readFileSync(botPath('c9-conflict'), 'utf-8').includes('EXTERNAL NOTE C9.'),
      'editor buffer won the disk'
    )
    // 编辑器那份（原始正文）完整落盘
    expect(readFileSync(botPath('c9-conflict'), 'utf-8')).toContain('BOT BODY.')
  })

  it('C10 冲突 → 取消：磁盘保持外部内容、无写盘', async () => {
    writeBotMd(app, 'c10-conflict', { description: 'conflict cancel bot' })
    await pane.refresh()
    await pane.selectRow('c10-conflict')

    appendFileSync(botPath('c10-conflict'), '\n\nEXTERNAL NOTE C10.\n')
    const before = statSync(botPath('c10-conflict')).mtimeMs
    await pane.clickSave()
    await until(() => pane.conflictOpen(), 'conflict dialog shown')

    await pane.clickConflictCancel()
    await until(async () => !(await pane.conflictOpen()), 'conflict dialog dismissed')
    // 三不动：内容、外部改动、mtime
    expect(readFileSync(botPath('c10-conflict'), 'utf-8')).toContain('EXTERNAL NOTE C10.')
    expect(statSync(botPath('c10-conflict')).mtimeMs).toBe(before)
  })

  it('C11 常规保存：成功写盘、行保持选中、列表不变；编辑器不重挂（只换指纹）', async () => {
    await pane.selectRow('alpha-bot')
    const namesBefore = (await pane.rows()).map((r) => r.name)
    const before = statSync(botPath('alpha-bot')).mtimeMs
    const token = await pane.editorToken()
    expect(token).not.toBe('')

    await pane.clickSave()
    await until(() => statSync(botPath('alpha-bot')).mtimeMs > before, 'regular save wrote through')
    expect(await pane.conflictOpen()).toBe(false)

    // 保存广播 bot.changed → 分组重扫；同名行仍选中、列表不变
    const rows = await until(async () => {
      const r = await pane.rows()
      return r.find((x) => x.name === 'alpha-bot')?.selected ? r : null
    }, 'alpha-bot still selected after save')
    expect(rows.map((r) => r.name)).toEqual(namesBefore)
    // 缓冲就是刚落盘的那份 —— 不重挂编辑器
    expect(await pane.editorToken()).toBe(token)
    expect((await pane.editor()).kind).toBe('edit')
  })

  it('M4 保存改了 shuvix-displayName → 侧栏行显示名随 bot.changed 自更新（不手动刷新）', async () => {
    await pane.selectRow('zeta-bot')
    expect((await pane.rows()).find((r) => r.name === 'zeta-bot')?.displayName).toBe('Zeta')

    expect(await pane.setField('shuvix-displayName', 'Zeta Prime')).toBe(true)
    await until(
      async () => (await pane.editor()).text.includes('Zeta Prime'),
      'displayName patched into the doc'
    )
    await pane.clickSave()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.find((x) => x.name === 'zeta-bot')?.displayName === 'Zeta Prime' ? r : null
    }, 'sidebar row renamed by bot.changed')
    expect(rows.find((r) => r.name === 'zeta-bot')?.selected).toBe(true)
    expect(readFileSync(botPath('zeta-bot'), 'utf-8')).toContain('shuvix-displayName: Zeta Prime')
    expect(await pane.conflictOpen()).toBe(false)
    expect((await pane.editor()).kind).toBe('edit')
  })

  it('M5 改名：保存 name 改了的 md → 文件名不变、页按 basePath 反查切到新名、行随之更名', async () => {
    writeBotMd(app, 'ren-old', { description: 'rename me', displayName: 'Ren' })
    await pane.refresh()
    await pane.selectRow('ren-old')

    expect(await pane.setField('name', 'ren-new')).toBe(true)
    await until(async () => (await pane.editor()).nameInput === 'ren-new', 'name patched')
    await pane.clickSave()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.some((x) => x.name === 'ren-new') && !r.some((x) => x.name === 'ren-old') ? r : null
    }, 'row renamed by bot.changed')
    expect(rows.find((r) => r.name === 'ren-new')).toMatchObject({
      displayName: 'Ren',
      selected: true
    })
    // 页切到新名（page 重挂），文件还是 ren-old.md
    const editor = await until(async () => {
      const e = await pane.editor()
      return e.kind === 'edit' && e.headerPath === botPath('ren-old') && e.nameInput === 'ren-new'
        ? e
        : null
    }, 'page switched to ren-new (same file)')
    expect(editor.headerTitle).toBe('Ren')
    expect(existsSync(botPath('ren-new'))).toBe(false)
    expect(readFileSync(botPath('ren-old'), 'utf-8')).toContain('name: ren-new')
  })

  // 新建会话的两个用例（C12 / M6）都从「档案页开着 = 没有任何活动会话」出发：之后唯一能被
  // 激活的就是刚建出来的那条，所以哪怕它顶着与别的会话相同的缺省标题，activeTitle 也不会认错。
  it('C12 新建会话：data-bot-new-session → session.list 长出 settings.bot=<bot> 的会话，它成为主窗活动会话、档案页让位', async () => {
    await pane.selectRow('zeta-bot')
    expect((await pane.editor()).newSessionPresent).toBe(true)
    expect(await sidebar.activeTitle()).toBe('')
    await pane.clickNewSession()

    // IPC 断：会话真的建出来，绑定的正是这个 bot（一对一：没有群聊时代的 bots 名单）
    const session = await findBotSession('zeta-bot')
    expect(session.settings?.bots).toBeUndefined()
    // 主窗侧：档案页关了，新会话是活动行（带 bot 图标）
    await until(async () => !(await pane.editor()).present, 'bot page left for the new session')
    await until(
      async () => (await sidebar.activeTitle()) === session.title,
      'new bot session activated'
    )
    expect(await sidebar.activeRowIsBot()).toBe(true)
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
  })

  it('M6 行菜单「新建 Bot 会话」：session.list 长出 settings.bot=<bot> 的会话并成为活动会话（档案页让位）', async () => {
    await pane.selectRow('alpha-bot')
    expect(await sidebar.activeTitle()).toBe('')
    await pane.pickRowMenu('alpha-bot', 'new-bot-chat')

    const session = await findBotSession('alpha-bot')
    expect(session.settings?.bots).toBeUndefined()
    await until(async () => !(await pane.editor()).present, 'bot page left for the new session')
    await until(
      async () => (await sidebar.activeTitle()) === session.title,
      'row-menu bot session activated'
    )
    expect(await sidebar.activeRowIsBot()).toBe(true)
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
  })

  it('C13 新建流程：组头菜单「新建 bot」→ 模板预填 my-bot + bot 徽章 + 卡上 bot-chat 已选、两必填槽位已填；保存 → 切成 edit、入列并选中；重名再建 → 错误横幅、页留原地；取消 → 页关', async () => {
    await pane.clickNew()
    await until(async () => (await pane.editor()).nameInput === 'my-bot', 'template prefilled')
    const editor = await pane.editor()
    expect(editor).toMatchObject({
      kind: 'create',
      transient: true,
      newSessionPresent: false,
      cardBadge: 'ShuviX bot · v1'
    })
    // 开了新建页 = 离开会话
    expect(await sidebar.activeTitle()).toBe('')
    // 模板的管线块在卡上就位：内置 bot-chat 已选、两个必填槽位预填（解析器没有缺省管线 —— 这一行是模板写的）
    const tpl = await pipelineReady('pipeline block on the create page')
    expect(tpl.workflow).toBe('bot-chat')
    expect(tpl.meta).toBe('')
    expect(slotTuples(tpl)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['recheck', false, '']
    ])
    expect(await statusIs('ok', 'template validated ok')).toEqual({ chip: 'ok', banner: [] })

    await pane.clickSave()
    const rows = await until(async () => {
      const r = await pane.rows()
      return r.find((x) => x.name === 'my-bot')?.selected ? r : null
    }, 'my-bot listed and selected')
    expect(rows.some((r) => r.name === 'my-bot')).toBe(true)
    // 新建页切成常态编辑（page 重挂到 edit 目标）
    await until(async () => {
      const e = await pane.editor()
      return e.kind === 'edit' && e.headerPath === botPath('my-bot')
    }, 'create page switched to the edit page of my-bot')
    expect((await pane.editor()).transient).toBe(false)
    // 落盘的那份在 edit 页上同样成立
    const shot = await pipelineReady('pipeline block for my-bot')
    expect(shot.workflow).toBe('bot-chat')
    expect(slotTuples(shot)).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['recheck', false, '']
    ])
    expect(await statusIs('ok', 'my-bot validated ok')).toEqual({ chip: 'ok', banner: [] })
    expect(readFileSync(botPath('my-bot'), 'utf-8')).toContain(
      'shuvix-bot-pipeline:\n  workflow: bot-chat\n  agents:\n    intent: bot-intent\n    task: default\n'
    )

    // 不改名直接再建 → 服务层拒绝，错误横幅上屏，新建页留在原地
    await pane.clickNew()
    await until(
      async () => (await pane.editor()).nameInput === 'my-bot',
      'template prefilled again'
    )
    await pane.clickSave()
    const rejected = await until(async () => {
      const e = await pane.editor()
      return e.error ? e : null
    }, 'duplicate-name error banner shown')
    expect(rejected.error).toContain('already exists')
    expect(rejected).toMatchObject({ kind: 'create', transient: true })
    // 取消 = 离开档案页（回欢迎页）；没有会话被顺手激活
    await pane.clickCancel()
    expect((await pane.editor()).present).toBe(false)
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
    expect(await sidebar.activeTitle()).toBe('')
  })

  it('C14 重扫：磁盘删掉正开着的 md → 刷新后行消失、无选中行', async () => {
    await pane.selectRow('my-bot')
    rmSync(botPath('my-bot'))
    await pane.refresh()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.some((x) => x.name === 'my-bot') ? null : r
    }, 'my-bot row gone after rescan')
    expect(rows.some((r) => r.selected)).toBe(false)
    expect(rows[0]?.name).toBe('aa-fixed')
  })

  it('C15 旧格式文件：顶层 `shuvix-bot-pipeline: <名>` 标量 + `shuvix-bot-agents:` 块 → 非法行；修复页横幅与卡片都点名 shuvix-bot-agents、指向 shuvix-bot-pipeline', async () => {
    // 改制前的扁平写法：存量文件视为失效、不迁移 —— 拒绝理由要指明新写法，而不是一句「缺 workflow」
    writeFileSync(
      botPath('c15-legacy'),
      [
        '---',
        'shuvix: bot v1',
        'name: c15-legacy',
        'description: written against the flat format',
        'shuvix-bot-pipeline: bot-chat',
        'shuvix-bot-agents:',
        '  intent: bot-intent',
        '  task: default',
        '---',
        '',
        'LEGACY BODY.',
        ''
      ].join('\n')
    )
    await pane.refresh()
    await until(
      async () => (await pane.invalidRows()).includes('c15-legacy.md'),
      'legacy file listed as invalid'
    )
    // IPC：不进合法列表；invalid 通道的理由点名退场键并指向新块
    expect((await listBots()).some((b) => b.name === 'c15-legacy')).toBe(false)
    const entry = (await listInvalid()).find((i) => i.fileName === 'c15-legacy.md')
    expect(entry?.error).toContain("'shuvix-bot-agents' is no longer supported")
    expect(entry?.error).toContain("'shuvix-bot-pipeline'")

    await pane.selectInvalid('c15-legacy.md')
    const fix = await until(async () => {
      const e = await pane.editor()
      return e.text.includes('LEGACY BODY.') ? e : null
    }, 'fix editor filled with the legacy text')
    expect(fix.kind).toBe('fix')
    expect(fix.invalidError).toContain("'shuvix-bot-agents' is no longer supported")
    expect(fix.invalidError).toContain('shuvix-bot-pipeline')
    // 属性卡同口径：红 chip + 横幅 = 解析器理由
    const status = await statusIs('err', 'card flagged the legacy file invalid')
    expect(status.banner.join('\n')).toContain("'shuvix-bot-agents' is no longer supported")
    expect(status.banner.join('\n')).toContain('shuvix-bot-pipeline')
  })

  it('C16 缺管线块即非法：invalid 通道与修复页都说 is required；卡上选 bot-chat 长出块（转 warn：两必填槽位未填）→ 填满 → ok → 保存修好切 edit', async () => {
    writeBotMd(app, 'c16-noflow', { description: 'no pipeline block', omitPipeline: true })
    await pane.refresh()
    await until(
      async () => (await pane.invalidRows()).includes('c16-noflow.md'),
      'block-less file listed as invalid'
    )
    const entry = (await listInvalid()).find((i) => i.fileName === 'c16-noflow.md')
    expect(entry?.error).toContain("'shuvix-bot-pipeline' is required")

    await pane.selectInvalid('c16-noflow.md')
    expect((await pane.editor()).invalidError).toContain("'shuvix-bot-pipeline' is required")
    // 卡上的管线块：没有 workflow 可选中 → 空值 + 警示描边、零槽位
    const empty = await pipelineReady('pipeline block on the fix page')
    expect(empty).toMatchObject({
      workflow: '',
      workflowWarned: true,
      declaredCount: 0,
      slots: [],
      inputCount: 0
    })
    expect((await statusIs('err', 'card flagged the file invalid')).banner.join('\n')).toContain(
      "'shuvix-bot-pipeline' is required"
    )

    // 选工作流：块从无到有（`shuvix-bot-pipeline:` + `  workflow: bot-chat`）→ 合法，但两个必填槽位未填
    expect(await pane.pickWorkflow('bot-chat')).toBe(true)
    const linked = await until(async () => {
      const p = await pane.pipeline()
      return p.present && p.loaded && p.workflow === 'bot-chat' ? p : null
    }, 'workflow picked on the fix page')
    expect(slotTuples(linked)).toEqual([
      ['intent', true, ''],
      ['task', true, ''],
      ['recheck', false, '']
    ])
    const warned = await statusIs('warn', 'card re-validated: valid with unset required slots')
    expect(warned.banner).toEqual([
      expect.stringContaining("slot 'intent' is required"),
      expect.stringContaining("slot 'task' is required")
    ])
    expect(await pane.setSlot('intent', 'bot-intent')).toBe(true)
    await until(async () => (await slotValue('intent')) === 'bot-intent', 'intent filled')
    expect(await pane.setSlot('task', 'default')).toBe(true)
    await until(async () => (await slotValue('task')) === 'default', 'task filled')
    expect(await statusIs('ok', 'card ok once both slots are filled')).toEqual({
      chip: 'ok',
      banner: []
    })

    // 保存 = 修好：切成 edit 页、琥珀行自迁（刻意不 refresh）、文件里是嵌套块
    await save()
    await until(async () => {
      const e = await pane.editor()
      return e.kind === 'edit' && e.headerPath === botPath('c16-noflow')
    }, 'fix page switched to the edit page of c16-noflow')
    await until(
      async () => !(await pane.invalidRows()).includes('c16-noflow.md'),
      'amber row gone without manual refresh'
    )
    const content = readFileSync(botPath('c16-noflow'), 'utf-8')
    expect(content).toContain(
      'shuvix-bot-pipeline:\n  workflow: bot-chat\n  agents:\n    intent: bot-intent\n    task: default\n'
    )
    expect(content).toContain('no pipeline block')
  })

  it('C17 用户遮蔽管线端到端：concurrency=skip 的 ~/.shuvix/workflows/bot-chat.md → 候选里只有用户那份、meta skip ≠ parallel、横幅有重入提示，槽位照常', async () => {
    // 从内置原文整份 fork，只改并发声明 —— 别的手写最小 workflow 反而测不到「同名遮蔽」的真实形态
    await forkBotChat('bot-chat', (text) =>
      replaceOnce(
        text,
        'shuvix-workflow-concurrency: parallel',
        'shuvix-workflow-concurrency: skip'
      )
    )
    // IPC：被遮蔽的内置不在候选里，生效的是用户那份
    const wfs = (await pipelineOptions()).workflows.filter((w) => w.name === 'bot-chat')
    expect(wfs).toHaveLength(1)
    expect(wfs[0]).toMatchObject({ source: 'user', concurrency: 'skip' })

    // 卡片按 (文件名, YAML) 缓存校验结果：种一个新 bot，别重开 C4 那份（它的 ok 还在缓存里）
    writeBotMd(app, 'c17-shadow', { description: 'rides the shadowed pipeline' })
    await pane.refresh()
    await pane.selectRow('c17-shadow')
    const shot = await pipelineReady('pipeline block for c17-shadow')
    expect(shot.workflow).toBe('bot-chat')
    expect(shot.workflowOptions.filter((o) => o === 'bot-chat')).toHaveLength(1)
    expect(shot.workflowLabel).toContain('skip')
    expect(shot.meta).toBe('skip ≠ parallel')
    // 槽位表读的是生效的那份 md（fork 保留了 input schema）
    expect(shot.slots.map((s) => s.role)).toEqual(['intent', 'task', 'recheck'])
    // 非 parallel 的重入模式进横幅（健康 bot 的横幅是空的 —— 见 C4）
    const status = await statusIs('warn', 'card warned about the shadowed reentry mode')
    expect(status.banner).toEqual([
      expect.stringContaining("pipeline 'bot-chat' declares 'skip' reentry")
    ])
  })

  it('M7 行菜单「删除」：ConfirmDialog 点名该 bot；取消 → 文件在；确认 → 文件删、行随 bot.changed 自消失，开着的另一页不受影响', async () => {
    writeBotMd(app, 'del-keep', { description: 'stays open' })
    writeBotMd(app, 'del-gone', { description: 'to be deleted' })
    await pane.refresh()
    await pane.selectRow('del-keep')

    // 取消路径：什么都不动
    await pane.pickRowMenu('del-gone', 'delete-bot')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('del-gone')
    await confirm.cancel()
    await confirm.waitClosed()
    expect(existsSync(botPath('del-gone'))).toBe(true)
    expect((await pane.rows()).some((r) => r.name === 'del-gone')).toBe(true)

    // 确认路径：文件删掉，行随 bot.changed 自己消失 —— 刻意不 refresh
    await pane.pickRowMenu('del-gone', 'delete-bot')
    await confirm.waitOpen()
    await confirm.confirm()
    await until(() => !existsSync(botPath('del-gone')), 'bot file unlinked')
    await until(
      async () => !(await pane.rows()).some((r) => r.name === 'del-gone'),
      'row gone without manual refresh'
    )
    // 删的不是开着的那页：页留在原地
    const editor = await pane.editor()
    expect(editor.kind).toBe('edit')
    expect(editor.headerPath).toBe(botPath('del-keep'))
    expect((await pane.rows()).find((r) => r.name === 'del-keep')?.selected).toBe(true)
  })

  it('M8 删除正开着的 bot → 确认后档案页关闭（回欢迎页）、行消失、无活动会话', async () => {
    await pane.pickRowMenu('del-keep', 'delete-bot')
    await confirm.waitOpen()
    await confirm.confirm()
    await until(() => !existsSync(botPath('del-keep')), 'bot file unlinked')
    await until(
      async () => !(await pane.editor()).present,
      'bot page closed after deleting its bot'
    )
    await until(
      async () => !(await pane.rows()).some((r) => r.name === 'del-keep'),
      'row gone without manual refresh'
    )
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
    expect(await sidebar.activeTitle()).toBe('')
  })

  it('M9 非法行菜单「删除」：确认后文件删、琥珀行消失；开着的正是它的修复页 → 页关', async () => {
    writeFileSync(
      botPath('zz-broken'),
      ['---', 'shuvix: bot v1', 'name: zz-broken', '---', '', 'X', ''].join('\n')
    )
    await pane.refresh()
    await until(
      async () => (await pane.invalidRows()).includes('zz-broken.md'),
      'broken file listed'
    )
    await pane.selectInvalid('zz-broken.md')

    await pane.pickInvalidMenu('zz-broken.md', 'delete-bot-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('zz-broken.md')
    await confirm.confirm()
    await until(() => !existsSync(botPath('zz-broken')), 'file unlinked')
    await until(
      async () => !(await pane.invalidRows()).includes('zz-broken.md'),
      'amber row gone without manual refresh'
    )
    await until(async () => !(await pane.editor()).present, 'fix page closed')
  })
})
