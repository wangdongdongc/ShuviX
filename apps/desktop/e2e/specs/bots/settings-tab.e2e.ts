/**
 * 设置页「Bots」tab（A1）—— 列表 / 非法文件修复通道 / 运行时读数条 / 门控模型选择器 /
 * 丢更新冲突 UI / 新建与重扫。
 *
 * DOM 一律经 harness/pages 的 botsPane（data-* 锚点）；能走 IPC 断的（文件内容、
 * session.list、subAgent.list）不碰 DOM。**用例有序**：本 spec 是一条叙事线（空态 →
 * 种 bot → 修非法 → 读数 → 门控 → 冲突 → 新建 → 重扫 → 管线遮蔽），后面的用例依赖
 * 前面留下的注册表状态 —— 各自的 bot 名互不复用，冲突用例一律以**外部 fs 改动**制造
 * 分歧（不驱动 CM6 打字）。
 *
 * 笔记读数不真跑调度：`.notes-state.json` 在**任何 inspect 之前**预置（主进程的
 * BotNotesScheduler 懒加载后进程内缓存 —— 种晚了就再也读不到）。
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

beforeAll(async () => {
  app = await launchApp()

  // 笔记调度状态：**先于本进程第一次 bot:inspect** 落盘（懒加载 + 进程内缓存）。
  // lastRunAt 取 0（「尚未归纳」）—— 非零会渲染成本地化日期，数字断言就不唯一了
  mkdirSync(app.botsDir, { recursive: true })
  writeFileSync(
    join(app.botsDir, '.notes-state.json'),
    JSON.stringify({ 'c4-notes': { lastRunAt: 0, pending: 7, sessions: {} } })
  )

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

  it('C4 读数条健康路径：bot-chat · parallel、四缺省角色、预置的笔记读数；notes:false 显禁用文案；无问题区', async () => {
    writeBotMd(app, 'c4-notes', { description: 'c4 bot', displayName: 'C4' })
    writeBotMd(app, 'c4-nonotes', { description: 'c4 silent bot', notes: false })
    await pane.refresh()

    await pane.selectRow('c4-notes')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.stagesText.includes('bot:c4-notes') ? s : null
    }, 'inspect strip for c4-notes')
    // 内置管线 + 内置并发模式（builtin bot-chat 声明 parallel）
    expect(shot.pipelineText).toBe('bot-chat · parallel')
    // 恰四个缺省角色，顺序与装配序一致
    expect(shot.stagesText).toBe(
      'intent: bot-intent · recheck: bot-intent · notes: bot-notes · task: bot:c4-notes'
    )
    // 预置状态文件的 pending 数字上屏（笔记调度不真跑）
    expect(shot.notesText).toContain('7')
    // 健康 bot 无 warnings 块
    expect(shot.warningsCount).toBe(0)

    await pane.selectRow('c4-nonotes')
    const off = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.stagesText.includes('bot:c4-nonotes') ? s : null
    }, 'inspect strip for c4-nonotes')
    // 禁用文案（三语均无数字 —— 不认具体 i18n 串）
    expect(off.notesText).not.toMatch(/\d/)
  })

  it('C5 警告聚合：管线缺失 + bot:ghost 悬空 + 双笔记标记 → 问题区 ≥3 条', async () => {
    writeBotMd(app, 'c5-warn', {
      description: 'warn bot',
      pipeline: 'no-such-flow',
      agents: { task: 'bot:ghost' },
      body: [
        'PERSONA.',
        '',
        '<!-- shuvix:bot-notes -->',
        '',
        'first notes',
        '',
        '<!-- shuvix:bot-notes -->',
        '',
        'second block'
      ].join('\n')
    })
    await pane.refresh()
    await pane.selectRow('c5-warn')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.stagesText.includes('bot:ghost') ? s : null
    }, 'inspect strip for c5-warn')
    // 管线不存在：无并发后缀
    expect(shot.pipelineText).toBe('no-such-flow')
    expect(shot.warningsCount).toBeGreaterThanOrEqual(3)
  })

  it('C6 门控行显隐：缺省 intent=bot-intent 时在屏；换自定义门控则隐藏、stages 显自定义 ref', async () => {
    writeAgentMd(app, 'my-gate', { description: 'custom gate agent' })
    writeBotMd(app, 'c6-gate', { description: 'custom gated bot', agents: { intent: 'my-gate' } })
    await pane.refresh()

    await pane.selectRow('c4-notes')
    const withDefault = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.stagesText.includes('bot:c4-notes') ? s : null
    }, 'inspect strip (default gate)')
    expect(withDefault.gateModelPresent).toBe(true)

    await pane.selectRow('c6-gate')
    const withCustom = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.stagesText.includes('bot:c6-gate') ? s : null
    }, 'inspect strip (custom gate)')
    expect(withCustom.gateModelPresent).toBe(false)
    expect(withCustom.stagesText).toContain('intent: my-gate')
  })

  it('C7 门控写穿全链路：选型号 → 覆盖文件长出且完整；subAgent.list 见用户条目；清除 → 文件留、model 行消失', async () => {
    await pane.selectRow('c4-notes')
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
    expect(content).toContain('shuvix-dispatch-only: true')

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

    // 编辑器挂载**之后**外部改盘（模拟笔记段的后台写入）
    appendFileSync(botPath('c8-conflict'), '\n<!-- shuvix:bot-notes -->\n\nEXTERNAL NOTE C8.\n')

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
    // 编辑器重挂，磁盘版本（含外部标记）进屏
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

  it('C9 冲突 → 仍然覆盖：编辑器缓冲无指纹重存胜，磁盘不再含外部标记', async () => {
    writeBotMd(app, 'c9-conflict', { description: 'conflict overwrite bot' })
    await pane.refresh()
    await pane.selectRow('c9-conflict')

    appendFileSync(botPath('c9-conflict'), '\n<!-- shuvix:bot-notes -->\n\nEXTERNAL NOTE C9.\n')
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

    appendFileSync(botPath('c10-conflict'), '\n<!-- shuvix:bot-notes -->\n\nEXTERNAL NOTE C10.\n')
    const before = statSync(botPath('c10-conflict')).mtimeMs
    await pane.clickSave()
    await until(() => pane.conflictOpen(), 'conflict dialog shown')

    await pane.clickConflictCancel()
    await until(async () => !(await pane.conflictOpen()), 'conflict dialog dismissed')
    // 三不动：内容、外部标记、mtime
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

  it('C15 用户遮蔽管线端到端：concurrency=skip 的 ~/.shuvix/workflows/bot-chat.md → 管线行 bot-chat · skip + 重入警告', async () => {
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

    await pane.selectRow('c4-notes')
    const shot = await until(async () => {
      const s = await pane.inspect()
      return s.present && s.pipelineText === 'bot-chat · skip' ? s : null
    }, 'pipeline row shows user-shadowed concurrency')
    expect(shot.stagesText).toContain('bot:c4-notes')
    // 非 parallel 的重入模式进问题区（此前健康 bot 的问题区是空的 —— 见 C4）
    expect(shot.warningsCount).toBeGreaterThanOrEqual(1)
  })
})
