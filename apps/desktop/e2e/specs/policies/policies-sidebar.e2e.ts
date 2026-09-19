/**
 * 侧栏「安全策略」分组的 UI 呈现（薄 DOM 层，经 harness/pages）—— 原「设置 → 安全策略」tab
 * 搬到前台之后的整组用例（编号 PS-*），与 agents-sidebar.e2e.ts 同一副骨架。
 *
 * 用户策略点一行**就是打开这份 md 的笔记本会话**（隐藏项目 `__policies__`，自动保存，没有保存
 * 按钮），主区就是普通笔记本；内置策略的 md **随包发布成真实文件**（运行时按当前语言现读的就是
 * 它），点行开的是那份文件的**只读**笔记本（另一个载体项目 `__policies_builtin__`：没有输入
 * 卡片、编辑器不可编辑）。「创建覆盖副本」收在**内置行的右键 / ⋮ 菜单**里，落一份同名用户文件
 * 再打开它的笔记。同名遮蔽是**展示态**：生效的那份照常，不生效的那份划线 + 「已覆盖」徽标，
 * IPC 的 list 始终列全部份数。解析不过的文件不生效也**不遮蔽内置同名策略**（安全语义核心：
 * 写坏一份 md 不能关掉内置防护），列在末尾的琥珀行里。
 *
 * 分组是懒扫的：经宿主落盘的写入（笔记本自动保存 / 新建 / 删除）经 **300ms 合并窗口**广播
 * `policy.changed` 自动重扫（registryNotes.ts 的 CHANGED_DEBOUNCE_MS；连续打字的多次落盘合并成
 * 一次）—— 所以事件链断言一律走 `until`，不数事件次数、不睡固定时长当同步点。绕过宿主直接
 * 写盘的（writeFileSync 种子）不广播，要走组头菜单的「刷新」或窗口聚焦重扫。
 *
 * ⚠️ **内置 md 是本仓的真目录**：隔离实例只换了 HOME，`getBuiltinPoliciesDir()` 的未打包分支
 * 指的仍是 `packages/agent-runtime/src/security/builtinPolicies/md`。所以这份 spec **只读它，
 * 绝不写**，也绝不写「试着往内置策略里写、断言被拒」这类用例 —— 闸门若回归，那种用例会改掉
 * 产品源码本身。PS-B2 里那条「字节与 mtime 都没变」既是断言也是护栏：任何一次意外的自动保存
 * 都在那里现形。
 *
 * ⚠️ 界面语言**显式钉死**（beforeAll 钉 en，PS-G1 再切 zh），不跟系统语言走：内置策略的显示名
 * 与「读哪一份文件」三语各一份，不钉死就只能断「是三语里的某一句」。切语言时宿主会广播
 * `policy.changed`（settingsHandlers.ts），分组自己重扫 —— 刻意不手动刷新。
 *
 * 用例间有顺序依赖：同一个主窗口一路点下去（先验懒扫与初始空态，再种子、再逐级打开笔记）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { BUILTIN_POLICY_SPECS } from '@shuvix/agent-runtime'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  confirmPane,
  policiesSidebarPane,
  registryNotePane,
  settingsTabsPane,
  sidebarPane,
  type ConfirmPane,
  type PoliciesSidebarPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  noteWrite,
  registryNoteSessions,
  waitRendererReady
} from '../../harness/seed'

const POLICIES_PROJECT = REGISTRY_NOTE_PROJECT_IDS.policy
/** 内置策略（随包发布的 md）的只读载体 —— 与用户策略分属两个项目 */
const BUILTIN_PROJECT = REGISTRY_NOTE_PROJECT_IDS.policyBuiltin
/** PS-B1/B2 点开的内置策略：整份 spec 里没人覆盖它（git-safety 归 PS-C3~C5、ask-on-database 归 PS-G1） */
const BUILTIN_SAMPLE = 'ask-on-read'
/** PS-C3~C5 覆盖 → 删除的那条内置策略 */
const OVERRIDE_SAMPLE = 'git-safety'
/** PS-G1 切语言的那条内置策略（此前从未被点开，en/zh 两条会话才能都是第一手） */
const LANG_SAMPLE = 'ask-on-database'

/** policy.list 一行的窄投影（本 spec 用到的字段） */
interface PolicyListRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  /** 这份策略的 md 真实路径：用户的在 ~/.shuvix/policies，内置的在应用包/本仓（当前语言那一版） */
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
let pane: PoliciesSidebarPane
let note: RegistryNotePane
let confirm: ConfirmPane
let policiesDir = ''

const policyPath = (fileName: string): string => join(policiesDir, fileName)
const listPolicies = (): Promise<PolicyListRow[]> => app.main.eval('window.api.policy.list()')

/** 绕过宿主直接写盘（不广播 policy.changed —— 之后要么 refresh、要么聚焦、要么断「不出现」） */
const writePolicy = (fileName: string, text: string): void => {
  mkdirSync(policiesDir, { recursive: true })
  writeFileSync(policyPath(fileName), text)
}

/** 最小合法用户策略（文件名与 frontmatter name 可以不同 —— 同名裁决要的正是这一点） */
const validPolicy = (name: string, displayName: string): string =>
  [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    `shuvix-displayName: ${displayName}`,
    `description: ${name} fixture`,
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '---',
    '',
    `Body of ${name}.`,
    ''
  ].join('\n')

/** 未知 effect → 解析器判整份非法（人读原因带「rule #0 is invalid」） */
const invalidPolicy = (name: string): string =>
  [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    'shuvix-policy-rules:',
    '  - effect: vaporize',
    '    subject.kind: [agent]',
    '---',
    '',
    'Invalid body.',
    ''
  ].join('\n')

/** 某份内置策略当前生效的那一行（随包 md 的路径就在它的 basePath 上） */
const builtinPolicy = async (name: string): Promise<PolicyListRow> =>
  (await listPolicies()).find((p) => p.name === name && p.source === 'builtin')!

/** IPC 直问宿主：这份内置策略的只读笔记本是哪一条会话（幂等，已开则复用） */
const openBuiltinNote = (name: string): Promise<BuiltinNote> =>
  app.main.eval<BuiltinNote>(
    `window.api.policy.openBuiltinNote(${JSON.stringify({ name })}).then((s) => ({
      id: s.id,
      projectId: s.projectId,
      notebookPath: (s.settings && s.settings.notebookPath) || '',
      workingDirectory: s.workingDirectory || ''
    }))`
  )

/**
 * 一份 md 正文里第一行**纯散文** —— 拿它当「读到的是盘上这一份」的特征串。
 * 标题 / 列表 / 引用的行首标记与行内的 `code`、**bold** 在 live-preview 里都会被吃掉，
 * 所以带任何 markdown 记号的行都不能拿来比对 `.cm-content` 的文字。
 */
const bodyMarkerOf = (filePath: string): string => {
  const body = readFileSync(filePath, 'utf8').split(/^---$/m).slice(2).join('---')
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !/^[#>\-*\d|]/.test(l) && !/[`*_[\]<>|]/.test(l))
  if (!line) throw new Error(`no plain-prose body line in ${filePath}`)
  return line.slice(0, 60)
}

/** 组头标签 —— 渲染进程 `t()` 出来的字，拿它当「界面语言换过去了」的判据 */
const GROUP_LABEL: Record<'en' | 'zh', string> = {
  en: en.sidebar.policiesGroup,
  zh: zh.sidebar.policiesGroup
}

/**
 * 钉住界面语言。主进程的 i18n 在这次 IPC 里就换好了（policyService 每次 list 现读），渲染进程
 * 要等 `settings.changed` 回来才换 —— 组标签是它的判据。语言变更会**广播 policy.changed**
 * （settingsHandlers.ts），分组自己重扫 —— 刻意不手动刷新，行标签跟上正是 PS-G1 要断的东西。
 */
const setLanguage = async (lang: 'en' | 'zh'): Promise<void> => {
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(lang)} })`
  )
  await until(
    async () => (await pane.label()) === GROUP_LABEL[lang],
    `policies group label in ${lang}`
  )
}

beforeAll(async () => {
  app = await launchApp()
  policiesDir = join(app.home, '.shuvix', 'policies')
  await waitRendererReady(app.main)
  pane = policiesSidebarPane(app.main)
  note = registryNotePane(app.main)
  confirm = confirmPane(app.main)
  // 隔离实例默认跟系统语言走 —— 本地化文案与「读哪一份 md」都得先钉死。
  // 刻意**不展开**：懒扫断言（PS-A2）必须抢在第一次扫描之前
  await setLanguage('en')
})
afterAll(async () => {
  await app.stop()
})

describe('侧栏安全策略分组', () => {
  it('PS-A2 懒扫：展开前分组正文一个子节点都不渲染（scanned 为 null，连空态都没有）', async () => {
    // 这条必须排第一：扫过之后折叠只是收高度（AnimatedCollapse），行仍在 DOM 里，读数不再归零
    expect(await pane.headerCount()).toBe(1)
    expect(await pane.bodyChildCount()).toBe(0)
  })

  it('PS-A1 初始列表：内置行全量置顶（条数 = BUILTIN_POLICY_SPECS 条数），全部带锁、无划线无徽标；用户 / 非法为空', async () => {
    await pane.expand()
    const builtin = await pane.builtinRows()
    expect(builtin.map((r) => r.name).sort()).toEqual(
      BUILTIN_POLICY_SPECS.map((s) => s.name).sort()
    )
    // 行首那把锁是「内置」的标记（生效与否都只能看）；此时没有任何同名覆盖
    expect(builtin.every((r) => r.locked && !r.struck && !r.badge)).toBe(true)
    expect(await pane.userRows()).toEqual([])
    expect(await pane.invalidRows()).toEqual([])
  })

  // 内置行顺序是**产品决定**：按 name 字母序（展示序管查找 —— 用户在 14 份内置策略里按名字
  // 找那一道门）。BUILTIN_POLICY_SPECS 的装配序是另一回事：它管同 tier 多规则命中时的归因
  // 优先级（winning 取先装配者），不经这个列表上屏 —— policyService.compareRows 的字典序即意图
  it('PS-A1b 内置行顺序 = 按 name 字母序（localeCompare，与 compareRows 同一比较器）', async () => {
    const builtin = await pane.builtinRows()
    expect(builtin.map((r) => r.name)).toEqual(
      BUILTIN_POLICY_SPECS.map((s) => s.name).sort((a, b) => a.localeCompare(b))
    )
  })

  it('PS-A3 三段行序：种 1 合法 + 1 非法后，DOM 行序 = 内置 → 用户 → 非法', async () => {
    // 绕过宿主直接写盘：不广播 policy.changed，靠组头菜单的「刷新」
    writePolicy('ps-user.md', validPolicy('ps-user', 'PS User Policy'))
    writePolicy('ps-broken.md', invalidPolicy('ps-broken'))
    await pane.refresh()

    expect((await pane.userRows()).map((r) => r.fileName)).toEqual(['ps-user.md'])
    expect((await pane.invalidRows()).map((r) => r.fileName)).toEqual(['ps-broken.md'])
    const kinds = await app.main.eval<string[]>(
      `[...document.querySelectorAll('[data-policy-builtin-row],[data-policy-row],[data-policy-invalid-row]')]
        .map((r) =>
          r.hasAttribute('data-policy-builtin-row')
            ? 'builtin'
            : r.hasAttribute('data-policy-row')
              ? 'user'
              : 'invalid'
        )`
    )
    // 三段各不相交地依次出现：最后一个内置 < 第一个用户 < 最后一个用户 < 第一个非法
    expect(kinds.indexOf('user')).toBeGreaterThan(kinds.lastIndexOf('builtin'))
    expect(kinds.indexOf('invalid')).toBeGreaterThan(kinds.lastIndexOf('user'))
    expect(kinds.filter((k) => k === 'builtin')).toHaveLength(BUILTIN_POLICY_SPECS.length)
  })

  it('PS-A4 非法行形态：琥珀行按文件名认、font-mono、title 带解析器的拒绝理由；不混进用户行', async () => {
    const invalid = await pane.invalidRows()
    const row = invalid.find((r) => r.fileName === 'ps-broken.md')!
    expect(row.label).toBe('ps-broken.md')
    expect(row.mono).toBe(true)
    // 未知 effect 的拒绝理由（fixture 就是冲着这个分支写的）
    expect(row.title).toContain('rule #0 is invalid')
    // 琥珀行没有锁 / 划线 / 徽标 —— 那是另外两种行的语汇
    expect([row.locked, row.struck, row.badge]).toEqual([false, false, false])
    expect((await pane.userRows()).some((r) => r.fileName === 'ps-broken.md')).toBe(false)
  })

  it('PS-B1 内置行：点它开的是**随包那份 md** 的只读笔记本（另一个载体项目、正文来自盘上同一路径、没有输入卡片、编辑器不可编辑）；再点复用同会话', async () => {
    const listed = await builtinPolicy(BUILTIN_SAMPLE)
    const fileName = basename(listed.basePath)
    expect(fileName, '内置行的 basePath 是空的').not.toBe('')

    await pane.openBuiltin(BUILTIN_SAMPLE)
    expect(await pane.activeRow()).toEqual({ builtinRow: BUILTIN_SAMPLE })

    // ① IPC 先行：会话挂在只读载体下，notebookPath 正是运行时挑中的那份文件（en 已钉死）
    const opened = await openBuiltinNote(BUILTIN_SAMPLE)
    expect(opened.projectId).toBe(BUILTIN_PROJECT)
    expect(opened.notebookPath).toBe(`${BUILTIN_SAMPLE}.md`)
    expect(opened.notebookPath).toBe(fileName)
    // ② 载体的工作目录是内置目录本身，与用户策略那一份泾渭分明
    expect(opened.workingDirectory).toBe(dirname(listed.basePath))
    expect(opened.workingDirectory).not.toBe(policiesDir)

    // ③ 正文来自盘上同一路径 —— 「跑的和看的是同一份文件」
    await note.waitBody(bodyMarkerOf(listed.basePath))

    // ④ 只读：没有悬浮输入卡、编辑器 contenteditable 为 false（对照组在 PS-B3）
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
   * 挡住按键的是 `contenteditable="false"`（PS-B1 ④ 断的就是那个开关，并在 PS-B3 自带可写
   * 对照组）；这一条守的是另一半：**挂载 / 失焦都不会触发一次自动保存**。
   */
  it('PS-B2 只读笔记一个字节都不写盘：跨过自动保存防抖与 300ms 合并窗口后，字节与 mtime 都没变', async () => {
    const filePath = (await builtinPolicy(BUILTIN_SAMPLE)).basePath
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

  it('PS-B3 用户策略行：点它打开这份文件的笔记本（可编辑、有输入卡），一份文件只一条会话，活动行 + 组头高亮', async () => {
    await pane.selectUserRow('ps-user.md')
    expect(await pane.activeRow()).toEqual({ row: 'ps-user.md' })
    expect(await pane.headerActive()).toBe(true)
    await note.waitCard()

    // PS-B1 ④ 的对照组：同两个读数在可写笔记本上必须回 true，否则那两条就是空转
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)

    const notes = await registryNoteSessions(app.main, POLICIES_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'ps-user.md')).toHaveLength(1)
    // 再点一次复用，不另开
    await pane.selectUserRow('ps-user.md')
    expect(await registryNoteSessions(app.main, POLICIES_PROJECT)).toEqual(notes)
  })

  it('PS-B4 非法行：点它开的同样是**可编辑**笔记本（改完自动保存即重扫），解析理由在属性卡的横幅上', async () => {
    await pane.selectInvalidRow('ps-broken.md')
    expect(await pane.activeRow()).toEqual({ invalidRow: 'ps-broken.md' })
    await note.waitCard()
    // 原因在笔记里属性卡的横幅上 —— 分组里不另起原因框（行的 title 只是它的搬运）
    await until(
      async () => (await note.bannerText()).includes('rule #0 is invalid'),
      'card banner shows the parser verdict'
    )
    expect(await note.hasInputCard()).toBe(true)
    expect(await note.editorEditable()).toBe(true)
  })

  it('PS-B5 选中态随活动会话走：切去一条普通会话后，行选中与组头高亮都撤掉', async () => {
    await app.main.eval(`window.api.session.create({ title: 'ps-b5-normal' })`)
    const sidebar = sidebarPane(app.main)
    expect(await sidebar.openSession('ps-b5-normal')).toBe(true)
    await until(async () => (await pane.activeRow()) === null, 'no policy row active')
    expect(await pane.headerActive()).toBe(false)
  })

  it('PS-C1 组头菜单形状：new-policy / open-folder / 分隔 / refresh（open-folder 只断存在，绝不点 —— OS 文件管理器 e2e 关不掉）', async () => {
    const items = await pane.groupMenuItems()
    expect(items?.map((i) => i.id ?? i.type)).toEqual([
      'new-policy',
      'open-folder',
      'separator',
      'refresh'
    ])
  })

  it('PS-C2 组头菜单「新建策略」：模板落盘即可解析、名字避开已有策略；不手动刷新行自动出现（policy.changed 事件链），笔记被开成活动行', async () => {
    await pane.newPolicy()
    // 已有用户策略叫 ps-user —— 首选名 my-policy 不撞车，落盘就是 my-policy.md
    await until(() => existsSync(policyPath('my-policy.md')), 'my-policy.md written')
    expect(
      (await listPolicies()).find((p) => p.name === 'my-policy' && p.source === 'user'),
      '新建出来的模板必须过得了真解析器（policy.create 非法一律拒写）'
    ).toBeDefined()
    // 落盘广播 policy.changed —— 不必手动刷新
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'my-policy.md'),
      'new policy row listed'
    )
    await until(
      async () => (await pane.activeRow())?.row === 'my-policy.md',
      'new policy note active'
    )
  })

  it('PS-C3 内置行菜单只有「创建覆盖副本」一项，未被覆盖时可用', async () => {
    const items = await pane.builtinRowMenu(OVERRIDE_SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override'])
    expect(items?.find((i) => i.id === 'create-override')?.enabled).not.toBe(false)
  })

  it('PS-C4 内置行菜单「创建覆盖副本」：同名用户文件逐字节等于盘上当前语言那份 md 并可解析；内置行划线带徽标（锁仍在）、覆盖入口置灰而非消失、副本笔记成活动行', async () => {
    // getSource(builtin) 的契约 = 随包目录里当前语言那份 md 的逐字原文（YAML 注释与键序
    // 原样；dev 实例即本仓 packages/agent-runtime/src/security/builtinPolicies/md/）——
    // 副本必须与它逐字节相等。basePath 是列表裁决时按同一候选序挑中的那份文件的路径
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.policy.getSource(${JSON.stringify({ name: OVERRIDE_SAMPLE, source: 'builtin' })})`
    )
    expect(source.error).toBeUndefined()
    const onDisk = readFileSync((await builtinPolicy(OVERRIDE_SAMPLE)).basePath, 'utf8')
    expect(source.text).toBe(onDisk)

    await pane.pickBuiltinRowMenu(OVERRIDE_SAMPLE, 'create-override')
    await until(() => existsSync(policyPath(`${OVERRIDE_SAMPLE}.md`)), 'override copy written')
    expect(readFileSync(policyPath(`${OVERRIDE_SAMPLE}.md`), 'utf8')).toBe(source.text)

    // 落出来的副本过得了真解析器，且进了同名裁决
    await until(async () => {
      const hit = (await listPolicies()).find(
        (p) => p.name === OVERRIDE_SAMPLE && p.source === 'user'
      )
      return !!hit
    }, 'override copy listed as a user policy')
    const builtin = (await listPolicies()).find(
      (p) => p.name === OVERRIDE_SAMPLE && p.source === 'builtin'
    )!
    expect(builtin.overridden).toBe(true)
    expect(builtin.overriddenBy).toBe(`${OVERRIDE_SAMPLE}.md`)

    // 锁照挂（它还是内置），划线与徽标才是「这份当前不生效」
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === OVERRIDE_SAMPLE)
      return !!row && row.struck && row.badge && row.locked
    }, 'builtin row struck + badged')

    // 被遮蔽的内置不再给覆盖入口 —— 菜单项置灰而不是消失
    const items = await pane.builtinRowMenu(OVERRIDE_SAMPLE)
    expect(items?.map((i) => i.id)).toEqual(['create-override'])
    expect(items?.find((i) => i.id === 'create-override')?.enabled).toBe(false)

    await until(
      async () => (await pane.activeRow())?.row === `${OVERRIDE_SAMPLE}.md`,
      'override note active'
    )
  })

  it('PS-C5 生效用户行删除：确认框文案带 displayName；确认后文件没了、内置恢复生效（无划线无徽标、锁在），开着的那条笔记被离开，过窗口文件没被写回', async () => {
    const userRow = (await listPolicies()).find(
      (p) => p.name === OVERRIDE_SAMPLE && p.source === 'user'
    )!
    await pane.pickUserRowMenu(`${OVERRIDE_SAMPLE}.md`, 'delete-policy')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain(userRow.displayName)
    await confirm.confirm()

    await until(() => !existsSync(policyPath(`${OVERRIDE_SAMPLE}.md`)), 'override copy deleted')
    await until(async () => {
      const row = (await pane.builtinRows()).find((r) => r.name === OVERRIDE_SAMPLE)
      return !!row && !row.struck && !row.badge && row.locked
    }, 'builtin restored')
    expect((await pane.userRows()).some((r) => r.fileName === `${OVERRIDE_SAMPLE}.md`)).toBe(false)
    // 删掉的正是主区开着的那份笔记 —— 留着接着打字，自动保存会把它写回来
    await until(async () => (await pane.activeRow()) === null, 'deleted note left')
    await sleep(800)
    expect(existsSync(policyPath(`${OVERRIDE_SAMPLE}.md`))).toBe(false)
  })

  it('PS-D1 非法同名不遮蔽内置：name 是内置名但解析不过 → 琥珀行；内置行无划线无徽标，IPC list 仍只有内置且无 overridden（写坏一份 md 不能关掉内置防护）', async () => {
    writePolicy('ask-on-write.md', invalidPolicy('ask-on-write'))
    await pane.refresh()

    await until(
      async () => (await pane.invalidRows()).some((r) => r.fileName === 'ask-on-write.md'),
      'broken ask-on-write.md listed as invalid'
    )
    const row = (await pane.builtinRows()).find((r) => r.name === 'ask-on-write')!
    expect([row.struck, row.badge, row.locked]).toEqual([false, false, true])
    const named = (await listPolicies()).filter((p) => p.name === 'ask-on-write')
    expect(named).toHaveLength(1)
    expect(named[0].source).toBe('builtin')
    expect(named[0].overridden).toBeFalsy()
  })

  it('PS-D2 用户互压：twin 组两份同名 → canonical 文件名胜出，输家划线带徽标、title 点名胜者（≠ 内置那句提示）；赢家按名删、输家按文件名删', async () => {
    // `aa-shadow.md` 更短、码点序也靠前 —— 只有「文件名就是名字」这一条能让 shadow-twin.md 胜出
    writePolicy('shadow-twin.md', validPolicy('shadow-twin', 'Shadow Twin'))
    writePolicy('aa-shadow.md', validPolicy('shadow-twin', 'Shadow Twin (loser)'))
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
    // 用户那句要说清是被哪一个文件压过 —— 与内置那句（policyOverriddenHint）是两个不同的原因
    expect(loser.title).toBe(en.settings.shadowedByFileHint.replace('{{file}}', 'shadow-twin.md'))
    expect(loser.title).not.toBe(en.settings.policyOverriddenHint)
    expect(loser.locked).toBe(false)

    // 按名删会删到生效的那份 —— 输掉的那份只有按文件名这一条路
    expect(await pane.userRowMenuIds('shadow-twin.md')).toEqual(['delete-policy'])
    expect(await pane.userRowMenuIds('aa-shadow.md')).toEqual(['delete-policy-file'])
  })

  it('PS-D3 遮蔽是展示态：同名裁决的全部份数始终在 IPC list 里（输家只是带 overridden 标记）', async () => {
    const named = (await listPolicies()).filter((p) => p.name === 'shadow-twin')
    expect(named).toHaveLength(2)
    expect(named.every((p) => p.source === 'user')).toBe(true)
    const loser = named.find((p) => p.overridden)!
    expect(loser.overriddenBy).toBe('shadow-twin.md')
    expect(basename(loser.basePath)).toBe('aa-shadow.md')
  })

  it('PS-C7 确认框取消：文件还在、列表不变（输家行仍划线带徽标）', async () => {
    await pane.pickUserRowMenu('aa-shadow.md', 'delete-policy-file')
    await confirm.waitOpen()
    // 按文件名删的确认框说清删的是哪份文件
    expect((await confirm.snapshot()).description).toContain('aa-shadow.md')
    await confirm.cancel()
    await confirm.waitClosed()

    expect(existsSync(policyPath('aa-shadow.md'))).toBe(true)
    const loser = (await pane.userRows()).find((r) => r.fileName === 'aa-shadow.md')!
    expect([loser.struck, loser.badge]).toEqual([true, true])
  })

  it('PS-C6 遮蔽 / 非法行删除：菜单只有 delete-policy-file、确认框文案带文件名；确认后该文件没了、生效的那份（用户赢家 / 同名内置）原样', async () => {
    // ① 同名里输掉的用户文件
    await pane.pickUserRowMenu('aa-shadow.md', 'delete-policy-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('aa-shadow.md')
    await confirm.confirm()
    await until(() => !existsSync(policyPath('aa-shadow.md')), 'aa-shadow.md deleted')
    await until(async () => {
      const row = (await pane.userRows()).find((r) => r.fileName === 'shadow-twin.md')
      return !!row && !row.struck && !row.badge
    }, 'winner untouched')
    // 遮蔽随之解除：list 回到一份、不再带 overridden
    const named = (await listPolicies()).filter((p) => p.name === 'shadow-twin')
    expect(named).toHaveLength(1)
    expect(named[0].overridden).toBeFalsy()

    // ② 非法文件（PS-D1 种下的那份同名内置的坏文件）—— 删掉后内置照常生效
    await pane.pickInvalidRowMenu('ask-on-write.md', 'delete-policy-file')
    await confirm.waitOpen()
    expect((await confirm.snapshot()).description).toContain('ask-on-write.md')
    await confirm.confirm()
    await until(() => !existsSync(policyPath('ask-on-write.md')), 'ask-on-write.md deleted')
    await until(
      async () => !(await pane.invalidRows()).some((r) => r.fileName === 'ask-on-write.md'),
      'invalid row gone'
    )
    const row = (await pane.builtinRows()).find((r) => r.name === 'ask-on-write')!
    expect([row.struck, row.badge, row.locked]).toEqual([false, false, true])
  })

  it('PS-E1 经宿主落盘自动重扫：noteWrite 改 name/displayName 行标签跟上；写坏翻琥珀行（会话 id 不变）；写回翻回来', async () => {
    const noteSessionOf = async (): Promise<string[]> =>
      (await registryNoteSessions(app.main, POLICIES_PROJECT))
        .filter((n) => n.notebookPath === 'ps-user.md')
        .map((n) => n.id)
    const before = await noteSessionOf()
    expect(before).toHaveLength(1)

    // 改名（name + displayName）：身份是文件名，行标签跟上新显示名 —— 这里**不手动刷新**，
    // 等 300ms 合并窗口后的 policy.changed 自己扫
    expect(
      await noteWrite(
        app.main,
        'policy',
        'ps-user.md',
        validPolicy('ps-user-renamed', 'PS User Renamed')
      )
    ).toEqual({ ok: true })
    await until(
      async () =>
        (await pane.userRows()).find((r) => r.fileName === 'ps-user.md')?.label ===
        'PS User Renamed',
      'row label follows the rename'
    )
    expect(await noteSessionOf()).toEqual(before)

    // 写坏：翻成琥珀行、从用户行里消失 —— 笔记不换会话（一份文件至多一条会话才是契约）
    expect(await noteWrite(app.main, 'policy', 'ps-user.md', invalidPolicy('ps-user'))).toEqual({
      ok: true
    })
    await until(
      async () => (await pane.invalidRows()).some((r) => r.fileName === 'ps-user.md'),
      'ps-user.md listed as invalid'
    )
    expect((await pane.userRows()).some((r) => r.fileName === 'ps-user.md')).toBe(false)
    expect(await noteSessionOf()).toEqual(before)

    // 写回合法版：翻回用户行
    expect(
      await noteWrite(app.main, 'policy', 'ps-user.md', validPolicy('ps-user', 'PS User Policy'))
    ).toEqual({ ok: true })
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'ps-user.md'),
      'ps-user.md listed as a user policy again'
    )
    expect(await noteSessionOf()).toEqual(before)
  })

  it('PS-E2 绕过宿主写盘**不**自动出现（反面断言）→ 组头菜单「刷新」后才出现', async () => {
    // 先跨过 PS-E1 最后一笔写入的合并窗口，免得迟到的 policy.changed 把这条的否定断言弄假
    await sleep(500)
    writePolicy('ps-e2.md', validPolicy('ps-e2', 'PS E2'))
    await sleep(400)
    expect((await pane.userRows()).some((r) => r.fileName === 'ps-e2.md')).toBe(false)

    await pane.refresh()
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'ps-e2.md'),
      'ps-e2.md listed after manual refresh'
    )
  })

  it('PS-E3 窗口聚焦重扫：外部编辑器写入（这里用写盘种子扮演）在 focus 事件后上屏', async () => {
    writePolicy('ps-e3.md', validPolicy('ps-e3', 'PS E3'))
    expect((await pane.userRows()).some((r) => r.fileName === 'ps-e3.md')).toBe(false)
    await app.main.eval(`window.dispatchEvent(new Event('focus'))`)
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'ps-e3.md'),
      'ps-e3.md listed after focus rescan'
    )
  })

  it('PS-E4 折叠 → 种文件 → 再展开：展开那一下触发重扫，行出现', async () => {
    await pane.collapse()
    writePolicy('ps-e4.md', validPolicy('ps-e4', 'PS E4'))
    await pane.expand()
    await until(
      async () => (await pane.userRows()).some((r) => r.fileName === 'ps-e4.md'),
      'ps-e4.md listed after re-expand'
    )
  })

  it('PS-F1 载体隐身：项目列表没有 __policies__ 也没有 __policies_builtin__，侧栏会话列表里两种笔记都看不见（但 session.list 里它们在）', async () => {
    const notes = await registryNoteSessions(app.main, POLICIES_PROJECT)
    expect(notes.length).toBeGreaterThan(0)
    const builtinNotes = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(builtinNotes.length).toBeGreaterThan(0)

    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(POLICIES_PROJECT)
    // 第二个载体项目是这一版新加的 —— 漏认它，一个没人认得的项目就会冒进项目列表与日历
    expect(projectIds).not.toContain(BUILTIN_PROJECT)

    // 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'ps-f1-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('ps-f1-visible-session'),
      'control session listed in the sidebar'
    )
    const titles = await sidebar.titles()
    for (const n of [...notes, ...builtinNotes]) {
      expect(titles, n.notebookPath).not.toContain(n.title)
    }
  })

  it('PS-G1 切界面语言后点开的仍是运行时读的那一份：行标签换 zh 显示名、点行开出另一条会话绑 .zh.md，英文那条笔记原封不动', async () => {
    // 策略与档案同款「按语言分文件后缀」：切语言 = 映射到另一个文件、另一条会话
    const enRow = await builtinPolicy(LANG_SAMPLE)
    expect(basename(enRow.basePath)).toBe(`${LANG_SAMPLE}.md`)
    await pane.openBuiltin(LANG_SAMPLE)
    const enNote = await openBuiltinNote(LANG_SAMPLE)
    expect(enNote.notebookPath).toBe(`${LANG_SAMPLE}.md`)

    await setLanguage('zh')

    // ① 运行时挑中的是 .zh.md 那一份
    const zhRow = await builtinPolicy(LANG_SAMPLE)
    expect(basename(zhRow.basePath)).toBe(`${LANG_SAMPLE}.zh.md`)
    expect(dirname(zhRow.basePath)).toBe(dirname(enRow.basePath))
    // ② 行显示名换成中文那一版（取自盘上那份 md，不在用例里抄一遍）；切语言广播了
    //    policy.changed，分组自己重扫 —— 这里不手动刷新
    const zhDisplayName = readFileSync(zhRow.basePath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('shuvix-displayName:'))!
      .slice('shuvix-displayName:'.length)
      .trim()
    expect(zhDisplayName).not.toBe(enRow.displayName)
    await until(
      async () =>
        (await pane.builtinRows()).find((r) => r.name === LANG_SAMPLE)?.label === zhDisplayName,
      'builtin row relabelled in Chinese'
    )

    // ③ 点行开出的是**另一条**会话，绑的是 .zh.md
    await pane.openBuiltin(LANG_SAMPLE)
    const zhNote = await openBuiltinNote(LANG_SAMPLE)
    expect(zhNote.notebookPath).toBe(`${LANG_SAMPLE}.zh.md`)
    expect(zhNote.id).not.toBe(enNote.id)
    // 英文那条还在、一字未改（切语言不该把存量会话改指到别的文件上）
    const sessions = await registryNoteSessions(app.main, BUILTIN_PROJECT)
    expect(sessions.find((s) => s.id === enNote.id)?.notebookPath).toBe(`${LANG_SAMPLE}.md`)
  })

  it('PS-H1 设置页没有策略 tab（左栏一级导航按三语候选查）', async () => {
    const settings = await app.openSettings('general')
    const tabs = await settingsTabsPane(settings)
    const labels = await tabs.labels()
    // 对照：导航真的拉到了（当前界面语言是 zh，故按三语候选断一个恒在的 tab）
    expect(labels).toContain(zh.settings.tabGeneral)
    for (const label of [en, zh, ja].map((l) => l.sidebar.policiesGroup)) {
      expect(labels).not.toContain(label)
    }
  })

  it('PS-H2 侧栏置顶分组顺序 = bots → agents → skills → knowledge → policies', async () => {
    const order = await app.main.eval<string[]>(
      `[...document.querySelectorAll('div[class*="group/header"]')]
        .map((h) => h.getAttribute('data-group'))
        .filter((g) => ['bots', 'agents', 'skills', 'knowledge', 'policies'].includes(g))`
    )
    expect(order).toEqual(['bots', 'agents', 'skills', 'knowledge', 'policies'])
  })
})
