/**
 * 主窗 Bot 档案页 —— 侧栏置顶「Bots」分组（BotGroup）+ 主区 BotPage。原设置页「Bots」tab
 * 的 C1–C15 叙事线整体搬家（列表 → 修非法 → 读数 → 槽位 → 门控 → 冲突 → 保存 → 新建会话 →
 * 新建 → 重扫 → 管线遮蔽），外加主窗独有的几处（M 组）：设置窗口不再有 Bots tab、档案页与
 * 活动会话互斥、组头 / 行菜单的 id 集、行菜单的新建会话与删除（ConfirmDialog）、保存后侧栏行
 * 随 `bot.changed` 自更新（displayName / 改名）。
 *
 * DOM 一律经 harness/pages 的 botsPane / sidebarPane / confirmPane / settingsTabsPane
 * （data-* 锚点）；能走 IPC 断的（文件内容、session.list、subAgent.list）不碰 DOM。
 * **用例有序**：一条叙事线，后面的用例依赖前面留下的注册表状态 —— 各自的 bot 名互不复用；
 * 冲突用例一律以**外部 fs 改动**制造分歧，属性卡字段经 setField（裸 DOM 文本框 + blur 提交）改、
 * 槽位经 setSlot（原生 setter + change）改，全程不驱动 CM6 打字。
 *
 * 分组是懒扫的：磁盘外写入的文件不广播 `bot.changed`，种完要走组头菜单 refresh；而经
 * botService 落盘的每一次（保存 / 新建 / 删除 / 修好）都会广播，那些用例**刻意不 refresh** ——
 * 断的就是「行自己更新」。
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
  type BotsInspectShot,
  type BotsPane,
  type ConfirmPane,
  type MenuItemShot,
  type SidebarPane
} from '../../harness/pages'
import { seedCustomProvider, waitRendererReady, writeAgentMd, writeBotMd } from '../../harness/seed'

let app: E2EApp
let pane: BotsPane
let sidebar: SidebarPane
let confirm: ConfirmPane

/** 门控模型用例的模型目录种子（自定义提供商 → 分组名可控、插入即启用） */
let gateProviderId = ''
const GATE_MODEL = 'e2e-gate-model'

const botPath = (name: string): string => join(app.botsDir, `${name}.md`)
const botIntentPath = (): string => join(app.agentsDir, 'bot-intent.md')

/** items → 自定义项的 id（分隔符滤掉，同 sidebarPane.lastMenuIds 的口径） */
const idsOf = (items: MenuItemShot[] | null): string[] =>
  (items ?? []).filter((it) => it.id).map((it) => it.id as string)

interface SessionRow {
  id: string
  title: string
  settings?: { bots?: string[] }
}
const listSessions = (): Promise<SessionRow[]> => app.main.eval(`window.api.session.list()`)

/** 等 session.list 里长出成员名单恰为 [name] 的那条会话 */
const findBotSession = (name: string): Promise<SessionRow> =>
  until(
    async () =>
      (await listSessions()).find(
        (s) => JSON.stringify(s.settings?.bots) === JSON.stringify([name])
      ) ?? null,
    `bot session with settings.bots=["${name}"]`
  )

/** 读数条就绪（槽位已上屏）的快照 */
const inspectReady = (what: string): Promise<BotsInspectShot> =>
  until(async () => {
    const s = await pane.inspect()
    return s.present && s.slots.length ? s : null
  }, what)

/** 读数条里某个槽位的下拉值（条未上屏 / 槽位不存在 → undefined） */
async function slotValue(role: string): Promise<string | undefined> {
  const s = await pane.inspect()
  return s.present ? s.slots.find((x) => x.role === role)?.value : undefined
}

beforeAll(async () => {
  app = await launchApp()

  // 模型目录：主窗 useAppInit 挂载时读一次，之后靠 providers.changed 广播重拉 ——
  // 在 renderer 挂载前种完，两条路径都稳
  gateProviderId = await seedCustomProvider(app.main, { name: 'E2E Gate' })
  await app.main.eval(
    `window.api.provider.addModel({ providerId: ${JSON.stringify(gateProviderId)}, modelId: ${JSON.stringify(GATE_MODEL)} })`
  )

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
    // description 是 bot md 必填 —— 缺它整份被拒（文件名取 aa- 前缀，修好后恰为列表首项）
    writeFileSync(
      botPath('aa-fixed'),
      ['---', 'shuvix: bot v1', 'name: aa-fixed', '---', '', 'BROKEN BODY.', ''].join('\n')
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

  it('C4 读数条健康路径：bot-chat · parallel、三个槽位（两必填已填、recheck 未填）、正文字数；无问题区；退场锚点不在', async () => {
    writeBotMd(app, 'c4-full', { description: 'c4 bot', displayName: 'C4' })
    await pane.refresh()

    await pane.selectRow('c4-full')
    const shot = await inspectReady('inspect strip for c4-full')
    // 内置管线 + 内置并发模式（builtin bot-chat 声明 parallel）
    expect(shot.pipelineText).toBe('bot-chat · parallel')
    // 槽位 = 管线 input schema 的 agents.properties，顺序与声明序一致；必填带星标
    expect(shot.slots.map((s) => [s.role, s.required, s.value])).toEqual([
      ['intent', true, 'bot-intent'],
      ['task', true, 'default'],
      ['recheck', false, '']
    ])
    // 下拉候选 = 「未填」+ 注册表里的 agent 名（内置在列，用户档案此刻还没有）
    for (const s of shot.slots) {
      expect(s.options[0]).toBe('')
      expect(s.options).toContain('bot-intent')
      expect(s.options).toContain('default')
      expect(s.warned).toBe(false)
    }
    // 正文字数（种子正文 'BOT BODY.'）
    expect(shot.bodyChars).toBe('BOT BODY.'.length)
    // 健康 bot 无 warnings 块；缺省 intent=bot-intent → 门控模型行在
    expect(shot.warningsCount).toBe(0)
    expect(shot.gateModelPresent).toBe(true)
    // v3 退场的两个锚点：笔记状态行、循环上限块
    expect(await pane.retiredAnchors()).toEqual([])
  })

  it('C5 警告聚合：管线缺失 + 槽位指向不存在的 agent → 问题区 2 条、该槽位警示配色', async () => {
    writeBotMd(app, 'c5-warn', {
      description: 'warn bot',
      pipeline: 'no-such-flow',
      agents: { intent: 'bot-intent', task: 'ghost-agent' }
    })
    await pane.refresh()
    await pane.selectRow('c5-warn')
    const shot = await inspectReady('inspect strip for c5-warn')
    // 管线不存在：无并发后缀；管线没声明槽位，bot 填的两个槽位都以「额外」身份列出（不必填）
    expect(shot.pipelineText).toBe('no-such-flow')
    expect(shot.slots.map((s) => [s.role, s.required, s.value])).toEqual([
      ['intent', false, 'bot-intent'],
      ['task', false, 'ghost-agent']
    ])
    // 填了一个不存在的名字：下拉仍显示那个值（不静默换成别的），并带警示配色
    expect(shot.slots.find((s) => s.role === 'task')!.warned).toBe(true)
    expect(shot.warningsCount).toBe(2)
    expect(shot.warnings.some((w) => w.includes('ghost-agent'))).toBe(true)
  })

  it('C5b 必填槽位未填 → 问题区点名该槽位；下拉选一个 agent → md 长出那一行、问题区清空', async () => {
    // 没有缺省表：task 漏填就是漏填 —— 档案页得在跑之前说出来，而不是等会话里失败
    writeBotMd(app, 'c5-unset', {
      description: 'task slot left unset',
      agents: { intent: 'bot-intent' }
    })
    await pane.refresh()
    await pane.selectRow('c5-unset')
    const shot = await inspectReady('inspect strip for c5-unset')
    const task = shot.slots.find((s) => s.role === 'task')!
    expect(task).toMatchObject({ required: true, value: '', warned: true })
    expect(shot.warningsCount).toBe(1)
    expect(shot.warnings[0]).toContain('task')

    // 下拉改槽位 = 给 md 打补丁并保存：文件长出 `  task: default`，其余行不动
    expect(await pane.setSlot('task', 'default')).toBe(true)
    const content = await until(() => {
      const c = readFileSync(botPath('c5-unset'), 'utf-8')
      return /shuvix-bot-agents:\n(?: {2}[\w-]+: [^\n]+\n)* {2}task: default\n/.test(c) ? c : null
    }, 'task slot written into the md')
    expect(content).toContain('  intent: bot-intent\n')
    expect(content).toContain('task slot left unset')
    // 读数条随保存重挂并现算：槽位已填、问题区消失
    await until(async () => (await slotValue('task')) === 'default', 'inspect strip refreshed')
    expect((await pane.inspect()).warningsCount).toBe(0)
  })

  it('C6 门控行显隐：缺省 intent=bot-intent 时在屏；换自定义门控则隐藏、intent 下拉显自定义 ref', async () => {
    writeAgentMd(app, 'my-gate', { description: 'custom gate agent' })
    writeBotMd(app, 'c6-gate', { description: 'custom gated bot', agents: { intent: 'my-gate' } })
    await pane.refresh()

    await pane.selectRow('c4-full')
    const withDefault = await inspectReady('inspect strip (default gate)')
    expect(withDefault.gateModelPresent).toBe(true)

    await pane.selectRow('c6-gate')
    const withCustom = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.some((x) => x.role === 'intent' && x.value === 'my-gate')
        ? s
        : null
    }, 'inspect strip (custom gate)')
    expect(withCustom.gateModelPresent).toBe(false)
    // 用户档案进了下拉候选
    expect(withCustom.slots.find((s) => s.role === 'intent')!.options).toContain('my-gate')
  })

  it('C6b 可选槽位写穿：recheck 选 my-gate → md 块里长出那一行；清回「未填」→ 行消失、块其余不动', async () => {
    await pane.selectRow('c4-full')
    await until(async () => (await slotValue('recheck')) === '', 'recheck slot unset')

    expect(await pane.setSlot('recheck', 'my-gate')).toBe(true)
    const withRecheck = await until(() => {
      const c = readFileSync(botPath('c4-full'), 'utf-8')
      return /shuvix-bot-agents:\n(?: {2}[\w-]+: [^\n]+\n)* {2}recheck: my-gate\n/.test(c)
        ? c
        : null
    }, 'recheck slot written into the md')
    expect(withRecheck).toContain('  intent: bot-intent\n')
    expect(withRecheck).toContain('  task: default\n')
    await until(async () => (await slotValue('recheck')) === 'my-gate', 'strip shows recheck')
    // my-gate 真实存在 → 不进问题区
    expect((await pane.inspect()).warningsCount).toBe(0)

    // 清回「未填」：只拔掉那一行
    expect(await pane.setSlot('recheck', '')).toBe(true)
    const cleared = await until(() => {
      const c = readFileSync(botPath('c4-full'), 'utf-8')
      return c.includes('recheck') ? null : c
    }, 'recheck line removed from the md')
    expect(cleared).toContain('shuvix-bot-agents:\n  intent: bot-intent\n  task: default\n')
    await until(async () => (await slotValue('recheck')) === '', 'strip shows recheck unset')
  })

  it('C7 门控写穿全链路：选型号 → 覆盖文件长出且完整；subAgent.list 见用户条目；清除 → 文件留、model 行消失', async () => {
    await pane.selectRow('c4-full')
    await until(async () => (await pane.inspect()).gateModelPresent, 'gate model row mounted')

    // 种子提供商要在主窗的模型目录里（beforeAll 在 renderer 挂载前种的；万一目录还没重拉，关了再开）
    const groups = await until(async () => {
      if (!(await pane.gateModelOpen())) await pane.openGateModel()
      const g = await pane.gateModelGroups()
      if (g.some((x) => x.includes('E2E Gate'))) return g
      await pane.closeGateModel()
      return null
    }, 'gate model picker lists the seeded provider')
    const label = groups.find((g) => g.includes('E2E Gate'))!
    expect(await pane.expandGateModelGroup(label)).toBe(true)
    expect(await pane.pickGateModel(GATE_MODEL)).toBe(true)

    // 覆盖文件落盘（GUI 写覆盖档案，模型链零改动）—— 断文件本体
    const ref = `${gateProviderId}/${GATE_MODEL}`
    const content = await until(() => {
      try {
        const c = readFileSync(botIntentPath(), 'utf-8')
        return c.includes(`shuvix-model: ${ref}`) ? c : null
      } catch {
        return null
      }
    }, 'bot-intent override file written with model')
    // 覆盖文件完整性：从内置原文整份带出，不是只有一行 model 的残片
    expect(content).toContain('shuvix: agent v1')
    expect(content).toContain('name: bot-intent')
    expect(content).toMatch(/\ndescription: .+/)
    // 正文（人格提示词）也在 —— 只剩 frontmatter 就说明没带出原文
    expect(content.replace(/^---\n[\s\S]*?\n---\n/, '').trim().length).toBeGreaterThan(100)

    // 注册表视角：用户条目带 model 生效，内置条目被遮蔽
    const agents = await app.main.eval<
      Array<{ name: string; source: string; model?: string; overridden?: boolean }>
    >('window.api.subAgent.list()')
    const user = agents.find((a) => a.name === 'bot-intent' && a.source === 'user' && !a.overridden)
    expect(user?.model).toBe(ref)
    expect(agents.some((a) => a.name === 'bot-intent' && a.overridden)).toBe(true)

    // 清除：回「跟随会话」——覆盖文件仍在（用户可能手编过），只拔掉 model 行
    await until(() => pane.clearGateModel(), 'gate model clear affordance shown')
    await until(() => {
      try {
        return !readFileSync(botIntentPath(), 'utf-8').includes('shuvix-model')
      } catch {
        return false
      }
    }, 'model line removed from override file')
    expect(readFileSync(botIntentPath(), 'utf-8')).toContain('name: bot-intent')
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
  it('C12 新建会话：data-bot-new-session → session.list 长出 settings.bots=[该 bot] 的会话，它成为主窗活动会话、档案页让位', async () => {
    await pane.selectRow('zeta-bot')
    expect((await pane.editor()).newSessionPresent).toBe(true)
    expect(await sidebar.activeTitle()).toBe('')
    await pane.clickNewSession()

    // IPC 断：会话真的建出来，成员名单恰为这个 bot
    const session = await findBotSession('zeta-bot')
    // 主窗侧：档案页关了，新会话是活动行（带 bot 图标）
    await until(async () => !(await pane.editor()).present, 'bot page left for the new session')
    await until(
      async () => (await sidebar.activeTitle()) === session.title,
      'new bot session activated'
    )
    expect(await sidebar.activeRowIsBot()).toBe(true)
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
  })

  it('M6 行菜单「新建 Bot 会话」：session.list 长出 settings.bots=[该 bot] 的会话并成为活动会话（档案页让位）', async () => {
    await pane.selectRow('alpha-bot')
    expect(await sidebar.activeTitle()).toBe('')
    await pane.pickRowMenu('alpha-bot', 'new-bot-chat')

    const session = await findBotSession('alpha-bot')
    await until(async () => !(await pane.editor()).present, 'bot page left for the new session')
    await until(
      async () => (await sidebar.activeTitle()) === session.title,
      'row-menu bot session activated'
    )
    expect(await sidebar.activeRowIsBot()).toBe(true)
    expect((await pane.rows()).some((r) => r.selected)).toBe(false)
  })

  it('C13 新建流程：组头菜单「新建 bot」→ 模板预填 my-bot + bot 徽章；保存 → 切成 edit、入列并选中；重名再建 → 错误横幅、页留原地；取消 → 页关', async () => {
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
    // 模板预填的两个槽位在读数条里就位（intent → 门控模型行也在）
    const shot = await inspectReady('inspect strip for my-bot')
    expect(shot.slots.map((s) => [s.role, s.value])).toEqual([
      ['intent', 'bot-intent'],
      ['task', 'default'],
      ['recheck', '']
    ])
    expect(shot.warningsCount).toBe(0)
    expect(shot.gateModelPresent).toBe(true)

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

  it('C15 用户遮蔽管线端到端：concurrency=skip 的 ~/.shuvix/workflows/bot-chat.md → 管线行 bot-chat · skip + 重入警告，槽位照常', async () => {
    // 从内置原文整份 fork，只改并发声明 —— 别的手写最小 workflow 反而测不到「同名遮蔽」的真实形态
    const src = await app.main.eval<{ text: string } | { error: string }>(
      `window.api.workflow.getSource({ name: 'bot-chat', source: 'builtin' })`
    )
    if ('error' in src) throw new Error(`builtin bot-chat source: ${src.error}`)
    expect(src.text).toContain('shuvix-workflow-concurrency: parallel')
    const forked = src.text.replace(
      'shuvix-workflow-concurrency: parallel',
      'shuvix-workflow-concurrency: skip'
    )
    const wfDir = join(app.home, '.shuvix', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(join(wfDir, 'bot-chat.md'), forked)

    await pane.selectRow('c4-full')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.pipelineText === 'bot-chat · skip' ? s : null
    }, 'pipeline row shows user-shadowed concurrency')
    // 槽位表读的是生效的那份 md（fork 保留了 input schema）
    expect(shot.slots.map((s) => s.role)).toEqual(['intent', 'task', 'recheck'])
    // 非 parallel 的重入模式进问题区（此前健康 bot 的问题区是空的 —— 见 C4）
    expect(shot.warningsCount).toBeGreaterThanOrEqual(1)
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
