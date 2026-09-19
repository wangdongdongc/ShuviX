/**
 * 侧栏「Hooks」分组的 UI 呈现（薄 DOM 层，经 harness/pages）—— 原「设置 → Hooks」tab 搬到
 * 前台之后的整组用例（编号 HS-*），与 policies-sidebar.e2e.ts 同一副骨架（HookGroup 镜像
 * PolicyGroup）。
 *
 * 用户 hook 点一行**就是打开这份 md 的笔记本会话**（隐藏项目 `__hooks__`，自动保存，没有保存
 * 按钮），主区就是普通笔记本；内置 hook 的 md **随包发布成真实文件**（运行时按当前语言现读的
 * 就是它），点行开的是那份文件的**只读**笔记本（另一个载体项目 `__hooks_builtin__`：没有输入
 * 卡片、编辑器不可编辑）。「创建覆盖副本」收在**内置行的右键 / ⋮ 菜单**里，落一份同名用户文件
 * 再打开它的笔记（已覆盖时该项置灰不消失）。同名遮蔽是**展示态**（resolveShadowing 裁决）：
 * 生效的那份照常，不生效的那份划线 + 「已覆盖」徽标，IPC 的 list 始终列全部份数。解析不过的
 * 文件不生效也**不遮蔽内置同名 hook**，列在末尾的琥珀行里。
 *
 * 分组是懒扫的：经宿主落盘的写入（笔记本自动保存 / 新建 / 删除）经 **300ms 合并窗口**广播
 * `hook.changed` 自动重扫（registryNotes.ts 的 CHANGED_DEBOUNCE_MS）—— 所以事件链断言一律
 * 走 `until`，不数事件次数、不睡固定时长当同步点。绕过宿主直接写盘的（writeFileSync 种子）
 * 不广播，要走组头菜单的「刷新」或窗口聚焦重扫。
 *
 * ⚠️ **内置 md 是本仓的真目录**：隔离实例只换了 HOME，`getBuiltinHooksDir()` 的未打包分支
 * 指的仍是 `packages/agent-runtime/src/hook/builtinHooks/md`。所以这份 spec **只读它，绝不
 * 写**，也绝不写「试着往内置 hook 里写、断言被拒」这类用例 —— 闸门若回归，那种用例会改掉
 * 产品源码本身。HS-B2 里那条「字节与 mtime 都没变」既是断言也是护栏：任何一次意外的自动保存
 * 都在那里现形。
 *
 * ⚠️ 界面语言**显式钉死**（beforeAll 钉 en，HS-G1 再切 zh），不跟系统语言走：内置 hook 的
 * 显示名与「读哪一份文件」三语各一份，不钉死就只能断「是三语里的某一句」。切语言时宿主会
 * 广播 `hook.changed`（settingsHandlers.ts），分组自己重扫 —— 刻意不手动刷新。
 * （en 与 zh 的 hooksGroup 文案同为 "Hooks"，组头标签当不了语言落定判据 —— setLanguage 借
 * 策略组的标签当哨兵，它三语各不同。）
 *
 * 用例间有顺序依赖：同一个主窗口一路点下去（先验懒扫与初始空态，再种子、再逐级打开笔记）。
 * 组顺序（bots → agents → policies → hooks → skills → knowledge）已由 policies-sidebar 的
 * PS-H2 钉死，这里不重复测。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { BUILTIN_HOOK_SPECS } from '@shuvix/agent-runtime'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  confirmPane,
  hooksSidebarPane,
  policiesSidebarPane,
  registryNotePane,
  settingsTabsPane,
  sidebarPane,
  type ConfirmPane,
  type HooksSidebarPane,
  type PoliciesSidebarPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  noteWrite,
  registryNoteSessions,
  waitRendererReady
} from '../../harness/seed'

const HOOKS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.hook
/** 内置 hook（随包发布的 md）的只读载体 —— 与用户 hook 分属两个项目 */
const BUILTIN_PROJECT = REGISTRY_NOTE_PROJECT_IDS.hookBuiltin
/** 整份 spec 里唯一一份内置 hook（BUILTIN_HOOK_SPECS 不硬编码条数，但覆盖/切语言用的都是它） */
const BUILTIN_SAMPLE = 'auto-title'

/** hook.list 一行的窄投影（本 spec 用到的字段） */
interface HookListRow {
  name: string
  displayName: string
  /** 绑定的埋点 id 列表 */
  triggers: string[]
  source: 'builtin' | 'user'
  /** 这份 hook 的 md 真实路径：用户的在 ~/.shuvix/hooks，内置的在应用包/本仓（当前语言那一版） */
  basePath: string
  overridden?: boolean
  overriddenBy?: string
}

/** 只读笔记本开出来的会话要素（IPC 直问宿主，UI 之外的事实源） */
interface BuiltinNote {
  id: string
  projectId: string | null
  notebookPath: string
  workingDirectory: string
}

let app: E2EApp
let pane: HooksSidebarPane
let note: RegistryNotePane
let confirm: ConfirmPane
/** 语言落定哨兵（hooksGroup 三语里 en/zh 同为 "Hooks"，借三语各不同的策略组标签判） */
let policiesPane: PoliciesSidebarPane
let hooksDir = ''

const hookPath = (fileName: string): string => join(hooksDir, fileName)
const listHooks = (): Promise<HookListRow[]> => app.main.eval('window.api.hook.list()')

/** 绕过宿主直接写盘（不广播 hook.changed —— 之后要么 refresh、要么聚焦、要么断「不出现」） */
const writeHook = (fileName: string, text: string): void => {
  mkdirSync(hooksDir, { recursive: true })
  writeFileSync(hookPath(fileName), text)
}

/** 一份 hook md：frontmatter 行 + 正文 */
const md = (frontmatter: string[], body = 'Body.'): string =>
  ['---', ...frontmatter, '---', '', body, ''].join('\n')

/**
 * 最小合法用户 hook（文件名与 frontmatter name 可以不同 —— 同名裁决要的正是这一点）。
 * agent / trigger / when 取与「新建 Hook」模板同一组值（HS-B5 的卡片字段断言与 HS-C2 共用）。
 */
const validHook = (name: string, displayName: string): string =>
  md([
    'shuvix: hook v1',
    `name: ${name}`,
    `shuvix-displayName: ${displayName}`,
    `description: ${name} fixture`,
    'shuvix-hook-agent: explore',
    'shuvix-hook-on:',
    '  - trigger: session.turn-completed',
    '    when: event.turnCount == 1'
  ])

/** 缺 shuvix-hook-agent → 解析器判整份非法（HS-A4 的样本分支） */
const missingAgentHook = (name: string): string =>
  md(['shuvix: hook v1', `name: ${name}`, 'shuvix-hook-on:', '  - trigger: session.turn-completed'])

/** when 的 CEL 语法错 → 非法，且不遮蔽内置同名 hook（HS-D1） */
const badCelHook = (name: string): string =>
  md([
    'shuvix: hook v1',
    `name: ${name}`,
    'shuvix-hook-agent: explore',
    'shuvix-hook-on:',
    '  - trigger: session.turn-completed',
    '    when: event.turnCount =='
  ])

/** 某份内置 hook 当前生效的那一行（随包 md 的路径就在它的 basePath 上） */
const builtinHook = async (name: string): Promise<HookListRow> =>
  (await listHooks()).find((h) => h.name === name && h.source === 'builtin')!

/** IPC 直问宿主：这份内置 hook 的只读笔记本是哪一条会话（幂等，已开则复用） */
const openBuiltinNote = (name: string): Promise<BuiltinNote> =>
  app.main.eval<BuiltinNote>(
    `window.api.hook.openBuiltinNote(${JSON.stringify({ name })}).then((s) => ({
      id: s.id,
      projectId: s.projectId,
      notebookPath: (s.settings && s.settings.notebookPath) || '',
      workingDirectory: s.workingDirectory || ''
    }))`
  )

/**
 * 一份 md 正文里第一段**纯散文前缀** —— 拿它当「读到的是盘上这一份」的特征串。
 * 标题 / 列表 / 引用的行首标记与行内的 `code`、**bold** 在 live-preview 里都会被吃掉，
 * 所以带任何 markdown 记号的行都不能整行拿来比对 `.cm-content` 的文字；从行首切到第一个
 * markdown 记号之前的这段前缀两边逐字一致（内置 auto-title 的正文是一整段带 `code` 的散文，
 * 前缀切在第一个反引号之前）。
 */
const bodyMarkerOf = (filePath: string): string => {
  const body = readFileSync(filePath, 'utf8').split(/^---$/m).slice(2).join('---')
  for (const raw of body.split('\n')) {
    const prefix = raw.split(/[#>\-*\d|`_*[\]<>|]/)[0].trim()
    if (prefix.length >= 20) return prefix.slice(0, 60)
  }
  throw new Error(`no plain-prose body prefix in ${filePath}`)
}

/** 语言落定哨兵的期望值 —— 策略组标签三语各不同（hooksGroup 的 en/zh 同为 "Hooks"，当不了判据） */
const LANG_SENTINEL: Record<'en' | 'zh', string> = {
  en: en.sidebar.policiesGroup,
  zh: zh.sidebar.policiesGroup
}

/**
 * 钉住界面语言。主进程的 i18n 在这次 IPC 里就换好了（hookService 每次 list 现读），渲染进程
 * 要等 `settings.changed` 回来才换 —— 策略组标签是它的判据。语言变更会**广播 hook.changed**
 * （settingsHandlers.ts），分组自己重扫 —— 刻意不手动刷新，行标签跟上正是 HS-G1 要断的东西。
 */
const setLanguage = async (lang: 'en' | 'zh'): Promise<void> => {
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(lang)} })`
  )
  await until(
    async () => (await policiesPane.label()) === LANG_SENTINEL[lang],
    `renderer language switched to ${lang}`
  )
}

beforeAll(async () => {
  app = await launchApp()
  hooksDir = join(app.home, '.shuvix', 'hooks')
  await waitRendererReady(app.main)
  pane = hooksSidebarPane(app.main)
  note = registryNotePane(app.main)
  confirm = confirmPane(app.main)
  policiesPane = policiesSidebarPane(app.main)
  // 隔离实例默认跟系统语言走 —— 本地化文案与「读哪一份 md」都得先钉死。
  // 刻意**不展开**：懒扫断言（HS-A1）必须抢在第一次扫描之前
  await setLanguage('en')
})
afterAll(async () => {
  await app.stop()
})

describe('侧栏 Hooks 分组', () => {
  it('HS-A1 懒扫：展开前分组正文一个子节点都不渲染（scanned 为 null，连空态都没有）', async () => {
    // 这条必须排第一：扫过之后折叠只是收高度（AnimatedCollapse），行仍在 DOM 里，读数不再归零
    expect(await pane.headerCount()).toBe(1)
    expect(await pane.bodyChildCount()).toBe(0)
  })

  it('HS-A2 初始列表：内置行全量置顶（条数 = BUILTIN_HOOK_SPECS 条数），全部带锁、无划线无徽标；用户 / 非法为空', async () => {
    await pane.expand()
    const builtin = await pane.builtinRows()
    expect(builtin.map((r) => r.name).sort()).toEqual(BUILTIN_HOOK_SPECS.map((s) => s.name).sort())
    // 行首那把锁是「内置」的标记（生效与否都只能看）；此时没有任何同名覆盖
    expect(builtin.every((r) => r.locked && !r.struck && !r.badge)).toBe(true)
    expect(await pane.userRows()).toEqual([])
    expect(await pane.invalidRows()).toEqual([])
  })

  it('HS-A3 三段行序：种 1 合法 + 1 非法后，DOM 行序 = 内置 → 用户 → 非法', async () => {
    // 绕过宿主直接写盘：不广播 hook.changed，靠组头菜单的「刷新」
    writeHook('hs-user.md', validHook('hs-user', 'HS User Hook'))
    writeHook('hs-broken.md', missingAgentHook('hs-broken'))
    await pane.refresh()

    expect((await pane.userRows()).map((r) => r.fileName)).toEqual(['hs-user.md'])
    expect((await pane.invalidRows()).map((r) => r.fileName)).toEqual(['hs-broken.md'])
    const kinds = await app.main.eval<string[]>(
      `[...document.querySelectorAll('[data-hook-builtin-row],[data-hook-row],[data-hook-invalid-row]')]
        .map((r) =>
          r.hasAttribute('data-hook-builtin-row')
            ? 'builtin'
            : r.hasAttribute('data-hook-row')
              ? 'user'
              : 'invalid'
        )`
    )
    // 三段各不相交地依次出现：最后一个内置 < 第一个用户 < 最后一个用户 < 第一个非法
    expect(kinds.indexOf('user')).toBeGreaterThan(kinds.lastIndexOf('builtin'))
    expect(kinds.indexOf('invalid')).toBeGreaterThan(kinds.lastIndexOf('user'))
    expect(kinds.filter((k) => k === 'builtin')).toHaveLength(BUILTIN_HOOK_SPECS.length)
  })

  it('HS-A4 非法行形态：琥珀行按文件名认、font-mono、title 带解析器的拒绝理由；不混进用户行', async () => {
    const invalid = await pane.invalidRows()
    const row = invalid.find((r) => r.fileName === 'hs-broken.md')!
    expect(row.label).toBe('hs-broken.md')
    expect(row.mono).toBe(true)
    // 缺 shuvix-hook-agent 的拒绝理由（fixture 就是冲着这个分支写的）
    expect(row.title).toContain("missing 'shuvix-hook-agent'")
    // 琥珀行没有锁 / 划线 / 徽标 —— 那是另外两种行的语汇
    expect([row.locked, row.struck, row.badge]).toEqual([false, false, false])
    expect((await pane.userRows()).some((r) => r.fileName === 'hs-broken.md')).toBe(false)
  })

  it('HS-B1 内置行：点它开的是**随包那份 md** 的只读笔记本（另一个载体项目、正文来自盘上同一路径、没有输入卡片、编辑器不可编辑）；再点复用同会话', async () => {
    const listed = await builtinHook(BUILTIN_SAMPLE)
    const fileName = basename(listed.basePath)
    expect(fileName, '内置行的 basePath 是空的').not.toBe('')

    await pane.openBuiltin(BUILTIN_SAMPLE)
    expect(await pane.activeRow()).toEqual({ builtinRow: BUILTIN_SAMPLE })

    // ① IPC 先行：会话挂在只读载体下，notebookPath 正是运行时挑中的那份文件（en 已钉死）
    const opened = await openBuiltinNote(BUILTIN_SAMPLE)
    expect(opened.projectId).toBe(BUILTIN_PROJECT)
    expect(opened.notebookPath).toBe(`${BUILTIN_SAMPLE}.md`)
    expect(opened.notebookPath).toBe(fileName)
    // ② 载体的工作目录是内置目录本身，与用户 hook 那一份泾渭分明
    expect(opened.workingDirectory).toBe(dirname(listed.basePath))
    expect(opened.workingDirectory).not.toBe(hooksDir)

    // ③ 正文来自盘上同一路径 —— 「跑的和看的是同一份文件」
    await note.waitBody(bodyMarkerOf(listed.basePath))

    // ④ 只读：没有悬浮输入卡、编辑器 contenteditable 为 false（对照组在 HS-B3）
    expect(await note.hasInputCard()).toBe(false)
    expect(await note.editorEditable()).toBe(false)

    // ⑤ 一份文件至多一条会话：再点一次复用，不另开
    const before = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(before.filter((n) => n.notebookPath === fileName).map((n) => n.id)).toEqual([opened.id])
    await pane.openBuiltin(BUILTIN_SAMPLE)
    expect(await registryNoteSessions(app.main, BUILTIN_PROJECT)).toEqual(before)
  })

  /**
   * 内置 md 是**本仓的真目录**（隔离实例只换 HOME）。这条只读它、绝不写它，也绝不写
   * 「试着往里写、断言被拒」那类用例 —— 闸门若回归，那种用例会改掉产品源码本身。
   * 挡住按键的是 `contenteditable="false"`（HS-B1 ④ 断的就是那个开关，并在 HS-B3 自带可写
   * 对照组）；这一条守的是另一半：**挂载 / 失焦都不会触发一次自动保存**。
   */
  it('HS-B2 只读笔记一个字节都不写盘：跨过自动保存防抖与 300ms 合并窗口后，字节与 mtime 都没变', async () => {
    const filePath = (await builtinHook(BUILTIN_SAMPLE)).basePath
    const before = readFileSync(filePath)
    const mtimeBefore = statSync(filePath).mtimeMs

    // 笔记本按 200ms 防抖落盘，失焦是它的另一条提交时机 —— 两条都走一遍再等过窗口
    await app.main.eval(`(() => {
      document.querySelector('.cm-content')?.dispatchEvent(new Event('blur', { bubbles: true }))
      window.dispatchEvent(new Event('blur'))
      return true
    })()`)
    await sleep(800)

    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(statSync(filePath).mtimeMs).toBe(mtimeBefore)
  })

  it('HS-B3 用户 hook 行：点它打开这份文件的笔记本（可编辑、有输入卡），一份文件只一条会话，活动行 + 组头高亮', async () => {
    await pane.selectUserRow('hs-user.md')
    expect(await pane.activeRow()).toEqual({ row: 'hs-user.md' })
    expect(await pane.headerActive()).toBe(true)
    await note.waitCard()

    // HS-B1 ④ 的对照组：同两个读数在可写笔记本上必须回 true，否则那两条就是空转
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)

    const notes = await registryNoteSessions(app.main, HOOKS_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'hs-user.md')).toHaveLength(1)
    // 再点一次复用，不另开
    await pane.selectUserRow('hs-user.md')
    expect(await registryNoteSessions(app.main, HOOKS_PROJECT)).toEqual(notes)
  })

  it('HS-B4 非法行：点它开的同样是**可编辑**笔记本（改完自动保存即重扫），解析理由在属性卡的横幅上', async () => {
    await pane.selectInvalidRow('hs-broken.md')
    expect(await pane.activeRow()).toEqual({ invalidRow: 'hs-broken.md' })
    await note.waitCard()
    // 原因在笔记里属性卡的横幅上 —— 分组里不另起原因框（行的 title 只是它的搬运）
    await until(
      async () => (await note.bannerText()).includes("missing 'shuvix-hook-agent'"),
      'card banner shows the parser verdict'
    )
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)
  })

  it('HS-B5 属性卡 hook 专属字段上屏：shuvix-hook-agent（explore）+ 埋点 id 徽章 + when 摘要', async () => {
    await pane.selectUserRow('hs-user.md')
    await note.waitCard()
    // 派发的 agent 名（mono 字段，可编辑宿主里是卡片输入框）
    await until(
      async () => (await note.fieldValue('shuvix-hook-agent')) === 'explore',
      'card shows shuvix-hook-agent'
    )
    // shuvix-hook-on 的专属摘要行：每条绑定 = 埋点 id 徽章 + when 表达式（cm-shuvix-fmcard*
    // 是卡片自有钩子，稳定可内联）
    await until(
      async () =>
        (
          await app.main.eval<string[]>(
            `[...document.querySelectorAll('.cm-shuvix-fmcard-row[data-key="shuvix-hook-on"] .cm-shuvix-fmcard-trigger')]
              .map((s) => (s.textContent ?? '').trim())`
          )
        ).includes('session.turn-completed'),
      'trigger id badge on the card'
    )
    const whens = await app.main.eval<string[]>(
      `[...document.querySelectorAll('.cm-shuvix-fmcard-row[data-key="shuvix-hook-on"] .cm-shuvix-fmcard-rule-text')]
        .map((s) => (s.textContent ?? '').trim())`
    )
    expect(whens.join(' ')).toContain('event.turnCount == 1')
  })

  it('HS-B6 选中态随活动会话走：切去一条普通会话后，行选中与组头高亮都撤掉', async () => {
    await app.main.eval(`window.api.session.create({ title: 'hs-b6-normal' })`)
    const sidebar = sidebarPane(app.main)
    expect(await sidebar.openSession('hs-b6-normal')).toBe(true)
    await until(async () => (await pane.activeRow()) === null, 'no hook row active')
    expect(await pane.headerActive()).toBe(false)
  })

  it('HS-C1 组头菜单形状：new-hook / open-folder / 分隔 / refresh（open-folder 只断存在，绝不点 —— OS 文件管理器 e2e 关不掉）', async () => {
    const items = await pane.groupMenuItems()
    expect(items?.map((i) => i.id ?? i.type)).toEqual([
      'new-hook',
      'open-folder',
      'separator',
      'refresh'
    ])
  })

  it('HS-C2 组头菜单「新建 Hook」：模板落盘即可解析（explore + session.turn-completed + when turnCount == 1）；不手动刷新行自动出现（hook.changed 事件链），笔记被开成活动行', async () => {
    await pane.newHook()
    // 已有用户 hook 叫 hs-user —— 首选名 my-hook 不撞车，落盘就是 my-hook.md
    await until(() => existsSync(hookPath('my-hook.md')), 'my-hook.md written')
    const text = readFileSync(hookPath('my-hook.md'), 'utf8')
    for (const needle of [
      'shuvix-hook-agent: explore',
      'trigger: session.turn-completed',
      'when: event.turnCount == 1'
    ]) {
      expect(text).toContain(needle)
    }
    expect(
      (await listHooks()).find((h) => h.name === 'my-hook' && h.source === 'user'),
      '新建出来的模板必须过得了真解析器（hook.create 非法一律拒写）'
    ).toBeDefined()
    // 落盘广播 hook.changed —— 不必手动刷新
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'my-hook.md'),
      'new hook row listed'
    )
    await until(async () => (await pane.activeRow())?.row === 'my-hook.md', 'new hook note active')
  })

  it('HS-C3 内置行菜单只有「创建覆盖副本」一项，未被覆盖时可用', async () => {
    const items = await pane.builtinRowMenu(BUILTIN_SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override'])
    expect(items?.find((i) => i.id === 'create-override')?.enabled).not.toBe(false)
  })

  it('HS-C4 内置行菜单「创建覆盖副本」：同名用户文件逐字节等于盘上当前语言那份 md 并可解析；内置行划线带徽标（锁仍在）、覆盖入口置灰而非消失、副本笔记成活动行', async () => {
    // getSource(builtin) 的契约 = 随包目录里当前语言那份 md 的逐字原文（YAML 注释与键序
    // 原样；dev 实例即本仓 packages/agent-runtime/src/hook/builtinHooks/md/）——
    // 副本必须与它逐字节相等。basePath 是列表裁决时按同一候选序挑中的那份文件的路径
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.hook.getSource(${JSON.stringify({ name: BUILTIN_SAMPLE, source: 'builtin' })})`
    )
    expect(source.error).toBeUndefined()
    const onDisk = readFileSync((await builtinHook(BUILTIN_SAMPLE)).basePath, 'utf8')
    expect(source.text).toBe(onDisk)

    await pane.pickBuiltinRowMenu(BUILTIN_SAMPLE, 'create-override')
    await until(() => existsSync(hookPath(`${BUILTIN_SAMPLE}.md`)), 'override copy written')
    expect(readFileSync(hookPath(`${BUILTIN_SAMPLE}.md`), 'utf8')).toBe(source.text)

    // 落出来的副本过得了真解析器，且进了同名裁决
    await until(async () => {
      const hit = (await listHooks()).find((h) => h.name === BUILTIN_SAMPLE && h.source === 'user')
      return !!hit
    }, 'override copy listed as a user hook')
    const builtin = (await listHooks()).find(
      (h) => h.name === BUILTIN_SAMPLE && h.source === 'builtin'
    )!
    expect(builtin.overridden).toBe(true)
    expect(builtin.overriddenBy).toBe(`${BUILTIN_SAMPLE}.md`)

    // 锁照挂（它还是内置），划线与徽标才是「这份当前不生效」
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === BUILTIN_SAMPLE)
      return !!row && row.struck && row.badge && row.locked
    }, 'builtin row struck + badged')

    // 被遮蔽的内置不再给覆盖入口 —— 菜单项置灰而不是消失
    const items = await pane.builtinRowMenu(BUILTIN_SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override'])
    expect(items?.find((i) => i.id === 'create-override')?.enabled).toBe(false)

    await until(
      async () => (await pane.activeRow())?.row === `${BUILTIN_SAMPLE}.md`,
      'override note active'
    )
  })

  it('HS-C5 生效用户行删除：确认框文案带 displayName；确认后文件没了、内置恢复生效（无划线无徽标、锁在），list 不再带 overridden，开着的那条笔记被离开，过窗口文件没被写回', async () => {
    const userRow = (await listHooks()).find(
      (h) => h.name === BUILTIN_SAMPLE && h.source === 'user'
    )!
    await pane.pickUserRowMenu(`${BUILTIN_SAMPLE}.md`, 'delete-hook')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(userRow.displayName)
    await confirm.confirm()

    await until(() => !existsSync(hookPath(`${BUILTIN_SAMPLE}.md`)), 'override copy deleted')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === BUILTIN_SAMPLE)
      return !!row && !row.struck && !row.badge && row.locked
    }, 'builtin restored')
    expect((await pane.userRows()).some((r) => r.fileName === `${BUILTIN_SAMPLE}.md`)).toBe(false)
    const named = (await listHooks()).filter((h) => h.name === BUILTIN_SAMPLE)
    expect(named).toHaveLength(1)
    expect(named[0].overridden).toBeFalsy()
    // 删掉的正是主区开着的那份笔记 —— 留着接着打字，自动保存会把它写回来
    await until(async () => (await pane.activeRow()) === null, 'deleted note left')
    await sleep(800)
    expect(existsSync(hookPath(`${BUILTIN_SAMPLE}.md`))).toBe(false)
  })

  it('HS-D1 非法同名不遮蔽内置：name 是内置名但解析不过 → 琥珀行；内置行无划线无徽标，IPC list 仍只有内置且无 overridden（写坏一份 md 不能顶替内置 hook）', async () => {
    writeHook(`${BUILTIN_SAMPLE}.md`, badCelHook(BUILTIN_SAMPLE))
    await pane.refresh()

    await until(
      async () => (await pane.invalidRows()).some((r) => r.fileName === `${BUILTIN_SAMPLE}.md`),
      'broken auto-title.md listed as invalid'
    )
    const row = (await pane.builtinRows()).find((r) => r.name === BUILTIN_SAMPLE)!
    expect([row.struck, row.badge, row.locked]).toEqual([false, false, true])
    const named = (await listHooks()).filter((h) => h.name === BUILTIN_SAMPLE)
    expect(named).toHaveLength(1)
    expect(named[0].source).toBe('builtin')
    expect(named[0].overridden).toBeFalsy()
  })

  it('HS-D2 用户互压：twin 组两份同名 → canonical 文件名胜出，输家划线带徽标、title 点名胜者（≠ 内置那句提示）；赢家按名删、输家按文件名删', async () => {
    // `aa-shadow.md` 更短、码点序也靠前 —— 只有「文件名就是名字」这一条能让 shadow-twin.md 胜出
    writeHook('shadow-twin.md', validHook('shadow-twin', 'Shadow Twin'))
    writeHook('aa-shadow.md', validHook('shadow-twin', 'Shadow Twin (loser)'))
    await pane.refresh()

    await until(async () => {
      const rows = await pane.userRows()
      return (
        rows.some((r) => r.fileName === 'shadow-twin.md' && !r.struck) &&
        rows.some((r) => r.fileName === 'aa-shadow.md' && r.struck)
      )
    }, 'winner / loser settled')

    const rows = await pane.userRows()
    const winner = rows.find((r) => r.fileName === 'shadow-twin.md')!
    const loser = rows.find((r) => r.fileName === 'aa-shadow.md')!
    expect([winner.struck, winner.badge]).toEqual([false, false])
    expect([loser.struck, loser.badge]).toEqual([true, true])
    // 用户那句要说清是被哪一个文件压过 —— 与内置那句（hookOverriddenHint）是两个不同的原因
    expect(loser.title).toBe(en.settings.shadowedByFileHint.replace('{{file}}', 'shadow-twin.md'))
    expect(loser.title).not.toBe(en.settings.hookOverriddenHint)
    expect(loser.locked).toBe(false)

    // 按名删会删到生效的那份 —— 输掉的那份只有按文件名这一条路
    expect(await pane.userRowMenuIds('shadow-twin.md')).toEqual(['delete-hook'])
    expect(await pane.userRowMenuIds('aa-shadow.md')).toEqual(['delete-hook-file'])
  })

  it('HS-D3 遮蔽是展示态：同名裁决的全部份数始终在 IPC list 里（输家只是带 overridden 标记）', async () => {
    const named = (await listHooks()).filter((h) => h.name === 'shadow-twin')
    expect(named).toHaveLength(2)
    expect(named.every((h) => h.source === 'user')).toBe(true)
    const loser = named.find((h) => h.overridden)!
    expect(loser.overriddenBy).toBe('shadow-twin.md')
    expect(basename(loser.basePath)).toBe('aa-shadow.md')
  })

  it('HS-D4 hook 特有的非法分支上屏（各一种）：base 档案 / 裸键 / 未知前缀键，title 各带各的拒绝理由', async () => {
    writeHook(
      'hs-base-agent.md',
      md([
        'shuvix: hook v1',
        'name: hs-base-agent',
        'shuvix-hook-agent: work',
        'shuvix-hook-on:',
        '  - trigger: session.turn-completed'
      ])
    )
    writeHook(
      'hs-bare-key.md',
      md([
        'shuvix: hook v1',
        'name: hs-bare-key',
        'agent: explore',
        'shuvix-hook-on:',
        '  - trigger: session.turn-completed'
      ])
    )
    writeHook(
      'hs-unknown-key.md',
      md([
        'shuvix: hook v1',
        'name: hs-unknown-key',
        'shuvix-hook-agent: explore',
        'shuvix-hook-foo: 1',
        'shuvix-hook-on:',
        '  - trigger: session.turn-completed'
      ])
    )
    await pane.refresh()

    const invalid = await pane.invalidRows()
    const byFile = (fileName: string): string =>
      invalid.find((r) => r.fileName === fileName)?.title ?? ''
    // (a) 派发目标是不能被派发的会话基座档案（work）
    expect(byFile('hs-base-agent.md')).toContain('names a session base profile')
    // (b) 裸键不会被读 —— 要带 shuvix-hook- 前缀
    expect(byFile('hs-bare-key.md')).toContain("bare 'agent' key")
    // (c) shuvix-hook- 前缀里的生面孔
    expect(byFile('hs-unknown-key.md')).toContain("unknown key 'shuvix-hook-foo'")
    // 三份都只在琥珀行，不混进用户行
    for (const fileName of ['hs-base-agent.md', 'hs-bare-key.md', 'hs-unknown-key.md']) {
      expect((await pane.userRows()).some((r) => r.fileName === fileName)).toBe(false)
    }
  })

  it('HS-D5 未知埋点 id 不判非法：trigger 是这个版本不认识的 id → 照常进用户行，list 里 triggers 原样带回（绑定惰性化）', async () => {
    writeHook(
      'hs-future.md',
      md([
        'shuvix: hook v1',
        'name: hs-future',
        'shuvix-hook-agent: explore',
        'shuvix-hook-on:',
        '  - trigger: session.future-trigger'
      ])
    )
    await pane.refresh()

    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-future.md'),
      'hs-future.md listed as a user hook'
    )
    expect((await pane.invalidRows()).some((r) => r.fileName === 'hs-future.md')).toBe(false)
    expect((await listHooks()).find((h) => h.name === 'hs-future')?.triggers).toEqual([
      'session.future-trigger'
    ])
  })

  it('HS-D6 marker 宽容：shuvix: hook（不带 v1）照收进用户行；没有 marker 的 md 进琥珀行（missing file marker）', async () => {
    writeHook(
      'hs-legacy-marker.md',
      md([
        'shuvix: hook',
        'name: hs-legacy-marker',
        'shuvix-hook-agent: explore',
        'shuvix-hook-on:',
        '  - trigger: session.turn-completed'
      ])
    )
    writeHook(
      'hs-no-marker.md',
      md([
        'name: hs-no-marker',
        'shuvix-hook-agent: explore',
        'shuvix-hook-on:',
        '  - trigger: session.turn-completed'
      ])
    )
    await pane.refresh()

    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-legacy-marker.md'),
      'hs-legacy-marker.md listed as a user hook'
    )
    const invalid = await pane.invalidRows()
    expect(invalid.some((r) => r.fileName === 'hs-legacy-marker.md')).toBe(false)
    expect(invalid.find((r) => r.fileName === 'hs-no-marker.md')?.title).toContain(
      'missing file marker'
    )
  })

  it('HS-C7 确认框取消：文件还在、列表不变（输家行仍划线带徽标）', async () => {
    await pane.pickUserRowMenu('aa-shadow.md', 'delete-hook-file')
    await confirm.waitOpen()
    // 按文件名删的确认框说清删的是哪份文件
    expect((await confirm.snapshot()).description).toContain('aa-shadow.md')
    await confirm.cancel()
    await confirm.waitClosed()

    expect(existsSync(hookPath('aa-shadow.md'))).toBe(true)
    const loser = (await pane.userRows()).find((r) => r.fileName === 'aa-shadow.md')!
    expect([loser.struck, loser.badge]).toEqual([true, true])
  })

  it('HS-C6 遮蔽 / 非法行删除：菜单只有 delete-hook-file、确认框文案带文件名；确认后该文件没了、生效的那份（用户赢家 / 同名内置）原样', async () => {
    // ① 同名里输掉的用户文件
    await pane.pickUserRowMenu('aa-shadow.md', 'delete-hook-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('aa-shadow.md')
    await confirm.confirm()
    await until(() => !existsSync(hookPath('aa-shadow.md')), 'aa-shadow.md deleted')
    await until(async () => {
      const row = (await pane.userRows()).find((r) => r.fileName === 'shadow-twin.md')
      return !!row && !row.struck && !row.badge
    }, 'winner untouched')
    // 遮蔽随之解除：list 回到一份、不再带 overridden
    const named = (await listHooks()).filter((h) => h.name === 'shadow-twin')
    expect(named).toHaveLength(1)
    expect(named[0].overridden).toBeFalsy()

    // ② 非法文件（HS-D1 种下的那份同名内置的坏文件）—— 删掉后内置照常生效
    await pane.pickInvalidRowMenu(`${BUILTIN_SAMPLE}.md`, 'delete-hook-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(`${BUILTIN_SAMPLE}.md`)
    await confirm.confirm()
    await until(() => !existsSync(hookPath(`${BUILTIN_SAMPLE}.md`)), 'auto-title.md deleted')
    await until(
      async () => !(await pane.invalidRows()).some((r) => r.fileName === `${BUILTIN_SAMPLE}.md`),
      'invalid row gone'
    )
    const row = (await pane.builtinRows()).find((r) => r.name === BUILTIN_SAMPLE)!
    expect([row.struck, row.badge, row.locked]).toEqual([false, false, true])
  })

  it('HS-E1 经宿主落盘自动重扫：noteWrite 改 name/displayName 行标签跟上；写坏翻琥珀行（会话 id 不变）；写回翻回来（三次写串行）', async () => {
    const noteSessionOf = async (): Promise<string[]> =>
      (await registryNoteSessions(app.main, HOOKS_PROJECT))
        .filter((n) => n.notebookPath === 'hs-user.md')
        .map((n) => n.id)
    const before = await noteSessionOf()
    expect(before).toHaveLength(1)

    // 改名（name + displayName）：身份是文件名，行标签跟上新显示名 —— 这里**不手动刷新**，
    // 等 300ms 合并窗口后的 hook.changed 自己扫
    expect(
      await noteWrite(app.main, 'hook', 'hs-user.md', validHook('hs-user-renamed', 'HS Renamed'))
    ).toEqual({ ok: true })
    await until(
      async () =>
        (await pane.userRows()).find((r) => r.fileName === 'hs-user.md')?.label === 'HS Renamed',
      'row label follows the rename'
    )
    expect(await noteSessionOf()).toEqual(before)

    // 写坏：翻成琥珀行、从用户行里消失 —— 笔记不换会话（一份文件至多一条会话才是契约）
    expect(await noteWrite(app.main, 'hook', 'hs-user.md', badCelHook('hs-user'))).toEqual({
      ok: true
    })
    await until(
      async () => (await pane.invalidRows()).some((r) => r.fileName === 'hs-user.md'),
      'hs-user.md listed as invalid'
    )
    expect((await pane.userRows()).some((r) => r.fileName === 'hs-user.md')).toBe(false)
    expect(await noteSessionOf()).toEqual(before)

    // 写回合法版：翻回用户行
    expect(
      await noteWrite(app.main, 'hook', 'hs-user.md', validHook('hs-user', 'HS User Hook'))
    ).toEqual({ ok: true })
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-user.md'),
      'hs-user.md listed as a user hook again'
    )
    expect(await noteSessionOf()).toEqual(before)
  })

  it('HS-E2 绕过宿主写盘**不**自动出现（反面断言）→ 组头菜单「刷新」后才出现', async () => {
    // 先跨过 HS-E1 最后一笔写入的合并窗口，免得迟到的 hook.changed 把这条的否定断言弄假
    await sleep(500)
    writeHook('hs-e2.md', validHook('hs-e2', 'HS E2'))
    await sleep(400)
    expect((await pane.userRows()).some((r) => r.fileName === 'hs-e2.md')).toBe(false)

    await pane.refresh()
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-e2.md'),
      'hs-e2.md listed after manual refresh'
    )
  })

  it('HS-E3 窗口聚焦重扫：外部编辑器写入（这里用写盘种子扮演）在 focus 事件后上屏', async () => {
    writeHook('hs-e3.md', validHook('hs-e3', 'HS E3'))
    expect((await pane.userRows()).some((r) => r.fileName === 'hs-e3.md')).toBe(false)
    await app.main.eval(`window.dispatchEvent(new Event('focus'))`)
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-e3.md'),
      'hs-e3.md listed after focus rescan'
    )
  })

  it('HS-E4 折叠 → 种文件 → 再展开：展开那一下触发重扫，行出现', async () => {
    await pane.collapse()
    writeHook('hs-e4.md', validHook('hs-e4', 'HS E4'))
    await pane.expand()
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'hs-e4.md'),
      'hs-e4.md listed after re-expand'
    )
  })

  it('HS-F1 载体隐身：项目列表没有 __hooks__ 也没有 __hooks_builtin__，侧栏会话列表里两种笔记都看不见（但 session.list 里它们在）', async () => {
    const notes = await registryNoteSessions(app.main, HOOKS_PROJECT)
    expect(notes.length).toBeGreaterThan(0)
    const builtinNotes = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(builtinNotes.length).toBeGreaterThan(0)

    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(HOOKS_PROJECT)
    // 第二个载体项目漏认的话，一个没人认得的项目就会冒进项目列表与日历
    expect(projectIds).not.toContain(BUILTIN_PROJECT)

    // 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'hs-f1-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('hs-f1-visible-session'),
      'control session listed in the sidebar'
    )
    const titles = await sidebar.titles()
    for (const n of [...notes, ...builtinNotes]) {
      expect(titles, n.notebookPath).not.toContain(n.title)
    }
  })

  it('HS-G1 切界面语言后点开的仍是运行时读的那一份：行标签换 zh 显示名、点行开出另一条会话绑 .zh.md，英文那条笔记原封不动', async () => {
    // 内置 hook 与策略同款「按语言分文件后缀」：切语言 = 映射到另一个文件、另一条会话
    const enRow = await builtinHook(BUILTIN_SAMPLE)
    expect(basename(enRow.basePath)).toBe(`${BUILTIN_SAMPLE}.md`)
    await pane.openBuiltin(BUILTIN_SAMPLE)
    const enNote = await openBuiltinNote(BUILTIN_SAMPLE)
    expect(enNote.notebookPath).toBe(`${BUILTIN_SAMPLE}.md`)

    await setLanguage('zh')

    // ① 运行时挑中的是 .zh.md 那一份
    const zhRow = await builtinHook(BUILTIN_SAMPLE)
    expect(basename(zhRow.basePath)).toBe(`${BUILTIN_SAMPLE}.zh.md`)
    expect(dirname(zhRow.basePath)).toBe(dirname(enRow.basePath))
    // ② 行显示名换成中文那一版（取自盘上那份 md，不在用例里抄一遍）；切语言广播了
    //    hook.changed，分组自己重扫 —— 这里不手动刷新
    const zhDisplayName = readFileSync(zhRow.basePath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('shuvix-displayName:'))!
      .slice('shuvix-displayName:'.length)
      .trim()
    expect(zhDisplayName).not.toBe(enRow.displayName)
    await until(
      async () =>
        (await pane.builtinRows()).find((r) => r.name === BUILTIN_SAMPLE)?.label === zhDisplayName,
      'builtin row relabelled in Chinese'
    )

    // ③ 点行开出的是**另一条**会话，绑的是 .zh.md
    await pane.openBuiltin(BUILTIN_SAMPLE)
    const zhNote = await openBuiltinNote(BUILTIN_SAMPLE)
    expect(zhNote.notebookPath).toBe(`${BUILTIN_SAMPLE}.zh.md`)
    expect(zhNote.id).not.toBe(enNote.id)
    // 英文那条还在、一字未改（切语言不该把存量会话改指到别的文件上）
    const sessions = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(sessions.find((s) => s.id === enNote.id)?.notebookPath).toBe(`${BUILTIN_SAMPLE}.md`)
  })

  it('HS-H1 设置页没有 Hooks tab（左栏一级导航按三语候选查）', async () => {
    const settings = await app.openSettings('general')
    const tabs = await settingsTabsPane(settings)
    const labels = await tabs.labels()
    // 对照：导航真的拉到了（当前界面语言是 zh，故按 zh 断一个恒在的 tab）
    expect(labels).toContain(zh.settings.tabGeneral)
    for (const label of [en, zh, ja].map((l) => l.sidebar.hooksGroup)) {
      expect(labels).not.toContain(label)
    }
  })
})
