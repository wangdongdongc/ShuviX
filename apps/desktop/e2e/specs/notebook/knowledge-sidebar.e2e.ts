/**
 * 侧栏「知识库」分组（KnowledgeGroup）× 用户知识库 —— 契约见 CLAUDE.md「Knowledge base v2 (OKF)」与
 * docs/okf-knowledge-design.md 附录 U（含「补充」）、附录 L（读宽写严）。
 *
 *   KE-1 树形态：Projects 容器置顶，`~/.shuvix/knowledge/` 下每个子目录一个库、与容器平级平铺（没有
 *        「knowledge」那一层）；隐藏路径、用户根下的散文件、ShuviX 早先生成形状的 index/log 都不占行，
 *        **空目录照常占行**（手动新建的库 / 文件夹第一时间就是空的，它们是新建条目的落点）；不合规的
 *        md 与手写的 index/log 照常列出（名字依次取 title、第一个 # 标题、文件名）；项目库显示项目
 *        **当前**名字。默认折叠：容器展开，项目库与用户库折叠。
 *   KE-2 点行打开：用户库挂 `__knowledge_user__`（notebookPath = 条目 id 去掉首段 `knowledge/`），项目库挂
 *        `__knowledge__`（notebookPath = 条目 id）；再点复用同一会话；两个承载项目不进项目列表。
 *   KE-3 属性卡兜底只在知识库笔记本里：完全没有 `shuvix:` 行的文件出 OKF 卡（无版本段、无校验态），带别家
 *        标记的以标记为准；普通项目里的同一份文件照旧不出卡。
 *   KE-4 菜单：组头「新建知识库 / 打开目录 / 刷新」，行「在文件夹中显示 / 复制路径」；复制路径按条目 id 的首段分派到两个根。
 *   KE-5 空库一开始就有目录行；里面出现第一个 md 之后，刷新即长出条目行。
 *   KE-6 目录行菜单 = 新建条目 / 新建文件夹；固定文案的 `项目` 容器不是落点，它连 ⋮ 都没有。
 *   KE-7 新建知识库：组头菜单 → 树里就地输名字，Esc 与失焦都取消；Enter 建完宿主自己重扫，不用刷新。
 *   KE-8 失败原因回到那一行里：名字还在框里、草稿还开着，改一下再回车即可。
 *   KE-9 新建条目：元数据由宿主担保（自述行 / type / status），正文留空，建完立刻打开它的笔记本。
 *  KE-10 内置库那一行：锁 + 自己的身份图标 + `data-knowledge-readonly`；普通目录仍随展开切开/合文件夹。
 *  KE-11 那一行显示本地化的人读名，不是目录名 `shuvix`。
 *  KE-12 只读那一支没有目录行菜单；用户库那一行照旧「新建条目 / 新建文件夹」。
 *  KE-13 条目行的读动作照旧；「复制路径」走清单下发的 `bundleDirs`（内置根 + 语言层），不是两个根拼的。
 *  KE-14 组头「新建知识库」输入保留名 `shuvix` → 失败原因回到草稿行里，草稿仍开着。
 *
 * 会话归属先走 IPC（`session.list` / `project.list`）；树形与卡片是纯渲染产物，经 pages.ts 的 knowledgePane 读。
 * ⚠️ 组头 `open-folder` 与行 `reveal` 只读不选：隔离实例没有替换 shell，选中会在真实桌面上弹出文件管理器。
 * ⚠️ 用例共用一个实例、按顺序依赖前面的状态（KE-5 往库里写文件；KE-7～KE-9 真的建库 / 建条目，排在最后）。
 * ⚠️ 内联新建行**失焦即取消**：草稿开着的时候一律不点任何东西，读断言全走 knowledgePane 的 draft* 系列。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import { createProject, registryNoteSessions } from '../../harness/seed'
import {
  fmCardPane,
  knowledgePane,
  sidebarPane,
  type FmCardPane,
  type KnowledgeDirShot,
  type KnowledgeDraftKind,
  type KnowledgePane,
  type SidebarPane
} from '../../harness/pages'

/**
 * 随应用发布的内置库 —— 它**不在 fake HOME 里**：隔离实例只换了 HOME，内置根仍是本仓的
 * `apps/desktop/resources/knowledge`。所以 KE-10~KE-13 一律**只读**它，绝不往里写、也绝不
 * 断言「写进去被拒」—— 那种用例一旦闸门回归就会改掉仓库自己的资源。
 */
const BUILTIN_BASE = 'builtin/shuvix'

/** 内置库的人读名（三语全收）—— 隔离实例跟系统语言走，断的是「是哪一句」而不是哪门语言 */
const BUILTIN_NAMES = [en, zh, ja].map((l) => l.knowledge.builtinBaseName)

let app: E2EApp
let kb: KnowledgePane
let card: FmCardPane
let sidebar: SidebarPane
/** KbProj 的项目 id —— 项目库的目录名就是它 */
let projectId: string
/** 用户根 `~/.shuvix/knowledge` */
let userRoot: string

const PROJ_ENTRY_MD = [
  '---',
  'shuvix: okf v0.2',
  'type: Memory',
  'title: Proj Entry',
  'status: stable',
  '---',
  '',
  'PROJ ENTRY BODY',
  ''
].join('\n')

/** 没有自述行、但有 type 的条目 —— OKF 按位置认条目，它照样是合规概念 */
const NO_MARKER_MD = [
  '---',
  'type: Memory',
  'title: No Marker',
  'status: draft',
  '---',
  '',
  'NO MARKER BODY',
  ''
].join('\n')

/** 没有 frontmatter 的普通笔记 */
const PLAIN_MD = '# Plain note\n\nPLAIN BODY\n'

/** 别家契约（agent md 的最小合法形状）：拷进库里照常列出，但卡片以它自己的标记为准 */
const FOREIGN_MD = [
  '---',
  'shuvix: agent v1',
  'name: foreign-agent',
  'description: an agent md copied into a knowledge base',
  '---',
  '',
  'FOREIGN BODY',
  ''
].join('\n')

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** 某个承载项目下、绑定到某个 notebookPath 的笔记本会话 id */
async function notesAt(carrier: string, notebookPath: string): Promise<string[]> {
  return (await registryNoteSessions(app.main, carrier))
    .filter((s) => s.notebookPath === notebookPath)
    .map((s) => s.id)
}

/** 目录行菜单里的动作 id（分隔符滤掉）；该行没有 ⋮ 时返回 null */
async function dirMenuIds(path: string): Promise<string[] | null> {
  const shots = await kb.dirMenuShots(path)
  return shots === null ? null : shots.filter((it) => it.id).map((it) => it.id as string)
}

/** 等内联新建行长出来 —— 菜单回调 → setState → 渲染，中间隔着几拍 */
async function waitDraft(kind: KnowledgeDraftKind): Promise<void> {
  await until(async () => (await kb.draftKind()) === kind, `knowledge ${kind} draft row`)
}

/**
 * 扮演系统剪贴板：「复制路径」的最后一跳是 navigator.clipboard.writeText —— 顶掉它、把文本记在页内，
 * 既能断言复制了什么，也不碰运行 e2e 那台机器的真剪贴板
 */
async function captureClipboard(): Promise<void> {
  await app.main.eval(`(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text) => { window.__kbCopied = text; return Promise.resolve() }
    })
    window.__kbCopied = null
    return true
  })()`)
}

/** 等下一次复制落进桩里并取走（取完即清，下一次读不到上一次的值） */
async function takeCopied(): Promise<string> {
  const text = await until(
    () => app.main.eval<string | null>(`window.__kbCopied`),
    'path copied to clipboard'
  )
  await app.main.eval(`(() => { window.__kbCopied = null; return true })()`)
  return text
}

beforeAll(async () => {
  app = await launchApp()
  kb = knowledgePane(app.main)
  card = fmCardPane(app.main)
  sidebar = sidebarPane(app.main)

  const projDir = join(app.home, 'kbproj')
  mkdirSync(projDir, { recursive: true })
  // 对照组：内容与用户库里的 no-marker.md 相同，但住在普通项目里
  put(join(projDir, 'no-marker-copy.md'), NO_MARKER_MD)
  projectId = (await createProject(app.main, { name: 'KbProj', path: projDir })).id

  // 清单只在分组首次展开时拉 —— 以下种子必须全部写在第一次 expand 之前
  const bundle = join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', projectId)
  put(join(bundle, 'a.md'), PROJ_ENTRY_MD)

  userRoot = join(app.home, '.shuvix', 'knowledge')
  put(join(userRoot, 'notes', 'no-marker.md'), NO_MARKER_MD)
  put(join(userRoot, 'notes', 'plain.md'), PLAIN_MD)
  put(join(userRoot, 'notes', 'foreign.md'), FOREIGN_MD)
  // 用户手写的 index.md / log.md 不是生成的形状：是普通笔记，照常一行
  put(join(userRoot, 'notes', 'index.md'), '# Hand-written index\n')
  put(join(userRoot, 'notes', 'log.md'), '# Hand-written log\n')
  put(join(userRoot, 'notes', 'sub', 'deep.md'), 'DEEP BODY\n')
  // 库内的隐藏目录（Obsidian 的回收站）不是库的内容
  put(join(userRoot, 'notes', '.trash', 't2.md'), 'TRASH INSIDE A BASE\n')
  put(join(userRoot, '读书笔记', 'r.md'), 'READING BODY\n')
  // ShuviX 早先生成的形状的 index（只有节标题与链接行）不是笔记，不占行
  put(join(userRoot, '读书笔记', 'index.md'), '## Entries\n\n* [r](r.md)\n')
  // 空文件夹也是一个库：没有 md 也有目录行（KE-5 再往里写第一个 md）
  mkdirSync(join(userRoot, 'empty'), { recursive: true })
  // 隐藏目录不算库；用户根下的散文件不属于任何库
  put(join(userRoot, '.trash', 't.md'), 'TRASH AT ROOT\n')
  put(join(userRoot, 'readme.md'), 'LOOSE FILE AT ROOT\n')

  // 对照组的普通笔记本会话 —— 与 frontmatter-card.e2e.ts 同口径：notebookPath 给绝对路径
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({
      projectId,
      notebookPath: join(projDir, 'no-marker-copy.md'),
      title: 'no-marker-copy'
    })})`
  )
})

afterAll(async () => {
  await app?.stop()
})

describe('知识库分组 × 用户知识库', () => {
  it('KE-1 树形态：Projects 容器置顶、用户库与之平级；不该有的目录与文件不占行；默认折叠态', async () => {
    await kb.expand()

    // 顶层 = 内置库（置顶）→ Projects 容器 → 每个有 md 的用户库，全部零缩进 ——
    // 没有包一层「knowledge」，也没有包一层「builtin」
    const top = await kb.topDirs()
    expect(top.slice(0, 2).map((d) => d.path)).toEqual(['builtin/shuvix', 'projects'])
    expect(
      top
        .slice(2)
        .map((d) => d.path)
        .sort()
    ).toEqual(['knowledge/empty', 'knowledge/notes', 'knowledge/读书笔记'].sort())

    // 被提掉的用户根容器与隐藏目录：任何层级都不该有目录行。空库有行 —— 那是新建条目的落点
    const dirPaths = (await kb.dirs()).map((d) => d.path)
    expect(dirPaths).not.toContain('knowledge')
    expect(dirPaths).not.toContain('builtin')
    expect(dirPaths).not.toContain('knowledge/.trash')
    expect(dirPaths).toContain('knowledge/empty')

    // 默认态：容器展开，项目库与用户库折叠
    expect(await kb.dirOpen('projects')).toBe(true)
    expect(await kb.dirOpen(`projects/${projectId}`)).toBe(false)
    expect(await kb.dirOpen('knowledge/notes')).toBe(false)
    expect(await kb.dirOpen('knowledge/读书笔记')).toBe(false)

    // 项目库的目录名是项目 id；行上显示项目当前的名字（宿主按 id 查），不是 id
    const projectDir = (await kb.dirs()).find((d) => d.path === `projects/${projectId}`)
    expect(projectDir?.label).toBe('KbProj')

    // 读宽：有 type 的是合规条目（名字取 title）；没有 frontmatter、带别家标记的照常一行 —— 标题依次取
    // frontmatter title、正文第一个 # 标题、文件名；用户手写的 index.md / log.md 是普通笔记，同样一行
    const rows = await kb.rows()
    expect(rows).toEqual(
      expect.arrayContaining([
        { path: 'knowledge/notes/no-marker.md', label: 'No Marker' },
        { path: 'knowledge/notes/plain.md', label: 'Plain note' },
        { path: 'knowledge/notes/foreign.md', label: 'foreign' },
        { path: 'knowledge/notes/sub/deep.md', label: 'deep' },
        { path: 'knowledge/notes/index.md', label: 'Hand-written index' },
        { path: 'knowledge/notes/log.md', label: 'Hand-written log' }
      ])
    )
    const rowPaths = rows.map((r) => r.path)
    for (const hidden of [
      // ShuviX 早先生成的形状的 index 不是笔记
      'knowledge/读书笔记/index.md',
      'knowledge/notes/.trash/t2.md'
    ]) {
      expect(rowPaths).not.toContain(hidden)
    }
    // 两个 .trash 下的文件（任一段以点开头）与用户根下的散文件都不属于任何库
    expect(rowPaths.filter((p) => p.split('/').some((seg) => seg.startsWith('.')))).toEqual([])
    expect(rowPaths.filter((p) => p.endsWith('readme.md'))).toEqual([])
  })

  it('KE-2 点行打开：用户库挂 __knowledge_user__、项目库挂 __knowledge__；再点复用；承载项目不进项目列表', async () => {
    await kb.expand()
    await kb.setDirOpen('knowledge/notes', true)
    await kb.openRow('knowledge/notes/plain.md')
    // 用户库的承载项目根是用户根：notebookPath = 条目 id 去掉首段 knowledge/
    await until(
      async () => (await notesAt(KNOWLEDGE_USER_PROJECT_ID, 'notes/plain.md')).length > 0,
      'plain.md note session under __knowledge_user__'
    )
    await kb.waitBody('PLAIN BODY')

    // 点开别的行、再点回来：同一份文件至多一个笔记本会话
    await kb.openRow('knowledge/notes/no-marker.md')
    await kb.waitBody('NO MARKER BODY')
    await kb.openRow('knowledge/notes/plain.md')
    await kb.waitBody('PLAIN BODY')
    expect(await notesAt(KNOWLEDGE_USER_PROJECT_ID, 'notes/plain.md')).toHaveLength(1)

    // 项目库的承载项目根是 knowledge-shuvix：notebookPath 就是条目 id
    await kb.setDirOpen(`projects/${projectId}`, true)
    await kb.openRow(`projects/${projectId}/a.md`)
    await until(
      async () => (await notesAt(KNOWLEDGE_PROJECT_ID, `projects/${projectId}/a.md`)).length > 0,
      'a.md note session under __knowledge__'
    )
    await kb.waitBody('PROJ ENTRY BODY')
    expect(await notesAt(KNOWLEDGE_PROJECT_ID, `projects/${projectId}/a.md`)).toHaveLength(1)

    // 两个承载项目此刻都已建出（上面两条会话挂在它们下面），但都不进项目列表
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).toContain(projectId)
    expect(projectIds).not.toContain(KNOWLEDGE_PROJECT_ID)
    expect(projectIds).not.toContain(KNOWLEDGE_USER_PROJECT_ID)
  })

  it('KE-3 属性卡兜底：知识库里无自述行的文件出 OKF 卡；别家标记以标记为准；普通项目里同一份文件不出卡', async () => {
    await kb.expand()
    await kb.setDirOpen('knowledge/notes', true)

    await kb.openRow('knowledge/notes/no-marker.md')
    await kb.waitBody('NO MARKER BODY')
    await card.waitReady()
    const okf = await kb.card()
    expect(okf).not.toBeNull()
    // 兜底出来的标记没有版本 —— 徽章不带「 · v」后缀
    expect(okf!.badge).toBe('OKF entry')
    expect(okf!.selects).toEqual([
      { key: 'type', value: 'Memory' },
      { key: 'status', value: 'draft' }
    ])
    // okf 没有解析器：等异步校验通道回来之后，状态徽章仍隐藏、没有任何语义类
    await sleep(800)
    const settled = await kb.card()
    expect(settled?.status).not.toBeNull()
    expect(settled!.status!.hidden).toBe(true)
    expect(settled!.status!.className).not.toMatch(/is-(ok|warn|err)/)

    // 带别家标记的文件：兜底只给完全没有 shuvix 键的文件，这份按它自己的契约出卡
    await kb.openRow('knowledge/notes/foreign.md')
    await kb.waitBody('FOREIGN BODY')
    await card.waitReady()
    expect((await kb.card())?.badge).toBe('ShuviX agent · v1')

    // 对照：同一份无标记内容放在普通项目的笔记本里 —— 不出卡，frontmatter 原文照常显示。
    // 正文特征串与知识库那份相同，故「切换落定」的信号是原文 YAML 行出现（有卡时它被卡片替掉）
    await sidebar.setGroupExpanded({ project: 'KbProj' }, true)
    expect(await sidebar.openSession('no-marker-copy')).toBe(true)
    await until(
      async () => (await kb.bodyText()).includes('type: Memory'),
      'control notebook shows raw frontmatter'
    )
    await sleep(500)
    expect(await kb.card()).toBeNull()
    const text = await kb.bodyText()
    expect(text).toContain('type: Memory')
    expect(text).toContain('NO MARKER BODY')
  })

  it('KE-4 菜单：组头「新建知识库 / 打开目录 / 刷新」、行「在文件夹中显示 / 复制路径」；复制路径覆盖两个根', async () => {
    await kb.expand()
    // 只读菜单内容：open-folder / reveal 一律不选（见文件头）
    expect(await kb.groupMenuIds()).toEqual(['new-base', 'open-folder', 'refresh'])
    const rowIds = ((await kb.rowMenuShots('knowledge/notes/plain.md')) ?? [])
      .filter((it) => it.id)
      .map((it) => it.id)
    expect(rowIds).toContain('reveal')
    expect(rowIds).toContain('copy-path')

    await captureClipboard()
    // 用户库条目 `knowledge/<库名>/…` 相对用户根
    await kb.pickRowMenu('knowledge/notes/plain.md', 'copy-path')
    expect(await takeCopied()).toBe(join(app.home, '.shuvix', 'knowledge', 'notes', 'plain.md'))
    // 项目库条目 `projects/<id>/…` 相对 knowledge-shuvix 根
    await kb.pickRowMenu(`projects/${projectId}/a.md`, 'copy-path')
    expect(await takeCopied()).toBe(
      join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', projectId, 'a.md')
    )
  })

  it('KE-5 空库一开始就有目录行（默认折叠）；里面出现第一个 md 之后刷新长出条目行', async () => {
    await kb.expand()
    expect((await kb.topDirs()).map((d) => d.path)).toContain('knowledge/empty')
    expect(await kb.dirOpen('knowledge/empty')).toBe(false)
    expect((await kb.rows()).map((r) => r.path)).not.toContain('knowledge/empty/first.md')

    // 磁盘外写入不广播 knowledge.changed —— 走组头菜单的「刷新」
    writeFileSync(join(userRoot, 'empty', 'first.md'), 'FIRST BODY\n')
    await kb.refresh()
    await until(
      async () => (await kb.rows()).some((r) => r.path === 'knowledge/empty/first.md'),
      'knowledge/empty/first.md listed after refresh'
    )
    expect(await kb.dirOpen('knowledge/empty')).toBe(false)
  })

  it('KE-6 目录行菜单：库本身与库里的目录都能往里新建；固定文案的容器不是落点，连 ⋮ 都没有', async () => {
    await kb.expand()

    // 用户库与项目库一视同仁：两处都是「新建条目 / 新建文件夹」
    expect(await dirMenuIds('knowledge/notes')).toEqual(['new-entry', 'new-folder'])
    expect(await dirMenuIds(`projects/${projectId}`)).toEqual(['new-entry', 'new-folder'])
    // `项目` 是固定文案的容器而不是一个库：它没有 ⋮，openMenu 找不到按钮 → null
    expect(await kb.dirMenuShots('projects')).toBeNull()
  })

  it('KE-7 新建知识库：组头菜单 → 就地输名字；Esc 与失焦都取消；Enter 建完宿主自己重扫，不用刷新', async () => {
    await kb.expand()
    const before = (await kb.topDirs()).map((d) => d.path)

    // Esc 取消：什么都不该留下
    await kb.newBase()
    await waitDraft('base')
    await kb.typeDraft('Ghost Base')
    await kb.cancelDraft()
    await until(async () => (await kb.draftKind()) === null, 'draft row closed by Escape')
    expect((await kb.topDirs()).map((d) => d.path)).toEqual(before)

    // 失焦同样取消：点走一下不该凭空多出一个库
    await kb.newBase()
    await waitDraft('base')
    await kb.typeDraft('Ghost Base')
    await kb.blurDraft()
    await until(async () => (await kb.draftKind()) === null, 'draft row closed by blur')
    expect((await kb.topDirs()).map((d) => d.path)).toEqual(before)

    // 正常建一个：Enter 落地，**不调用 kb.refresh()** —— 建完宿主自己重扫
    await kb.newBase()
    await waitDraft('base')
    await kb.typeDraft('Manual Base')
    await kb.submitDraft()
    await until(
      async () => (await kb.topDirs()).some((d) => d.path === 'knowledge/Manual Base'),
      'knowledge/Manual Base listed without a manual refresh'
    )
    expect(await kb.draftKind()).toBeNull()
    // 新库与别的用户库同一个默认态：折叠
    expect(await kb.dirOpen('knowledge/Manual Base')).toBe(false)
  })

  it('KE-8 失败原因回到行里：重名 / 保留名都留住这一行与框里的名字，改一下再回车即可', async () => {
    await kb.expand()
    await kb.newBase()
    await waitDraft('base')
    await kb.typeDraft('Manual Base')
    await kb.submitDraft()

    // 三种语言的这条文案都是 `{{name}}` 插值 —— 断「原因里点得出是哪个名字重了」，不钉本地化原文
    const taken = await until(
      async () => (await kb.draftError()) || null,
      'name-taken error inside the draft row'
    )
    expect(taken).toContain('Manual Base')
    expect(await kb.draftKind()).toBe('base')
    // 名字还在框里：改一下再回车，不用重开一行
    expect(await kb.draftValue()).toBe('Manual Base')

    // 另一条文案：保留名（三种语言都点名 `project`）
    await kb.typeDraft('project')
    await kb.submitDraft()
    const reserved = await until(async () => {
      const err = await kb.draftError()
      return err && err !== taken ? err : null
    }, 'reserved-name error inside the draft row')
    expect(reserved).toContain('project')
    expect(await kb.draftKind()).toBe('base')

    // 改成能用的名字 → Enter → 建出、草稿行与错误一起消失
    await kb.typeDraft('Manual Base 2')
    await kb.submitDraft()
    await until(
      async () => (await kb.topDirs()).some((d) => d.path === 'knowledge/Manual Base 2'),
      'knowledge/Manual Base 2 listed'
    )
    expect(await kb.draftKind()).toBeNull()
    expect(await kb.draftError()).toBeNull()
  })

  it('KE-9 新建条目：行菜单 → 输标题 → Enter；元数据由宿主担保、正文留空，建完立刻打开它的笔记本', async () => {
    await kb.expand()
    await kb.pickDirMenu('knowledge/empty', 'new-entry')
    await waitDraft('entry')
    await kb.typeDraft('Manual Note')
    await kb.submitDraft()

    // (1) 不用手动刷新：文件名按标题 slug 派生，行名是标题
    await until(
      async () => (await kb.rows()).some((r) => r.path === 'knowledge/empty/manual-note.md'),
      'knowledge/empty/manual-note.md listed without a manual refresh'
    )
    expect(await kb.rows()).toEqual(
      expect.arrayContaining([{ path: 'knowledge/empty/manual-note.md', label: 'Manual Note' }])
    )

    // (2) 建完立刻打开它的笔记本：用户库挂 __knowledge_user__，一份文件至多一个会话
    await until(
      async () => (await notesAt(KNOWLEDGE_USER_PROJECT_ID, 'empty/manual-note.md')).length > 0,
      'manual-note.md note session under __knowledge_user__'
    )
    expect(await notesAt(KNOWLEDGE_USER_PROJECT_ID, 'empty/manual-note.md')).toHaveLength(1)
    await until(
      async () => (await kb.activeRow()) === 'knowledge/empty/manual-note.md',
      'manual-note.md row active'
    )

    // (3) 元数据与 knowledge 工具的 create 同一套（自述行在最前、固定键序），正文留空 —— 接着在笔记本里写。
    // 正文经属性卡替换之后不在 .cm-content 里原样可读，故落盘的字节直接比
    expect(readFileSync(join(userRoot, 'empty', 'manual-note.md'), 'utf-8')).toBe(
      '---\nshuvix: okf v0.2\ntype: Memory\ntitle: Manual Note\nstatus: draft\n---\n\n'
    )
    await card.waitReady()
    const shot = await kb.card()
    // 自述行在 → 徽章带版本段（KE-3 里兜底出来的那张没有）
    expect(shot?.badge).toBe('OKF entry · v0.2')
    expect(shot?.selects).toEqual([
      { key: 'type', value: 'Memory' },
      { key: 'status', value: 'draft' }
    ])

    // (4) 草稿行收场
    expect(await kb.draftKind()).toBeNull()
  })

  it('KE-10 内置库那一行：锁 + 自己的图标 + data-knowledge-readonly；项目容器是另一个图标；普通目录仍随展开切开/合文件夹', async () => {
    await kb.expand()

    const byPath = async (path: string): Promise<KnowledgeDirShot> => {
      const hit = (await kb.dirs()).find((d) => d.path === path)
      if (!hit) throw new Error(`no knowledge dir row "${path}"`)
      return hit
    }

    // 普通目录的图标随展开状态变，而前面的用例把 notes 留在展开态 —— 先收回去，
    // 「合上的样子」才是一个确定的基准
    await kb.setDirOpen('knowledge/notes', false)

    const builtin = await byPath(BUILTIN_BASE)
    const projects = await byPath('projects')
    const plain = await byPath('knowledge/notes')

    // 只读标记只挂在内置库这一支上；锁只挂库那一行（里面的层级不重复挂，这里内置库是顶层行）
    expect(builtin.readonly).toBe(true)
    expect(builtin.lock).toBe(true)
    expect([projects.readonly, plain.readonly]).toEqual([false, false])
    expect([projects.lock, plain.lock]).toEqual([false, false])

    // 三种**身份**各一个图标：内置库 / 项目容器 / 普通目录两两不同（比的是「不一样」，不是具体名字）
    expect(builtin.icon).not.toBe(projects.icon)
    expect(builtin.icon).not.toBe(plain.icon)
    expect(projects.icon).not.toBe(plain.icon)
    expect(builtin.icon).not.toBe('')

    // 身份行的图标不随展开变；普通目录照旧一只开合的文件夹
    await kb.setDirOpen(BUILTIN_BASE, true)
    expect((await byPath(BUILTIN_BASE)).icon).toBe(builtin.icon)
    expect((await byPath('projects')).icon).toBe(projects.icon)
    await kb.setDirOpen('knowledge/notes', true)
    const openPlain = (await byPath('knowledge/notes')).icon
    expect(openPlain).not.toBe(plain.icon)
    await kb.setDirOpen('knowledge/notes', false)
    expect((await byPath('knowledge/notes')).icon).toBe(plain.icon)
  })

  it('KE-11 内置库那一行显示本地化的人读名，不是目录名 `shuvix`', async () => {
    await kb.expand()
    const row = (await kb.dirs()).find((d) => d.path === BUILTIN_BASE)
    // 隔离实例跟系统语言走：断的是「是三语里的哪一句」，不钉具体哪门语言
    expect(BUILTIN_NAMES).toContain(row?.label)
    expect(row?.label).not.toBe('shuvix')
  })

  it('KE-12 只读那一支没有目录行菜单（库本身与它里面的每一层都没有 ⋮）；用户库那一行照旧「新建条目 / 新建文件夹」', async () => {
    await kb.expand()
    await kb.setDirOpen(BUILTIN_BASE, true)

    // 泛化成「凡是只读的目录行都没有 ⋮」—— 今天内置库里只有文件没有子目录，
    // 日后长出子目录时这条不用改就仍然成立
    const readonlyDirs = (await kb.dirs()).filter((d) => d.readonly)
    expect(readonlyDirs.map((d) => d.path)).toContain(BUILTIN_BASE)
    for (const dir of readonlyDirs) {
      expect(await kb.dirMenuShots(dir.path), dir.path).toBeNull()
    }
    // 对照组：用户库那一行有
    expect(await dirMenuIds('knowledge/notes')).toEqual(['new-entry', 'new-folder'])
  })

  it('KE-13 内置库的条目行菜单仍有「在文件夹中显示 / 复制路径」；复制的绝对路径走清单的 bundleDirs（内置根 + 语言层），不是两个根拼的', async () => {
    await kb.expand()
    await kb.setDirOpen(BUILTIN_BASE, true)

    const row = await until(
      async () => (await kb.rows()).find((r) => r.path.startsWith(`${BUILTIN_BASE}/`)) ?? null,
      'a builtin knowledge entry row'
    )
    const ids = ((await kb.rowMenuShots(row.path)) ?? []).filter((it) => it.id).map((it) => it.id)
    // 只读只挡「写」：读这一侧的两个动作照旧（reveal 只读不选，见文件头）
    expect(ids).toContain('reveal')
    expect(ids).toContain('copy-path')

    // 宿主随清单下发的绝对目录 —— 它在应用包里、路径里还夹着语言那一层，侧栏靠两个根拼不出来
    const dir = await app.main.eval<string>(
      `window.api.knowledge.list().then((r) => r.bundleDirs?.[${JSON.stringify(BUILTIN_BASE)}] ?? '')`
    )
    expect(dir).not.toBe('')

    await captureClipboard()
    await kb.pickRowMenu(row.path, 'copy-path')
    const copied = await takeCopied()
    expect(copied).toBe(join(dir, row.path.slice(BUILTIN_BASE.length + 1)))
    // 两个用户根都拼不出它：内置库住在应用包里，不在 fake HOME 之下
    expect(copied.startsWith(join(app.home, '.shuvix'))).toBe(false)
  })

  it('KE-14 组头「新建知识库」输入保留名 `shuvix` → 草稿行里显示保留名的失败原因、草稿仍开着', async () => {
    await kb.expand()
    await kb.newBase()
    await waitDraft('base')
    await kb.typeDraft('shuvix')
    await kb.submitDraft()

    // 与 KE-8 的 `project` 同一条文案（三语都是 `{{name}}` 插值）：断得出是哪个名字被保留了
    const err = await until(
      async () => (await kb.draftError()) || null,
      'reserved-name error for "shuvix" inside the draft row'
    )
    expect(err).toContain('shuvix')
    expect(await kb.draftKind()).toBe('base')
    expect(await kb.draftValue()).toBe('shuvix')
    // 没有凭空建出一个用户库
    expect((await kb.topDirs()).map((d) => d.path)).not.toContain('knowledge/shuvix')

    // 收场：草稿行不留给后来的用例（本文件里它是最后一条，仍按惯例收干净）
    await kb.cancelDraft()
    await until(async () => (await kb.draftKind()) === null, 'draft row closed by Escape')
  })
})
