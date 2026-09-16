/**
 * 随应用发布的**内置知识库**（保留名 `shuvix`）× 只读笔记本 × 界面语言切换 ——
 * 契约见 CLAUDE.md「Builtin knowledge base」与 docs/okf-knowledge-design.md 附录 O（含其后的「补充」）。
 *
 *   KBI-E-1 点内置条目行 → 开的是 `__knowledge_builtin__` 下的笔记本会话，notebookPath 是库内相对路径
 *           （不含 `builtin/<库名>/`、也不含语言段）；该承载项目不进 `project.list`。
 *   KBI-E-2 只读笔记本没有输入卡片；对照组：用户库的笔记本有。
 *   KBI-E-3 编辑器只读：正文读得到、`contenteditable` 为 false（可写笔记本为 true），磁盘字节不变。
 *   KBI-E-4 属性卡只读：type / status 两个下拉 disabled、文本字段不可编辑。
 *   KBI-E-5 切语言 → 侧栏那一行的名字换成新语言的 `knowledge.builtinBaseName`，条目行 id 不变、
 *           标题换成新语言的 title。
 *   KBI-E-6 已开的笔记本会话在切语言后读到新语言的正文：会话 id 与 notebookPath 一字不变。
 *   KBI-E-7 「不三倍重复」的端到端形态：侧栏里内置库下的条目行数 = **单语**目录的 md 数；切语言后仍是这个数。
 *
 * ⚠️ **独占一个实例**：只读笔记本（没有输入卡片）与语言切换都会污染同实例后续用例，所以这一组不与
 * knowledge-sidebar.e2e.ts 共用实例。
 *
 * ⚠️ **内置根是本仓的真目录**：隔离实例只换了 HOME，内置根仍是 `apps/desktop/resources/knowledge`。
 * 所以这份 spec **只读它，绝不写**，也绝不写「试着往内置库写、断言被拒」这类用例 —— 闸门若回归，
 * 那种用例会改掉仓库自己的资源。KBI-E-3 里那条「字节没变」既是断言也是护栏：它先记下原字节、
 * 走完一整趟之后逐字节比，任何一次意外的自动保存都会在这里现形。
 *
 * ⚠️ 语言**显式钉死**（先 en，再切 zh），不跟系统语言走：内置库的显示名与条目标题三语各一份，
 * 不钉死就只能断「是三语里的某一句」，测不出「切过去之后变成了哪一句」。
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KNOWLEDGE_BUILTIN_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { registryNoteSessions } from '../../harness/seed'
import { fmCardPane, knowledgePane, type FmCardPane, type KnowledgePane } from '../../harness/pages'

/** 内置库的 bundle id（本期唯一的一个） */
const BUILTIN_BASE = 'builtin/shuvix'

/** 拿来当样本的那一条（三语同名同数，见单测 BK-1） */
const SAMPLE = 'hook-md.md'
const SAMPLE_ID = `${BUILTIN_BASE}/${SAMPLE}`

/**
 * 内置根 —— 与运行中的实例算出来的是同一个目录：未打包分支是
 * `resolve(out/main, '../../resources/knowledge')` = `apps/desktop/resources/knowledge`。
 * 本文件在 `apps/desktop/e2e/specs/notebook/`，往上三层正是 `apps/desktop/`。
 */
const RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '../../../resources/knowledge')
const langDir = (lang: string): string => join(RESOURCES, 'shuvix', lang)

/** 某个语言目录下的 md 文件名（字典序） */
const mdIn = (lang: string): string[] =>
  readdirSync(langDir(lang))
    .filter((f) => f.endsWith('.md'))
    .sort()

/** 某一版条目的原文 */
const sourceOf = (lang: string): string => readFileSync(join(langDir(lang), SAMPLE), 'utf-8')

/** frontmatter 里的 title（去引号）—— 侧栏那一行的名字就是它 */
function titleOf(lang: string): string {
  const line = sourceOf(lang)
    .split('\n')
    .find((l) => l.startsWith('title:'))
  return (line ?? '')
    .slice('title:'.length)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

/** 正文里第一个一级标题的文字 —— 各语言互不相同，拿它当「读到的是哪一版」的特征串 */
function headingOf(lang: string): string {
  const body = sourceOf(lang).split(/^---$/m).slice(2).join('---')
  const line = body.split('\n').find((l) => l.startsWith('# '))
  return (line ?? '').slice(2).trim()
}

let app: E2EApp
let kb: KnowledgePane
let card: FmCardPane
/** 用户根 `~/.shuvix/knowledge`（KBI-E-2 的对照组住在这里） */
let userRoot: string

const USER_NOTE_BODY = 'USER BASE BODY'

/** 设一个设置并等它落地（语言那一条还会触发内置库重扫 + 承载项目重指） */
async function setLanguage(lang: string): Promise<void> {
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(lang)} })`
  )
  // settings.set → changeLanguage + refreshBuiltinKnowledge + syncKnowledgeBuiltinProject，
  // 再经 knowledge.changed 回到侧栏重扫：等侧栏那一行的名字真的换过去
  await until(
    async () => (await builtinRowLabel()) === BUILTIN_NAME[lang],
    `sidebar builtin row renamed for language "${lang}"`
  )
}

const BUILTIN_NAME: Record<string, string> = {
  en: en.knowledge.builtinBaseName,
  zh: zh.knowledge.builtinBaseName
}

/** 侧栏里内置库那一行的名字；行不在为空串 */
async function builtinRowLabel(): Promise<string> {
  return (await kb.dirs()).find((d) => d.path === BUILTIN_BASE)?.label ?? ''
}

/** 内置库下的条目行（DOM 序） */
async function builtinRows(): Promise<{ path: string; label: string }[]> {
  return (await kb.rows()).filter((r) => r.path.startsWith(`${BUILTIN_BASE}/`))
}

/** 承载项目下、绑定到某个 notebookPath 的笔记本会话 */
async function builtinNotes(notebookPath: string): Promise<{ id: string; notebookPath: string }[]> {
  return (await registryNoteSessions(app.main, KNOWLEDGE_BUILTIN_PROJECT_ID)).filter(
    (s) => s.notebookPath === notebookPath
  )
}

beforeAll(async () => {
  app = await launchApp()
  kb = knowledgePane(app.main)
  card = fmCardPane(app.main)

  // 对照组：一个普通的用户库（KBI-E-2 的「有输入卡片」那一半）
  userRoot = join(app.home, '.shuvix', 'knowledge')
  mkdirSync(join(userRoot, 'mine'), { recursive: true })
  writeFileSync(join(userRoot, 'mine', 'note.md'), `# Mine\n\n${USER_NOTE_BODY}\n`)

  // 语言先钉死在 en —— 隔离实例本来跟系统语言走，那样切换前后是哪一版都说不准
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await kb.expand()
  await until(
    async () => (await builtinRowLabel()) === BUILTIN_NAME.en,
    'sidebar builtin row named in English'
  )
  await kb.setDirOpen(BUILTIN_BASE, true)
})

afterAll(async () => {
  await app?.stop()
})

describe('内置知识库 × 只读笔记本', () => {
  it('KBI-E-1 点内置条目行 → `__knowledge_builtin__` 下的笔记本会话，notebookPath 是库内相对路径；承载项目不进项目列表', async () => {
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))

    // notebookPath 既不含 `builtin/shuvix/`，也不含语言段 —— 各语言同名同路径，切语言不动它
    const notes = await until(async () => {
      const hit = await builtinNotes(SAMPLE)
      return hit.length > 0 ? hit : null
    }, `${SAMPLE} note session under __knowledge_builtin__`)
    expect(notes).toHaveLength(1)
    expect(notes[0].notebookPath).toBe(SAMPLE)

    // 再点一次复用同一条（与另两种库同一条规则）
    const first = notes[0].id
    await kb.openRow(SAMPLE_ID)
    expect((await builtinNotes(SAMPLE)).map((s) => s.id)).toEqual([first])

    // 承载项目此刻已建出（上面那条会话挂在它下面），但不进项目列表
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(KNOWLEDGE_BUILTIN_PROJECT_ID)
    // 承载项目的 path 就是当前语言那一版的目录
    const carrierPath = await app.main.eval<string>(
      `window.api.knowledge.list().then((r) => r.bundleDirs[${JSON.stringify(BUILTIN_BASE)}] ?? '')`
    )
    expect(carrierPath).toBe(langDir('en'))
  })

  it('KBI-E-2 只读笔记本没有输入卡片；对照组：用户库的笔记本有', async () => {
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))
    expect(await kb.hasInputCard()).toBe(false)

    // 对照：同一个侧栏分组里的用户库笔记本照旧有输入卡片
    await kb.setDirOpen('knowledge/mine', true)
    await kb.openRow('knowledge/mine/note.md')
    await kb.waitBody(USER_NOTE_BODY)
    await until(() => kb.hasInputCard(), 'input card on a writable knowledge notebook')

    // 切回内置的那一份：输入卡片跟着消失（不是「一开始就没有」的一次性巧合）
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))
    await until(async () => (await kb.hasInputCard()) === false, 'input card gone again')
  })

  /**
   * 「敲键不改文档」在这套 harness 里只能断到这一层：CDP 客户端只有 Runtime.evaluate（没有
   * Input 域），而 CodeMirror 6 不认合成的 `beforeinput` / `keydown` —— 实测**可写**的笔记本
   * 也不会因此改一个字，所以「模拟敲键后正文没变」两边都绿，是一条假通道。
   *
   * 真正挡住按键的是 `contenteditable="false"`（浏览器自己就不把按键送进来了）。所以这条断的是
   * 那个开关本身，并自带**可写笔记本的对照组** —— 同一个读数在那边必须回 true，否则这条就是空转。
   * 再加一条落盘字节不变：内置根是本仓的真目录，它既是断言也是护栏。
   */
  it('KBI-E-3 编辑器只读：正文读得到、contenteditable 为 false（可写笔记本为 true），磁盘字节不变', async () => {
    const before = sourceOf('en')

    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))
    // 读得到（只读不是「读不了」）
    expect(await kb.bodyText()).toContain(headingOf('en'))
    expect(await kb.editorEditable()).toBe(false)

    // 对照组：同一个读数在可写的用户库笔记本上是 true
    await kb.setDirOpen('knowledge/mine', true)
    await kb.openRow('knowledge/mine/note.md')
    await kb.waitBody(USER_NOTE_BODY)
    expect(await kb.editorEditable()).toBe(true)

    // 回到内置那一份：整趟走完，应用包里的那份文件逐字节不变（挂载时的自动保存也没碰它）
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))
    await sleep(1200)
    expect(readFileSync(join(langDir('en'), SAMPLE), 'utf-8')).toBe(before)
  })

  it('KBI-E-4 属性卡只读：type / status 两个下拉 disabled、文本字段不可编辑', async () => {
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('en'))
    await card.waitReady()

    // 卡还是那张卡（内置条目带自述行，徽章带版本段）
    const shot = await kb.card()
    expect(shot?.badge).toBe('OKF entry · v0.2')
    expect(shot?.selects).toEqual([
      { key: 'type', value: 'Guide' },
      { key: 'status', value: 'stable' }
    ])

    const fields = await kb.cardFields()
    expect(fields?.selects).toEqual([
      { key: 'type', disabled: true },
      { key: 'status', disabled: true }
    ])
    // 文本字段（title / description / tags …）一个都不可编辑
    expect(fields!.inputs).toBeGreaterThan(0)
    expect(fields!.inputsDisabled).toBe(fields!.inputs)
  })
})

describe('内置知识库 × 界面语言', () => {
  it('KBI-E-5 切语言 → 侧栏那一行换成新语言的人读名；条目行 id 不变、标题换成新语言的 title', async () => {
    const before = await builtinRows()
    expect(before.map((r) => r.path)).toContain(SAMPLE_ID)
    expect(before.find((r) => r.path === SAMPLE_ID)?.label).toBe(titleOf('en'))
    expect(await builtinRowLabel()).toBe(BUILTIN_NAME.en)

    await setLanguage('zh')

    // 行 id 是语言无关的（语言那一层不进 id）：一份都没多、没少、没改名
    await until(
      async () => (await builtinRows()).find((r) => r.path === SAMPLE_ID)?.label === titleOf('zh'),
      'builtin entry row retitled in Chinese'
    )
    const after = await builtinRows()
    expect(after.map((r) => r.path).sort()).toEqual(before.map((r) => r.path).sort())
    expect(await builtinRowLabel()).toBe(BUILTIN_NAME.zh)
    // 两版的标题确实不同 —— 否则上面那条断言是空转
    expect(titleOf('zh')).not.toBe(titleOf('en'))
  })

  it('KBI-E-6 已开的笔记本会话读到新语言的正文：会话 id 与 notebookPath 一字不变', async () => {
    // 上一条已经切到 zh；那条会话是 KBI-E-1 开出来的，切换前后都是它
    const notes = await builtinNotes(SAMPLE)
    expect(notes).toHaveLength(1)
    expect(notes[0].notebookPath).toBe(SAMPLE)

    // 承载项目的 path 被重指到新语言那一版（notebookPath 在各语言里同名，所以会话不用动）
    await until(
      async () =>
        (await app.main.eval<string>(
          `window.api.knowledge.list().then((r) => r.bundleDirs[${JSON.stringify(BUILTIN_BASE)}] ?? '')`
        )) === langDir('zh'),
      'builtin bundle dir now points at the Chinese version'
    )

    // 笔记本的内容是在挂载时读的（切语言不会原地重读）：离开再回来就是新语言那一份
    await kb.openRow('knowledge/mine/note.md')
    await kb.waitBody(USER_NOTE_BODY)
    await kb.openRow(SAMPLE_ID)
    await kb.waitBody(headingOf('zh'))
    expect(await kb.bodyText()).not.toContain(headingOf('en'))

    // 同一条会话 —— 没有因为换了目录而另开一条
    const after = await builtinNotes(SAMPLE)
    expect(after.map((s) => s.id)).toEqual(notes.map((s) => s.id))
    expect(after[0].notebookPath).toBe(SAMPLE)
    // 只读那一半不随语言变
    expect(await kb.hasInputCard()).toBe(false)
    expect(await kb.editorEditable()).toBe(false)
  })

  it('KBI-E-7 不三倍重复：内置库下的条目行数 = 单语目录的 md 数；切语言后仍是这个数', async () => {
    // 前提（单测 BK-1 正面钉它）：三语同名同数，所以「单语的份数」是一个确定的数
    const counts = ['en', 'zh', 'ja'].map((l) => mdIn(l).length)
    expect(counts[0]).toBeGreaterThan(0)
    expect(new Set(counts).size).toBe(1)

    // 此刻是 zh（上一条切过去的）
    expect((await builtinRows()).length).toBe(counts[0])
    // 行的 id 就是单语目录里的文件名，一一对应
    expect((await builtinRows()).map((r) => r.path.slice(BUILTIN_BASE.length + 1)).sort()).toEqual(
      mdIn('zh')
    )

    await setLanguage('en')
    await until(
      async () => (await builtinRows()).length === counts[0],
      'builtin entry rows still a single language worth after switching back'
    )
    // 广播之后再给一拍，确认它没有「先对后涨」
    await sleep(500)
    expect((await builtinRows()).length).toBe(counts[0])
  })
})
