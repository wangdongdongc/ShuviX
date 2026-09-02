/**
 * frontmatter 属性卡的**字段交互**（app-shell notebook/frontmatterCard.ts +
 * FrontmatterFieldPicker.tsx）。卡片的渲染/校验语义在 frontmatter-card.e2e.ts，
 * 这里只管「槽位能不能编辑 / 编辑后写回了什么」这一条链路：
 *
 *   - 开槽判定（A 组）：可编辑仅在「非只读 + 宿主给了 mountField + 值是单行简单标量」
 *     三者同时成立时；块标量续行 / 行尾注释 / YAML 数组值一律退回只读，**逐字段**判定
 *     （同一份文件里一个字段只读、另一个照常开槽）。缺键与空值（YAML null）在解析契约里
 *     与「不声明」等价，故同样开槽 —— 否则留空的字段在 GUI 里再也改不回来。
 *   - 工具字段（B 组）：弹层 portal 到 body（卡片盒子 overflow-hidden，absolute 会被裁）、
 *     候选项 = tools.list() ∪ 合成的 agent、**关闭时一次性写回**（开合期间只改草稿，
 *     故连勾多项弹层不会消失），写回走行级 scoped edit —— 注释/未知键/键序/正文/末尾换行
 *     全部逐字节保真，弹层里没有的条目（离线 mcp:）不被吞掉。
 *   - 模型字段（C 组）：面板只列**已启用**提供商；写出恒带 providerId 前缀；含 `: ` 的
 *     模型 id 必须加引号写出且能读回；解析不出的 ref 保留原文当占位（不静默改档案）。
 *   - 关闭语义与生命周期（D 组）、宿主差异（E 组）、零副作用（F 组）。
 *
 * 机制约定（改这份 spec 前先读）：
 *   - **绝不往 CodeMirror 里打字**：初值一律 writeFileSync 预置，交互一律 dispatchEvent；
 *   - 工具触发器监听 **mousedown**、ModelSelect 触发器监听 **click**（实测差异，见 pages.ts）；
 *   - 落盘走笔记本 200ms 防抖自动保存 → 文件断言先 until 轮询「已变化」再 toBe 全等；
 *   - 卡片就绪一律走 `card.waitReady()`：槽位里的选择器是宿主异步挂的 React 子树，
 *     光等 `.cm-shuvix-fmcard`/`.cm-shuvix-fmcard-slot` 存在就读文案会读到空串；
 *   - 写回后 widget 重建 → DOM 句柄必须重查（pages.ts 的方法每次都现查）；
 *   - 字段行按 `data-key` 定位（通用行也有），不靠 i18n 标签或描述符顺序。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import { createProject, seedCustomProvider } from '../../harness/seed'
import { agentsPane, fmCardPane, type FmCardPane } from '../../harness/pages'

let app: E2EApp
let projDir: string
let card: FmCardPane
/** 两个自定义提供商（插入即 isEnabled=1）—— AC-14 要求已启用提供商 ≥ 2，避免空转 */
let alphaId: string
let betaId: string

/** 三语兜底：卡片/选择器文案随隔离实例的系统语言变，工具名与 modelId 才是 locale-free 的 */
const UNSET_RE = /Not set|未设置|未設定/
const SELECT_MODEL_RE = /Select a model|选择模型|モデルを選択/

const md = (...lines: string[]): string => `${lines.join('\n')}\n`

// ── A 组种子 ──────────────────────────────────────────────────────────────

const A1_OPEN = md(
  '---',
  'shuvix: agent v1',
  'name: a1-open-agent',
  'description: AC-1 missing keys stay editable',
  '---',
  '',
  'A1 OPEN BODY MARKER.'
)

/** `key:`（YAML null）与缺键在解析契约里等价 —— 同样开槽，否则「留空」不可逆 */
const A1_EMPTY = md(
  '---',
  'shuvix: agent v1',
  'name: a1b-empty-agent',
  'shuvix-model:',
  'shuvix-tools:',
  '---',
  '',
  'A1B EMPTY BODY MARKER.'
)

/** 两种退回只读同处一文件：YAML 数组值（形状不符）/ 行尾注释（改值段会吞注释） */
const A2_READONLY = md(
  '---',
  'shuvix: agent v1',
  'name: a2-readonly-agent',
  'shuvix-tools: [read, grep]',
  'shuvix-model: openai/gpt-4o  # 行尾注释：改值段会连它一起吞掉',
  '---',
  '',
  'A2 READONLY BODY MARKER.'
)

/** 逐字段判定：块标量续行的 tools 只读（仍渲染 chips），缺键的 model 照常开槽 */
const A3_MIXED = md(
  '---',
  'shuvix: agent v1',
  'name: a3-mixed-agent',
  'shuvix-tools: >-',
  '  bash,',
  '  read',
  '---',
  '',
  'A3 MIXED BODY MARKER.'
)

/** YAML 语法错（未闭合流序列）：标记仍可正则读出 → 卡片上屏，但字段区整体留空 */
const A4_BAD_YAML = md(
  '---',
  'shuvix: agent v1',
  'name: a4-badyaml-agent',
  'broken: [unclosed',
  '---',
  '',
  'A4 BADYAML BODY MARKER.'
)

// ── B 组种子（工具字段）────────────────────────────────────────────────────

/** 注释 / 未知键 / 非规范键序 —— 写回的字节级保真断言全靠它们 */
const bTools = (toolsValue: string): string =>
  md(
    '---',
    'shuvix: agent v1',
    '# 注释：写回只动值段，本行必须原样保留',
    'name: b-tools-agent',
    `shuvix-tools: ${toolsValue}`,
    'description: AC-5..AC-13 tools field',
    'shuvix-builtin: true',
    '---',
    '',
    'B TOOLS BODY MARKER.'
  )

const bEmpty = (toolsLine: string[]): string =>
  md(
    '---',
    'shuvix: agent v1',
    'name: b-empty-agent',
    ...toolsLine,
    'description: AC-9 delete to empty',
    '---',
    '',
    'B EMPTY BODY MARKER.'
  )

const bNoKey = (toolsLine: string[]): string =>
  md(
    '---',
    'shuvix: agent v1',
    'name: b-nokey-agent',
    'description: AC-10 insert before the closing line',
    ...toolsLine,
    '---',
    '',
    'B NOKEY BODY MARKER.'
  )

const bGhost = (toolsValue: string): string =>
  md(
    '---',
    'shuvix: agent v1',
    'name: b-ghost-agent',
    `shuvix-tools: ${toolsValue}`,
    'description: AC-11 entries absent from the panel survive',
    '---',
    '',
    'B GHOST BODY MARKER.'
  )

// ── C 组种子（模型字段）────────────────────────────────────────────────────

const cModel = (modelLine: string[]): string =>
  md(
    '---',
    'shuvix: agent v1',
    'name: c-model-agent',
    'description: AC-14/15/17 model field',
    ...modelLine,
    '---',
    '',
    'C MODEL BODY MARKER.'
  )

const cDanger = (modelLine: string[]): string =>
  md(
    '---',
    'shuvix: agent v1',
    'name: c-danger-agent',
    'description: AC-16 risky model id',
    ...modelLine,
    '---',
    '',
    'C DANGER BODY MARKER.'
  )

/** 解析不出的 ref（提供商停用/模型已删）：占位退回原文，且绝不静默改盘 */
const C_UNRESOLVED = md(
  '---',
  'shuvix: agent v1',
  'name: c-unresolved-agent',
  'shuvix-model: openai/does-not-exist',
  'description: AC-18 unresolvable ref keeps its raw text',
  '---',
  '',
  'C UNRESOLVED BODY MARKER.'
)

// ── D / E / F 组种子 ──────────────────────────────────────────────────────

const D_CLOSE = md(
  '---',
  'shuvix: agent v1',
  'name: d-close-agent',
  'shuvix-tools: read',
  'description: AC-19..21 close semantics',
  '---',
  '',
  'D CLOSE BODY MARKER.'
)

/** 只读宿主的素材：不建会话，经宿主笔记本里的 [[readonly-card]] 点开右侧 Preview */
const E_READONLY_CARD = md(
  '---',
  'shuvix: agent v1',
  'name: readonly-card-agent',
  'shuvix-tools: bash, read',
  'shuvix-instruction-files: AGENTS.md',
  'description: AC-22 read-only host',
  '---',
  '',
  'READONLY CARD BODY MARKER.'
)

/** 宿主笔记本自身**不带 frontmatter** —— 保证 DOM 里同时只有预览那一张卡 */
const E_HOST = md('# AC-22 host', '', 'E HOST BODY MARKER', '', '[[readonly-card]]')

/** CRLF 文件：CM6 载入即按 /\r\n?|\n/ 切行，任何一次写回都会把整份归一为 LF */
const F_CRLF = [
  '---',
  'shuvix: agent v1',
  'name: f-crlf-agent',
  'shuvix-tools: read',
  'description: AC-25 CRLF normalization',
  '---',
  '',
  'F CRLF BODY MARKER.',
  ''
].join('\r\n')

interface NotebookSeed {
  /** 项目内文件名 */
  file: string
  /** 会话标题（侧栏点击定位用；刻意不用 basename，避免与正文/顶栏里的文件名撞车） */
  title: string
  content: string
  /** 正文特征串 —— 切换会话后等它上屏，不能只等 .cm-shuvix-fmcard 存在 */
  marker: string
}

const NOTEBOOKS: NotebookSeed[] = [
  { file: 'a1-open.md', title: 'NB-a1-open', content: A1_OPEN, marker: 'A1 OPEN BODY MARKER.' },
  {
    file: 'a1b-empty.md',
    title: 'NB-a1b-empty',
    content: A1_EMPTY,
    marker: 'A1B EMPTY BODY MARKER.'
  },
  {
    file: 'a2-readonly.md',
    title: 'NB-a2-readonly',
    content: A2_READONLY,
    marker: 'A2 READONLY BODY MARKER.'
  },
  { file: 'a3-mixed.md', title: 'NB-a3-mixed', content: A3_MIXED, marker: 'A3 MIXED BODY MARKER.' },
  {
    file: 'a4-badyaml.md',
    title: 'NB-a4-badyaml',
    content: A4_BAD_YAML,
    marker: 'A4 BADYAML BODY MARKER.'
  },
  {
    file: 'b-tools.md',
    title: 'NB-b-tools',
    content: bTools('bash,read'),
    marker: 'B TOOLS BODY MARKER.'
  },
  {
    file: 'b-empty.md',
    title: 'NB-b-empty',
    content: bEmpty(['shuvix-tools: read']),
    marker: 'B EMPTY BODY MARKER.'
  },
  { file: 'b-nokey.md', title: 'NB-b-nokey', content: bNoKey([]), marker: 'B NOKEY BODY MARKER.' },
  {
    file: 'b-ghost.md',
    title: 'NB-b-ghost',
    content: bGhost('mcp:ghost, read'),
    marker: 'B GHOST BODY MARKER.'
  },
  { file: 'c-model.md', title: 'NB-c-model', content: cModel([]), marker: 'C MODEL BODY MARKER.' },
  {
    file: 'c-danger.md',
    title: 'NB-c-danger',
    content: cDanger([]),
    marker: 'C DANGER BODY MARKER.'
  },
  {
    file: 'c-unresolved.md',
    title: 'NB-c-unresolved',
    content: C_UNRESOLVED,
    marker: 'C UNRESOLVED BODY MARKER.'
  },
  { file: 'd-close.md', title: 'NB-d-close', content: D_CLOSE, marker: 'D CLOSE BODY MARKER.' },
  { file: 'f-crlf.md', title: 'NB-f-crlf', content: F_CRLF, marker: 'F CRLF BODY MARKER.' },
  { file: 'e-host.md', title: 'NB-e-host', content: E_HOST, marker: 'E HOST BODY MARKER' }
]

const filePath = (file: string): string => join(projDir, file)
const read = (file: string): string => readFileSync(filePath(file), 'utf8')

/**
 * 侧栏会话行 → 点击。按「标题精确相等 + 落在会话行容器内」定位：只按 includes 找叶子
 * 节点会撞上顶栏的会话标题（那里同样是 `span.truncate`），点了等于没切会话。
 */
const sessionRow = (title: string): string =>
  `[...document.querySelectorAll('span.truncate')]
    .map((s) => ({ text: s.textContent.trim(), row: s.closest('div.group.relative.cursor-pointer') }))
    .filter((x) => x.row && x.text === ${JSON.stringify(title)})[0]?.row`

async function clickSession(title: string): Promise<void> {
  await until(
    () => app.main.eval<boolean>(`${sessionRow(title)} != null`),
    `session row "${title}"`
  )
  await app.main.eval(`${sessionRow(title)}.click()`)
}

/** 切到指定笔记本并等**内容特征**上屏 —— 防止断言到上一个会话残留的卡片 DOM */
async function openNotebook(seed: NotebookSeed): Promise<void> {
  await clickSession(seed.title)
  await until(
    () =>
      app.main.eval<boolean>(
        `(document.querySelector('.cm-content')?.textContent ?? '').includes(${JSON.stringify(seed.marker)})`
      ),
    `notebook "${seed.title}" loaded`
  )
}

const byFile = (file: string): NotebookSeed => NOTEBOOKS.find((n) => n.file === file)!

/** 卡片自有钩子（`.cm-shuvix-fmcard*`）的计数探针 —— 稳定，spec 内联即可 */
const count = (selector: string): Promise<number> =>
  app.main.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)

/**
 * 落盘防抖 200ms → 先等文件落定，再由调用方对全文做 toBe 全等（失败时给得出 diff）。
 * 落定 = 与旧值不同 + 非空 + **连续两次轮询读到一致**：files.write 是「先截断再写」，
 * 不加稳定性判据会偶发读到写到一半的空文件（实测过一次）。
 */
async function waitWritten(file: string, before: string): Promise<string> {
  let last = ''
  await until(() => {
    const now = read(file)
    const settled = now !== before && now !== '' && now === last
    last = now
    return settled
  }, `file rewritten: ${file}`)
  return last
}

/** 「不该写盘」的探针：跨过防抖窗口后仍逐字节相同 */
async function expectUnchanged(file: string, expected: string, waitMs = 500): Promise<void> {
  await sleep(waitMs)
  expect(read(file)).toBe(expected)
}

/** 弹层里 mcp:/skill: 条目显示的是短名（ToolSelectList 的展示规则） */
const shortToolName = (name: string): string =>
  name.startsWith('mcp:') ? name.slice(4) : name.startsWith('skill:') ? name.slice(6) : name

interface ProviderRow {
  id: string
  name: string
  displayName: string | null
  isEnabled: number
}

const listProviders = (): Promise<ProviderRow[]> => app.main.eval('window.api.provider.listAll()')
const providerLabel = (p: ProviderRow): string => p.displayName || p.name

const validateAgent = (text: string): Promise<{ status: string; messages: string[] }> =>
  app.main.eval(`window.api.shuvixMd.validate({ type: 'agent', text: ${JSON.stringify(text)} })`)

beforeAll(async () => {
  app = await launchApp()
  card = fmCardPane(app.main)

  projDir = join(app.home, 'proj-card-fields')
  mkdirSync(projDir, { recursive: true })
  for (const seed of NOTEBOOKS) writeFileSync(filePath(seed.file), seed.content)
  writeFileSync(filePath('readonly-card.md'), E_READONLY_CARD)

  // 模型目录：两个自定义提供商（插入即启用）+ 手动加模型（addModel 插入的即 isEnabled=1）。
  // 内置提供商种子数据是 isEnabled=0 —— AC-14 正是靠这条落差断言「面板只列已启用的」。
  alphaId = await seedCustomProvider(app.main, { name: 'E2E Alpha' })
  betaId = await seedCustomProvider(app.main, { name: 'E2E Beta' })
  await app.main.eval(
    `(async () => {
      await window.api.provider.addModel({ providerId: ${JSON.stringify(alphaId)}, modelId: 'alpha-model-1' })
      await window.api.provider.addModel({ providerId: ${JSON.stringify(alphaId)}, modelId: 'alpha-model-2' })
      await window.api.provider.addModel({ providerId: ${JSON.stringify(betaId)}, modelId: 'weird: model' })
    })()`
  )

  const project = await createProject(app.main, { name: 'CardFieldsProj', path: projDir })
  for (const seed of NOTEBOOKS) {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({
        projectId: project.id,
        notebookPath: filePath(seed.file),
        title: seed.title
      })})`
    )
  }
})
afterAll(async () => {
  await app.stop()
})

describe('A 组 · 槽位判定（可编辑 vs 退回只读）', () => {
  it('AC-1 缺键的 tools/model/instruction-files 都开槽，触发器给占位文案', async () => {
    const seed = byFile('a1-open.md')
    await openNotebook(seed)
    await card.waitReady()

    // 三个可点选字段：tools（csv）/ model（select）/ instruction-files（csv 清单）
    expect(await count('.cm-shuvix-fmcard-slot')).toBe(3)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-tools'))).toBe(true)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-model'))).toBe(true)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-instruction-files'))).toBe(true)

    // 两个占位文案刻意不同：工具用卡片的「未设置」，模型用 ModelSelect 自己的「选择模型」
    expect(await card.triggerText('shuvix-tools')).toMatch(UNSET_RE)
    expect(await card.triggerText('shuvix-model')).toMatch(SELECT_MODEL_RE)
    expect(read(seed.file)).toBe(A1_OPEN)
  })

  it('AC-1b 空值（`key:` → YAML null）与缺键等价：照常开槽', async () => {
    const seed = byFile('a1b-empty.md')
    await openNotebook(seed)
    await card.waitReady()

    // 空值若被判成「有值但不可编辑」，留空的字段在 GUI 里就再也改不回来了
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-model'))).toBe(true)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-tools'))).toBe(true)
    expect(await count('.cm-shuvix-fmcard-slot')).toBe(3)
    expect(read(seed.file)).toBe(A1_EMPTY)
  })

  it('AC-2 两种退回只读同处一文件（YAML 数组值 / 行尾注释）：两行零槽位、文件零改动', async () => {
    const seed = byFile('a2-readonly.md')
    await openNotebook(seed)
    await card.waitReady()

    // 这两行退回只读；缺键的 instruction-files 照常开槽（同 AC-1），故总数 1
    expect(await count('.cm-shuvix-fmcard-slot')).toBe(1)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-tools'))).toBe(false)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-model'))).toBe(false)
    // 只读不等于不渲染：两行都在，只是没有可编辑槽位
    expect(await app.main.eval<boolean>(rowExists('shuvix-tools'))).toBe(true)
    expect(await app.main.eval<boolean>(rowExists('shuvix-model'))).toBe(true)
    // 行尾注释那行的值段照原样显示（注释不进值）
    expect(await rowValueText('shuvix-model')).toBe('openai/gpt-4o')
    await expectUnchanged(seed.file, A2_READONLY)
  })

  it('AC-3 逐字段判定：块标量续行的 tools 只读但仍出 2 个 chip，缺键的 model 照常开槽', async () => {
    const seed = byFile('a3-mixed.md')
    await openNotebook(seed)
    await card.waitReady()

    // model + instruction-files 两个缺键字段开槽，折行的 tools 退回只读
    expect(await count('.cm-shuvix-fmcard-slot')).toBe(2)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-model'))).toBe(true)
    expect(await app.main.eval<boolean>(rowHasSlot('shuvix-tools'))).toBe(false)
    // 折行值解析出来仍是逗号串 → 只读分支照常拆 chips
    expect(
      await app.main.eval<string[]>(
        `[...document.querySelectorAll('.cm-shuvix-fmcard-chip')].map((c) => c.dataset.value)`
      )
    ).toEqual(['bash', 'read'])
    await expectUnchanged(seed.file, A3_MIXED)
  })

  it('AC-4 YAML 语法错：错误徽章上屏、无任何字段行、文件零改动', async () => {
    const seed = byFile('a4-badyaml.md')
    await openNotebook(seed)
    await card.waitReady()

    // 标记是正则读出的（不经 YAML）→ 卡片照常上屏，只是字段区整体缺席
    expect(await count('.cm-shuvix-fmcard-err')).toBe(1)
    expect(await count('.cm-shuvix-fmcard-row')).toBe(0)
    expect(await count('.cm-shuvix-fmcard-rows')).toBe(0)
    await expectUnchanged(seed.file, A4_BAD_YAML)
  })
})

describe('B 组 · 工具字段（弹层 / 候选项 / 写回）', () => {
  it('AC-5 触发器显示归一后的逗号串，磁盘原文不被顺手改写', async () => {
    const seed = byFile('b-tools.md')
    await openNotebook(seed)
    await card.waitReady()

    expect(await card.triggerText('shuvix-tools')).toBe('bash, read')
    // 显示归一 ≠ 写回：没交互就不许动盘
    expect(read(seed.file)).toBe(bTools('bash,read'))
  })

  it('AC-6 弹层 portal 到 body：不在卡片子树内、完整落在视口内、中心点可命中', async () => {
    const seed = byFile('b-tools.md')
    await card.openTools()
    const geo = await card.toolsGeometry()
    expect(geo).not.toBeNull()
    // absolute + 卡片盒子 overflow-hidden 的旧版本会在这三条上同时红
    expect(geo!.inBody).toBe(true)
    expect(geo!.insideCard).toBe(false)
    expect(geo!.withinViewport).toBe(true)
    expect(geo!.centerHitsPanel).toBe(true)
    expect(geo!.width).toBeGreaterThan(0)
    expect(geo!.height).toBeGreaterThan(0)

    await card.pressEscape()
    expect(await card.toolsOpen()).toBe(false)
    // 开合但未改草稿 → 不产生写回
    await expectUnchanged(seed.file, bTools('bash,read'))
  })

  it('AC-7 候选项 = tools.list() 的名字集合 ∪ 合成的 agent（IPC 结果本身不含 agent）', async () => {
    const ipcTools = await app.main.eval<Array<{ name: string }>>(`window.api.tools.list()`)
    // 派发工具是 hidden 的，不在聊天工具清单里 —— 但它是 shuvix-tools 的合法条目
    expect(ipcTools.some((t) => t.name === 'agent')).toBe(false)

    await card.openTools()
    const names = (await card.toolItems()).map((i) => i.name)
    expect(new Set(names)).toEqual(
      new Set([...ipcTools.map((t) => shortToolName(t.name)), 'agent'])
    )
    // 当前白名单在弹层里是勾上的
    expect(
      (await card.toolItems())
        .filter((i) => i.checked)
        .map((i) => i.name)
        .sort()
    ).toEqual(['bash', 'read'])
    await card.pressEscape()
  })

  it('AC-8 写回是行级 scoped edit：注释/未知键/键序/正文/末尾换行逐字节保真', async () => {
    const seed = byFile('b-tools.md')
    const before = read(seed.file)
    await card.openTools()
    expect(await card.clickTool('write')).toBe(true)
    await card.pressEscape()

    const after = await waitWritten(seed.file, before)
    expect(after).toBe(bTools('bash, read, write'))
    // 语义断言（与字节断言互为佐证）：解析器眼里这仍是一份合法 agent
    expect(await validateAgent(after)).toEqual({ status: 'valid', messages: [] })
    await until(
      () =>
        app.main.eval<boolean>(`document.querySelector('.cm-shuvix-fmcard-status.is-ok') !== null`),
      'revalidated (is-ok)'
    )
  })

  it('AC-13 连勾多项：弹层保持打开、期间文件不变，关闭时一次性写回', async () => {
    const seed = byFile('b-tools.md')
    const before = read(seed.file)
    await card.openTools()

    expect(await card.clickTool('edit')).toBe(true)
    expect(await card.toolsOpen()).toBe(true)
    expect(await card.clickTool('ls')).toBe(true)
    expect(await card.toolsOpen()).toBe(true)
    // 逐项写回会让 YAML 变化 → widget 重建 → 弹层消失；这里跨过防抖窗口仍必须零改动
    await expectUnchanged(seed.file, before)

    await card.pressEscape()
    expect(await card.toolsOpen()).toBe(false)
    // 一轮多选收敛成一次变更：两项同时出现
    expect(await waitWritten(seed.file, before)).toBe(bTools('bash, read, write, edit, ls'))
  })

  it('AC-12 合成的 agent 是合法值：勾上后写回、解析器判合法', async () => {
    const seed = byFile('b-tools.md')
    const before = read(seed.file)
    await card.openTools()
    expect(await card.clickTool('agent')).toBe(true)
    await card.pressEscape()

    const after = await waitWritten(seed.file, before)
    expect(after).toBe(bTools('bash, read, write, edit, ls, agent'))
    expect(await validateAgent(after)).toEqual({ status: 'valid', messages: [] })
    expect(await card.triggerText('shuvix-tools')).toBe('bash, read, write, edit, ls, agent')
  })

  it('AC-9 删到空 → 整行删除（不留 `shuvix-tools:` 空键）', async () => {
    const seed = byFile('b-empty.md')
    await openNotebook(seed)
    await card.waitReady()
    const before = read(seed.file)

    await card.openTools()
    expect(await card.clickTool('read')).toBe(true)
    await card.pressEscape()

    expect(await waitWritten(seed.file, before)).toBe(bEmpty([]))
    expect(await card.triggerText('shuvix-tools')).toMatch(UNSET_RE)
  })

  it('AC-10 键不存在 → 在闭合定界线前插一行（其余行原位不动）', async () => {
    const seed = byFile('b-nokey.md')
    await openNotebook(seed)
    await card.waitReady()
    const before = read(seed.file)

    await card.openTools()
    expect(await card.clickTool('read')).toBe(true)
    await card.pressEscape()

    expect(await waitWritten(seed.file, before)).toBe(bNoKey(['shuvix-tools: read']))
  })

  it('AC-11 弹层里没有的条目（离线 mcp:）不被吞掉，新增保序追加在末尾', async () => {
    const seed = byFile('b-ghost.md')
    await openNotebook(seed)
    await card.waitReady()
    const before = read(seed.file)

    await card.openTools()
    // 该条目在候选清单里查无此人（没有这个 MCP server）
    expect((await card.toolItems()).some((i) => i.name === 'ghost')).toBe(false)
    expect(await card.clickTool('write')).toBe(true)
    await card.pressEscape()

    expect(await waitWritten(seed.file, before)).toBe(bGhost('mcp:ghost, read, write'))
  })
})

describe('C 组 · 模型字段', () => {
  it('AC-14 面板只列已启用提供商（停用的内置提供商不成组）', async () => {
    const seed = byFile('c-model.md')
    await openNotebook(seed)
    await card.waitReady()

    // 未选态没有清除入口（槽位里只有触发器一个按钮）
    expect(await card.slotButtons('shuvix-model')).toBe(1)

    const providers = await listProviders()
    const enabled = providers.filter((p) => p.isEnabled)
    // 全量 > 已启用：否则「只列已启用」这条断言是空转的
    expect(providers.length).toBeGreaterThan(enabled.length)
    expect(enabled.length).toBeGreaterThanOrEqual(2)

    await card.openModel()
    // 目录经 providers.changed 异步刷新，等种下的提供商进面板再比集合
    await until(async () => (await card.modelGroups()).includes('E2E Alpha'), 'catalog refreshed')
    expect(new Set(await card.modelGroups())).toEqual(new Set(enabled.map(providerLabel)))

    const disabledBuiltin = providers.find((p) => !p.isEnabled)!
    expect(await card.modelGroups()).not.toContain(providerLabel(disabledBuiltin))

    await card.clickOutside()
    expect(await card.modelOpen()).toBe(false)
  })

  it('AC-15 选中写 `<providerId>/<modelId>`（恒带前缀）', async () => {
    const seed = byFile('c-model.md')
    const before = read(seed.file)
    await card.openModel()
    // 分组默认全折叠（expanded 初值只含当前选中的提供商）：先展开才有型号按钮
    await until(async () => (await card.modelGroups()).includes('E2E Alpha'), 'catalog refreshed')
    expect(await card.expandModelGroup('E2E Alpha')).toBe(true)
    expect(await card.pickModel('alpha-model-1')).toBe(true)

    expect(await waitWritten(seed.file, before)).toBe(
      cModel([`shuvix-model: ${alphaId}/alpha-model-1`])
    )
    expect(await card.triggerText('shuvix-model')).toContain('alpha-model-1')
  })

  it('AC-17 已选态出现清除入口；清除 → 整行删除', async () => {
    const seed = byFile('c-model.md')
    const before = read(seed.file)
    expect(await card.slotButtons('shuvix-model')).toBe(2)

    await card.clearModel()
    expect(await waitWritten(seed.file, before)).toBe(cModel([]))
    expect(await card.slotButtons('shuvix-model')).toBe(1)
    expect(await card.triggerText('shuvix-model')).toMatch(SELECT_MODEL_RE)
  })

  it('AC-16 含 `: ` 的模型 id 加单引号写出，且能原值读回', async () => {
    const seed = byFile('c-danger.md')
    await openNotebook(seed)
    await card.waitReady()
    const before = read(seed.file)

    await card.openModel()
    await until(async () => (await card.modelGroups()).includes('E2E Beta'), 'catalog refreshed')
    expect(await card.expandModelGroup('E2E Beta')).toBe(true)
    expect(await card.pickModel('weird: model')).toBe(true)

    // 裸拼 `key: a/weird: model` 会被 YAML 读成映射 —— 必须引号包起来
    const after = await waitWritten(seed.file, before)
    expect(after).toBe(cDanger([`shuvix-model: '${betaId}/weird: model'`]))
    expect(await validateAgent(after)).toEqual({ status: 'valid', messages: [] })
    // 读回：重建后的触发器解析出了同一条模型（引号没被当成值的一部分）
    expect(await card.triggerText('shuvix-model')).toContain('weird: model')
  })

  it('AC-18 解析不出的 ref：占位退回原始文本，且绝不静默改盘', async () => {
    const seed = byFile('c-unresolved.md')
    await openNotebook(seed)
    await card.waitReady()

    // 显示「选择模型」会让人以为没设置，一选就把档案里的值静默改掉
    const text = await card.triggerText('shuvix-model')
    expect(text).toContain('openai/does-not-exist')
    expect(text).not.toMatch(SELECT_MODEL_RE)
    // 未解析 = 未选中：没有清除入口
    expect(await card.slotButtons('shuvix-model')).toBe(1)
    await expectUnchanged(seed.file, C_UNRESOLVED, 1000)
  })
})

describe('D 组 · 关闭语义与生命周期', () => {
  it('AC-19 点面板内部不关（portal 出去的节点也算内部），点外部才关', async () => {
    const seed = byFile('d-close.md')
    await openNotebook(seed)
    await card.waitReady()

    await card.openTools()
    await card.mousedownInsideTools()
    expect(await card.toolsOpen()).toBe(true)

    await card.clickOutside()
    expect(await card.toolsOpen()).toBe(false)
    await expectUnchanged(seed.file, D_CLOSE)
  })

  it('AC-20 Esc 关闭工具弹层', async () => {
    await card.openTools()
    expect(await card.toolsOpen()).toBe(true)
    await card.pressEscape()
    expect(await card.toolsOpen()).toBe(false)
  })

  it('AC-21 切走会话后 body 不残留弹层（widget.destroy → React root 卸载）', async () => {
    await card.openTools()
    expect(await card.toolsOpen()).toBe(true)

    await openNotebook(byFile('a1-open.md'))
    await until(async () => !(await card.toolsOpen()), 'panel torn down with the session')
    expect(await card.toolsOpen()).toBe(false)
  })

  it('AC-26 点卡片空白处不塌成源码（卡片在 contenteditable 内，默认会把光标送进 frontmatter）', async () => {
    await openNotebook(byFile('a1-open.md'))
    await card.waitReady()

    // 在标签/行/卡片背景上派发完整点击：卡片必须仍在（此前会当场塌成源码，
    // 块高差一百多像素，正文随之弹跳 —— 反复编辑元数据时最晃眼的那一下）
    for (const sel of [
      '.cm-shuvix-fmcard-label',
      '.cm-shuvix-fmcard-row',
      '.cm-shuvix-fmcard-rows'
    ]) {
      await app.main.eval(
        `(() => {
          const el = document.querySelector(${'`'}${'$'}{${JSON.stringify(sel)}}${'`'})
          const r = el.getBoundingClientRect()
          const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
          el.dispatchEvent(new MouseEvent('mousedown', o))
          el.dispatchEvent(new MouseEvent('mouseup', o))
          el.dispatchEvent(new MouseEvent('click', o))
        })()`
      )
      await sleep(250)
      expect(await count('.cm-shuvix-fmcard'), `点 ${sel} 后卡片应仍在`).toBe(1)
    }
  })

  it('AC-27 阻止聚焦只针对空白处：控件上的 mousedown 不被 preventDefault', async () => {
    // 合成事件不触发浏览器默认聚焦（那是可信事件的行为），故直接断言处理器的判定
    const prevented = await app.main.eval<Record<string, boolean>>(
      `(() => {
        const probe = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
          el.dispatchEvent(ev)
          return ev.defaultPrevented
        }
        return {
          label: probe('.cm-shuvix-fmcard-label'),
          input: probe('.cm-shuvix-fmcard-input'),
          slot: probe('.cm-shuvix-fmcard-slot')
        }
      })()`
    )
    expect(prevented.label).toBe(true)
    expect(prevented.input).toBe(false)
    expect(prevented.slot).toBe(false)
  })
})

describe('F 组 · 零副作用与行尾归一', () => {
  it('AC-24 只打开不交互 → 零写盘（A 组各文件字节不变）', async () => {
    const openOnly = [
      { file: 'a1-open.md', content: A1_OPEN },
      { file: 'a1b-empty.md', content: A1_EMPTY },
      { file: 'a2-readonly.md', content: A2_READONLY },
      { file: 'a3-mixed.md', content: A3_MIXED },
      { file: 'a4-badyaml.md', content: A4_BAD_YAML }
    ]
    await sleep(1000)
    for (const { file, content } of openOnly) expect(read(file)).toBe(content)
  })

  it('AC-25 CRLF 文件写回后整份归一为 LF，且仍是合法 agent md', async () => {
    const seed = byFile('f-crlf.md')
    await openNotebook(seed)
    await card.waitReady()
    const before = read(seed.file)
    expect(before).toContain('\r\n')

    await card.openTools()
    expect(await card.clickTool('write')).toBe(true)
    await card.pressEscape()

    // CM6 载入即按 /\r\n?|\n/ 切行，写回的是整份文档 → 归一是全局的，不止改动那一行
    const after = await waitWritten(seed.file, before)
    expect(after).not.toContain('\r')
    expect(after).toContain('shuvix-tools: read, write')
    expect(await validateAgent(after)).toEqual({ status: 'valid', messages: [] })
  })
})

describe('E 组 · 宿主差异', () => {
  it('AC-23 设置页「智能体」tab：卡片只接管文件开头的 frontmatter，正文里的 --- 块保持字面量', async () => {
    // 正文里粘贴的 frontmatter 块必须保持纯文本 —— 那里编辑的不是完整契约文件
    mkdirSync(app.agentsDir, { recursive: true })
    writeFileSync(
      join(app.agentsDir, 'ac23-body-fm.md'),
      md(
        '---',
        'shuvix: agent v1',
        'name: ac23-body-fm',
        'description: AC-23 body carries a literal frontmatter block',
        '---',
        '',
        '---',
        'shuvix: agent v1',
        'name: pasted-inside-body',
        '---',
        '',
        'AC-23 BODY MARKER.'
      )
    )
    const settings = await app.openSettings('agents')
    const pane = await agentsPane(settings)
    await pane.selectRow('ac23-body-fm')

    await until(
      () =>
        settings.eval<boolean>(
          `[...document.querySelectorAll('.cm-content')].some((c) => c.textContent.includes('AC-23 BODY MARKER.'))`
        ),
      'agent body editor loaded'
    )
    // 智能体页现在也是「md 原文 + 属性卡」（与笔记本同一套）：文件**自身**的 frontmatter
    // 由卡片接管，而正文里粘贴的 --- 块保持纯文本 —— 卡片只认文件开头那一段。
    expect(
      await settings.eval<number>(`document.querySelectorAll('.cm-shuvix-fmcard').length`)
    ).toBe(1)
    expect(
      await settings.eval<boolean>(
        `[...document.querySelectorAll('.cm-content')].some((c) => c.textContent.includes('name: pasted-inside-body'))`
      )
    ).toBe(true)
    settings.close()
  })

  // 末位：点开右侧 Preview 会改变主窗布局（对话区收缩），之后的坐标类断言都不再可比
  it('AC-22 只读宿主（右侧 Preview）：控件形态与可编辑态一致，全部禁用；无跳源码按钮', async () => {
    await openNotebook(byFile('e-host.md'))
    const LINK = `document.querySelector('.cm-atomic-wiki-link-resolved[data-wiki-link-target="readonly-card"]')`
    await until(() => app.main.eval<boolean>(`${LINK} !== null`), 'wiki link resolved')
    await app.main.eval(`${LINK}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)

    // 宿主笔记本自身无 frontmatter → DOM 里出现的这张卡就是预览里的那张
    await until(
      () =>
        app.main.eval<boolean>(
          `[...document.querySelectorAll('.cm-content')].some((c) => c.textContent.includes('READONLY CARD BODY MARKER.'))`
        ),
      'read-only preview mounted'
    )
    await card.waitReady({ slots: 3 })

    // 只读宿主渲染同一套控件（model / tools / instruction-files 三个槽位 + 文本输入框），
    // 只是全部禁用 —— 只读不换长相，只换可否交互
    expect(await count('.cm-shuvix-fmcard-slot')).toBe(3)
    expect(await slotText('shuvix-tools')).toContain('bash, read')
    // 指令文件清单是普通逗号串输入（刻意不挂文件选择器：档案编辑期不知道将来的工作目录）
    expect(await slotText('shuvix-instruction-files')).toBe('')
    expect(
      await app.main.eval<string>(
        `${rowSelector('shuvix-instruction-files')}?.querySelector('input')?.value ?? ''`
      )
    ).toBe('AGENTS.md')
    expect(
      await app.main.eval<boolean>(
        `[...document.querySelectorAll('.cm-shuvix-fmcard-input')].every((i) => i.disabled)`
      )
    ).toBe(true)
    expect(
      await app.main.eval<boolean>(
        `[...document.querySelectorAll('.cm-shuvix-fmcard-slot button')].every((b) => b.disabled)`
      )
    ).toBe(true)
    expect(await count('.cm-shuvix-fmcard-src')).toBe(0)
    // 布尔行两个：项目感知（项目提示词与项目记忆合成的那一个）与会话感知
    expect(
      await app.main.eval<boolean[]>(
        `[...document.querySelectorAll('.cm-shuvix-fmcard-toggle')].map((t) => t.disabled)`
      )
    ).toEqual([true, true])
  })
})

// ── 卡片自有钩子的行级探针（`.cm-shuvix-fmcard*` 稳定，按 data-key 定位） ──

function rowSelector(key: string): string {
  return `document.querySelector('.cm-shuvix-fmcard-row[data-key=${JSON.stringify(key)}]')`
}
function rowExists(key: string): string {
  return `${rowSelector(key)} !== null`
}
function rowHasSlot(key: string): string {
  return `${rowSelector(key)}?.querySelector('.cm-shuvix-fmcard-slot') != null`
}
function slotText(key: string): Promise<string> {
  return app.main.eval<string>(
    `(${rowSelector(key)}?.querySelector('.cm-shuvix-fmcard-slot')?.textContent ?? '').trim()`
  )
}
function rowValueText(key: string): Promise<string> {
  return app.main.eval<string>(
    `(${rowSelector(key)}?.querySelector('.cm-shuvix-fmcard-value')?.textContent ?? '').trim()`
  )
}
