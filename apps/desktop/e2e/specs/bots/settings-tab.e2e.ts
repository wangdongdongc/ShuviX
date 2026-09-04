/**
 * 设置页「Bots」tab（A1 / v3）—— 列表 / 非法文件修复通道 / 运行时读数条 + 槽位编辑器 /
 * 门控模型选择器 / 丢更新冲突 UI / 新建与重扫。
 *
 * DOM 一律经 harness/pages 的 botsPane（data-* 锚点）；能走 IPC 断的（文件内容、
 * session.list、subAgent.list）不碰 DOM。**用例有序**：本 spec 是一条叙事线（空态 →
 * 种 bot → 修非法 → 读数 → 槽位 → 门控 → 冲突 → 新建 → 重扫 → 管线遮蔽），后面的用例依赖
 * 前面留下的注册表状态 —— 各自的 bot 名互不复用，冲突用例一律以**外部 fs 改动**制造
 * 分歧（不驱动 CM6 打字）。
 *
 * v3 的读数条：管线行 + **槽位列表**（管线 input schema 声明的每个槽位一行下拉，改下拉
 * 直接给 md 的 `shuvix-bot-agents.<槽位>` 行打补丁并保存）+ 正文字符数 + 问题区。
 * 笔记状态行（`data-bot-notes-status`）与循环上限块（`data-bot-limits`）随笔记段与
 * bot→bot 接力一并退场 —— C4 里做否定断言。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, type E2EApp } from '../../harness/launch'
import type { CdpClient } from '../../harness/cdp'
import { until } from '../../harness/cdp'
import { botsPane, type BotsPane } from '../../harness/pages'
import { seedCustomProvider, writeAgentMd, writeBotMd } from '../../harness/seed'

let app: E2EApp
let settings: CdpClient
let pane: BotsPane

/** 门控模型用例的模型目录种子（自定义提供商 → 分组名可控、插入即启用） */
let gateProviderId = ''
const GATE_MODEL = 'e2e-gate-model'

const botPath = (name: string): string => join(app.botsDir, `${name}.md`)
const botIntentPath = (): string => join(app.agentsDir, 'bot-intent.md')

/** 读数条里某个槽位的下拉值（条未上屏 / 槽位不存在 → undefined） */
async function slotValue(role: string): Promise<string | undefined> {
  const s = await pane.inspect()
  return s.present ? s.slots.find((x) => x.role === role)?.value : undefined
}

beforeAll(async () => {
  app = await launchApp()

  // 模型目录：设置窗挂载时读一次 —— 种子要在 openSettings 之前
  gateProviderId = await seedCustomProvider(app.main, { name: 'E2E Gate' })
  await app.main.eval(
    `window.api.provider.addModel({ providerId: ${JSON.stringify(gateProviderId)}, modelId: ${JSON.stringify(GATE_MODEL)} })`
  )

  settings = await app.openSettings('bots')
  pane = await botsPane(settings)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('设置页 Bots tab', () => {
  it('C1 openSettings("bots") → hash #settings/bots；零 bot 空态（新建入口在，无列表行）', async () => {
    expect(await pane.hash()).toBe('#settings/bots')
    expect(await pane.newButtonPresent()).toBe(true)
    expect(await pane.rows()).toEqual([])
  })

  it('C2 列表：localeCompare 排序、首个默认选中、行显 displayName + description', async () => {
    writeBotMd(app, 'zeta-bot', { description: 'zeta desc', displayName: 'Zeta' })
    writeBotMd(app, 'alpha-bot', { description: 'alpha desc', displayName: 'Alpha' })
    await pane.refresh()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.length === 2 ? r : null
    }, 'two bot rows listed')
    expect(rows.map((r) => r.name)).toEqual(['alpha-bot', 'zeta-bot'])
    // 此前无选中项 → 重扫后回落到首项
    expect(rows[0].selected).toBe(true)
    expect(rows[0].displayName).toBe('Alpha')
    expect(rows[0].description).toBe('alpha desc')
    expect(rows[1].displayName).toBe('Zeta')
    expect(rows[1].description).toBe('zeta desc')
  })

  it('C3 非法文件：琥珀组 → 详情显原因 → 修复编辑器 → saveByFile 修好 → 迁入合法列表并选中', async () => {
    // description 是 bot md 必填 —— 缺它整份被拒（文件名取 aa- 前缀，修好后恰为列表首项）
    writeFileSync(
      botPath('aa-fixed'),
      ['---', 'shuvix: bot v1', 'name: aa-fixed', '---', '', 'BROKEN BODY.', ''].join('\n')
    )
    await pane.refresh()
    expect(await pane.invalidRows()).toEqual(['aa-fixed.md'])

    await pane.selectInvalid('aa-fixed.md')
    const detail = await pane.invalidDetail()
    expect(detail.fileName).toBe('aa-fixed.md')
    // 解析器的人读拒绝理由原文呈现（服务层文案不本地化）
    expect(detail.error).toContain("'description' is required")

    // 修复编辑器：原文（含正文）如实落进编辑器
    await pane.clickInvalidEdit()
    const editor = await until(async () => {
      const e = await pane.editor()
      return e.text.includes('BROKEN BODY.') ? e : null
    }, 'fix editor filled with raw text')
    expect(editor.transient).toBe(true)
    await pane.clickCancel()

    // 修好走 saveByFile（与策略页同一条修复通道）；套件不驱动 CM6 打字
    const fixed = [
      '---',
      'shuvix: bot v1',
      'name: aa-fixed',
      'description: fixed by e2e',
      '---',
      '',
      'BROKEN BODY.',
      ''
    ].join('\n')
    const saved = await settings.eval<{ success: boolean; error?: string }>(
      `window.api.bot.saveByFile({ fileName: 'aa-fixed.md', text: ${JSON.stringify(fixed)} })`
    )
    expect(saved.success).toBe(true)

    await pane.refresh()
    // 琥珀组清空、文件迁入合法列表；旧选中键（invalid:aa-fixed.md）失效 → 回落首项 = 它自己
    expect(await pane.invalidRows()).toEqual([])
    const rows = await pane.rows()
    expect(rows.map((r) => r.name)).toEqual(['aa-fixed', 'alpha-bot', 'zeta-bot'])
    expect(rows[0]).toMatchObject({ name: 'aa-fixed', selected: true })
  })

  it('C4 读数条健康路径：bot-chat · parallel、三个槽位（两必填已填、recheck 未填）、正文字数；无问题区；退场锚点不在', async () => {
    writeBotMd(app, 'c4-full', { description: 'c4 bot', displayName: 'C4' })
    await pane.refresh()

    await pane.selectRow('c4-full')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.length ? s : null
    }, 'inspect strip for c4-full')
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
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.length ? s : null
    }, 'inspect strip for c5-warn')
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
    // 没有缺省表：task 漏填就是漏填 —— 设置页得在跑之前说出来，而不是等会话里失败
    writeBotMd(app, 'c5-unset', {
      description: 'task slot left unset',
      agents: { intent: 'bot-intent' }
    })
    await pane.refresh()
    await pane.selectRow('c5-unset')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.length ? s : null
    }, 'inspect strip for c5-unset')
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
    const withDefault = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.length ? s : null
    }, 'inspect strip (default gate)')
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

    await pane.openGateModel()
    const groups = await pane.gateModelGroups()
    const label = groups.find((g) => g.includes('E2E Gate'))
    expect(label).toBeDefined()
    expect(await pane.expandGateModelGroup(label!)).toBe(true)
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
    const agents = await settings.eval<
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

  it('C8 冲突 → 加载磁盘版本：对话框上屏、磁盘未覆写、重挂含外部改动、再保存成功', async () => {
    writeBotMd(app, 'c8-conflict', { description: 'conflict reload bot' })
    await pane.refresh()
    await pane.selectRow('c8-conflict')

    // 编辑器挂载**之后**外部改盘（模拟 bot 在答话途中改自己的正文）
    appendFileSync(botPath('c8-conflict'), '\n\nEXTERNAL NOTE C8.\n')

    await pane.clickSave()
    await until(() => pane.conflictOpen(), 'conflict dialog shown')
    // 两个决议钮都在
    expect(
      await settings.eval<boolean>(
        `document.querySelector('[data-bot-conflict-overwrite]') !== null`
      )
    ).toBe(true)
    // 磁盘未被覆写：外部改动还在
    expect(readFileSync(botPath('c8-conflict'), 'utf-8')).toContain('EXTERNAL NOTE C8.')

    await pane.clickConflictReload()
    // 编辑器重挂，磁盘版本（含外部改动）进屏
    await until(
      async () => (await pane.editor()).text.includes('EXTERNAL NOTE C8.'),
      'editor remounted with disk version'
    )

    // 再保存：指纹已对上 → 写盘成功（内容逐字节同,以 mtime 前进为写入证据）
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

  it('C11 常规保存：成功写盘、重扫后同名行保持选中', async () => {
    await pane.selectRow('alpha-bot')
    const namesBefore = (await pane.rows()).map((r) => r.name)
    const before = statSync(botPath('alpha-bot')).mtimeMs

    await pane.clickSave()
    await until(() => statSync(botPath('alpha-bot')).mtimeMs > before, 'regular save wrote through')
    expect(await pane.conflictOpen()).toBe(false)

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.find((x) => x.name === 'alpha-bot')?.selected ? r : null
    }, 'alpha-bot still selected after save')
    expect(rows.map((r) => r.name)).toEqual(namesBefore)
  })

  it('C12 新建会话：data-bot-new-session → session.list 长出 settings.bots=[该 bot] 的会话', async () => {
    await pane.selectRow('zeta-bot')
    expect((await pane.editor()).newSessionPresent).toBe(true)
    await pane.clickNewSession()

    // IPC 断（主窗侧）：会话真的建出来，成员名单恰为这个 bot
    await until(
      () =>
        app.main.eval<boolean>(
          `window.api.session.list().then((list) =>
            list.some((s) => JSON.stringify(s.settings?.bots) === '["zeta-bot"]')
          )`
        ),
      'bot session created with settings.bots=["zeta-bot"]'
    )
  })

  it('C13 新建流程：模板预填 my-bot + bot 徽章；保存入列并选中；重名再建 → 错误横幅、编辑器留原地', async () => {
    await pane.clickNew()
    await until(async () => (await pane.editor()).nameInput === 'my-bot', 'template prefilled')
    const editor = await pane.editor()
    expect(editor.cardBadge).toBe('ShuviX bot · v1')

    await pane.clickSave()
    const rows = await until(async () => {
      const r = await pane.rows()
      return r.find((x) => x.name === 'my-bot')?.selected ? r : null
    }, 'my-bot listed and selected')
    expect(rows.some((r) => r.name === 'my-bot')).toBe(true)
    // 创建编辑器已关（回到常态编辑）
    expect((await pane.editor()).transient).toBe(false)
    // 模板预填的两个槽位在读数条里就位（intent → 门控模型行也在）
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.slots.length ? s : null
    }, 'inspect strip for my-bot')
    expect(shot.slots.map((s) => [s.role, s.value])).toEqual([
      ['intent', 'bot-intent'],
      ['task', 'default'],
      ['recheck', '']
    ])
    expect(shot.warningsCount).toBe(0)

    // 不改名直接再建 → 服务层拒绝，错误横幅上屏，编辑器留在原地
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
    expect(rejected.transient).toBe(true)
    await pane.clickCancel()
  })

  it('C14 重扫：磁盘删选中 md → 行消失、选中回落首项', async () => {
    // C13 结束时 my-bot 是选中项
    expect((await pane.rows()).find((r) => r.name === 'my-bot')?.selected).toBe(true)
    rmSync(botPath('my-bot'))
    await pane.refresh()

    const rows = await until(async () => {
      const r = await pane.rows()
      return r.some((x) => x.name === 'my-bot') ? null : r
    }, 'my-bot row gone after rescan')
    expect(rows[0]).toMatchObject({ name: 'aa-fixed', selected: true })
  })

  it('C15 用户遮蔽管线端到端：concurrency=skip 的 ~/.shuvix/workflows/bot-chat.md → 管线行 bot-chat · skip + 重入警告，槽位照常', async () => {
    // 从内置原文整份 fork，只改并发声明 —— 别的手写最小 workflow 反而测不到「同名遮蔽」的真实形态
    const src = await settings.eval<{ text: string } | { error: string }>(
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
})
