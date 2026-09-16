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
 *
 * 会话归属先走 IPC（`session.list` / `project.list`）；树形与卡片是纯渲染产物，经 pages.ts 的 knowledgePane 读。
 * ⚠️ 组头 `open-folder` 与行 `reveal` 只读不选：隔离实例没有替换 shell，选中会在真实桌面上弹出文件管理器。
 * ⚠️ 用例共用一个实例、按顺序依赖前面的状态（KE-5 往库里写文件，排最后）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import { createProject, registryNoteSessions } from '../../harness/seed'
import {
  fmCardPane,
  knowledgePane,
  sidebarPane,
  type FmCardPane,
  type KnowledgePane,
  type SidebarPane
} from '../../harness/pages'

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

    // 顶层 = Projects 容器（置顶）+ 每个有 md 的用户库，全部零缩进 —— 没有包一层「knowledge」
    const top = await kb.topDirs()
    expect(top[0]?.path).toBe('projects')
    expect(
      top
        .slice(1)
        .map((d) => d.path)
        .sort()
    ).toEqual(['knowledge/empty', 'knowledge/notes', 'knowledge/读书笔记'].sort())

    // 被提掉的用户根容器与隐藏目录：任何层级都不该有目录行。空库有行 —— 那是新建条目的落点
    const dirPaths = (await kb.dirs()).map((d) => d.path)
    expect(dirPaths).not.toContain('knowledge')
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
})
