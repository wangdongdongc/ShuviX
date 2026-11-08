/**
 * 会话 → 知识库：这条会话**启用了哪几个库**，以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * **项目库是隐式的**（2026-10-10 裁决，接替退役的项目记忆）：会话（根会话）属于项目，`project` 就恒
 * 启用、排在最前，不进选择、不是界面上的候选项 —— 它是「这个项目学到了什么」的唯一去处，不该还要
 * 用户先勾一下。存量选择里残留的 `project` 读时剔掉（有项目时它本来就在，没项目时它解析不出来）。
 *
 * 其余的库由用户圈定，是一条**活的回落链**（不落库、不快照）：
 *   会话设过 → 父会话设过（子会话抄上一级）→ 项目设过 → 缺省**只启用内置说明书**。
 * 与扩展能力勾选（`enabledTools`）的快照语义刻意不同：那一份在创建 Agent 时读死、之后只读，因为
 * 工具表烤进了 pi；知识库是这里每次调用现查的，所以新建一个库、改一次选择，下一次工具调用就作数。
 *
 * 选择是**硬边界**：`bases` 只列启用的，点名没启用的库直接报错并列出启用了哪些。用户自己的库常常
 * 跨领域，一把搜全部不是好事 —— 范围由用户圈定，圈定之后「在选中的库里一起搜」才有意义。
 *
 * 库名按**目录清单**精确匹配（与侧栏、扫描同一份清单，两边归一成 NFC），不拿拼出来的路径去 stat：
 * 大小写不敏感的文件系统上 `Notes` 能 stat 到 `notes/`，id 却成了另一个写法。
 * 两个保留名优先：`project` 是本会话所属项目的库，`shuvix` 是随应用发布的内置库（只读）——
 * 目录恰好叫这两个名字的用户库够不着工具。
 *
 * **内置说明书对 ShuviX 文件的笔记本也是隐式的**（2026-10-30）：文档是安全策略、hook、智能体档案、bot、
 * 技能或知识库条目的笔记本会话（按承载项目判，chat-protocol `shuvixFileKindOfProject`），`shuvix` 恒启用、
 * 排在用户圈定的库之前。笔记本 agent 的提示词告诉它这份文件的规范在说明书哪一条 —— 不给这个库，它就
 * 只能靠 `read` 那一篇，搜不到策略问题常常牵到的另几条（远程访问、自动脱敏）。这类会话没有配置面板
 * 可勾，和项目库一样不归选择管。
 */
import { existsSync } from 'fs'
import { projectContextIdOf } from '@shuvix/chat-protocol/botSession'
import { KNOWLEDGE_BUILTIN_BASE, KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import { shuvixFileKindOfProject } from '@shuvix/chat-protocol/shuvixFileNotes'
import type { KnowledgeBaseInfo, KnowledgeGuideBase } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionRecords } from '../sessionRecords'
import type { Project } from '../../dao/types/project'
import {
  builtinBaseDisplayName,
  builtinBundleId,
  bundleDir,
  projectBundleId,
  userBundleId
} from './knowledgePaths'
import { listUserLibraries } from './scan'

export interface SessionBundleTarget {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>` / `builtin/<库名>`） */
  bundle: string
  /** bundle 根的绝对路径（项目库的目录可能还不存在） */
  dir: string
  /** 人读标签 */
  label: string
  /** 只读（内置库）：工具的 `submit` 拒绝、侧栏没有新建、写钩子与变更管线绕开 */
  readonly?: boolean
}

/** 配置界面用的一个候选库 */
export interface KnowledgeBaseOption {
  /** 库名：用户库的目录名，或保留名 `project` / `shuvix`（界面候选项里没有 `project`） */
  name: string
  /** 人读名：项目库是项目当前的名字，用户库就是目录名，内置库是产品名 */
  label: string
}

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base.'

/** 保留名：工具里优先于同名用户库 */
const RESERVED_BASE_NAMES: readonly string[] = [KNOWLEDGE_PROJECT_BASE, KNOWLEDGE_BUILTIN_BASE]

/** 内置库在 `<knowledge_bases>` 围栏里的那一行（英文：那是提示词）：只读，免得它把笔记往这里记 */
const BUILTIN_GUIDE_LABEL = "ShuviX's own manual (read-only)"

/**
 * 内置库在围栏里的说明：什么时候来这里、读哪一篇（经 `knowledge` 的 `read`，按条目名 —— 2026-11-08 起不给库目录）、
 * 别去哪里。
 *
 * 实测（2026-11-02，`e2e/live/botKnowledge.probe.ts`）：不知道说明书的 agent 替用户新建 bot 时会列主目录和
 * `~/.shuvix`，再顺着技能的路径进应用包反推格式和枚举值，每一步都惊动一次权限审查。只指路，不贴内容（`policy-md`
 * 一篇就 50 KB）。
 */
const BUILTIN_GUIDE_NOTE =
  "When a task touches ShuviX itself — creating, changing or explaining a bot, agent, security policy, hook or skill — first `read` the spec in `shuvix` with the `knowledge` tool: `/bot-md.md`, `/agent-md.md`, `/policy-md.md`, `/hook-md.md`, `/skills.md` (overview: `/shuvix-files.md`). ShuviX's own files live under `~/.shuvix/`, where every read or write goes through a permission check, so don't list that folder or the home folder to learn the layout, and don't look inside the app package: the manual has the paths, formats and values."

/**
 * 会话所属的项目（bot 会话：它引用的工作项目 —— 它不是项目的成员，项目知识库照样跟着项目来）。隐藏载体项目
 * （`__agents__` / `__knowledge__` …，侧栏打开 md 时挂的壳）不算：它们没有「这个项目学到了什么」可言，否则每个
 * 笔记本会话都会凭空多出一个隐式项目库
 */
function rootProject(rootSessionId: string): Project | undefined {
  const projectId = projectContextIdOf(
    sessionRecords.pick(rootSessionId, ['projectId', 'settings'])
  )
  return projectId && !isHiddenProjectId(projectId) ? projectDao.findById(projectId) : undefined
}

/** 工具可点名的用户库名（与保留名同名的目录除外） */
function userBaseNames(): string[] {
  return listUserLibraries().filter((name) => !RESERVED_BASE_NAMES.includes(name))
}

/**
 * 去空白、去空、去重、剔掉 `project`（项目库是隐式的，不归选择管）；不过滤「此刻存不存在」——
 * 库改了名也留在选择里，用的时候才发现
 */
function sanitize(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n && n !== KNOWLEDGE_PROJECT_BASE))]
}

const nfc = (s: string): string => s.normalize('NFC')

/** 项目设过的那份；没设过返回 null */
function projectSelection(projectId: string | null | undefined): string[] | null {
  if (!projectId) return null
  const saved = projectDao.pick(projectId, ['settings'])?.settings?.knowledgeBases
  return Array.isArray(saved) ? sanitize(saved) : null
}

/**
 * 内置库（随应用发布，只读）。目录不在就当没有这个库 —— 开发期没拷资源、打包漏了，都不该让别的库跟着
 * 出错；语言那一层由 bundleDir 按界面语言现算。
 */
function builtinTarget(): SessionBundleTarget | null {
  const bundle = builtinBundleId(KNOWLEDGE_BUILTIN_BASE)
  const dir = bundleDir(bundle)
  if (!existsSync(dir)) return null
  return { bundle, dir, label: 'ShuviX reference (read-only)', readonly: true }
}

/** 内置说明书当前语言那一版的目录；这台机器上没有（开发期没拷资源）→ null */
export function builtinManualDir(): string | null {
  return builtinTarget()?.dir ?? null
}

/**
 * 用户为这条会话圈定的库（回落链，见文件头；不含隐式的项目库）。
 *
 * **谁都没设过时只启用内置说明书**（2026-11-02 裁决）。用户自己的库仍然一个都不默认启用（2026-09-17：
 * 新会话开箱就把用户所有库 —— 常常跨领域 —— 摊给 agent，搜出来的多是无关条目）；说明书不同，它讲的是 ShuviX
 * 自己，条目少、不跨领域，而不知道它的 agent 只能去翻 `~/.shuvix` 和应用包。显式的空列表仍然是「这条会话不用
 * 知识库」。这是活的回落链，所以从没选过的存量会话也一样。
 */
export function selectedBaseNames(rootSessionId: string): string[] {
  const row = sessionRecords.pick(rootSessionId, ['projectId', 'parentId', 'settings'])
  const own = row?.settings?.knowledgeBases
  if (Array.isArray(own)) return sanitize(own)

  const parent = row?.parentId
    ? sessionRecords.pick(row.parentId, ['projectId', 'settings'])
    : undefined
  const fromParent = parent?.settings?.knowledgeBases
  if (Array.isArray(fromParent)) return sanitize(fromParent)

  const fromProject = projectSelection(projectContextIdOf(row) ?? projectContextIdOf(parent))
  if (fromProject) return fromProject

  return [KNOWLEDGE_BUILTIN_BASE]
}

/** 本会话所属项目的库（目录可能还不存在 —— 那就是一个空库） */
export function sessionBundle(rootSessionId: string): SessionBundleTarget | { error: string } {
  const project = rootProject(rootSessionId)
  if (!project) return { error: NO_PROJECT }
  const bundle = projectBundleId(project.id)
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}

/**
 * 这条会话能点名的库：有项目时项目库打头，ShuviX 文件的笔记本带上内置说明书（两者都隐式，见文件头），
 * 再接用户圈定且这台机器上真有的那些
 */
export function enabledTargets(
  rootSessionId: string
): { name: string; target: SessionBundleTarget }[] {
  const out: { name: string; target: SessionBundleTarget }[] = []
  const project = sessionBundle(rootSessionId)
  if (!('error' in project)) out.push({ name: KNOWLEDGE_PROJECT_BASE, target: project })

  // 隐式的说明书与用户勾的那份是同一个库：先到的占位，后面的不再重复
  const pushBuiltin = (): void => {
    if (out.some((e) => e.name === KNOWLEDGE_BUILTIN_BASE)) return
    const target = builtinTarget()
    if (target) out.push({ name: KNOWLEDGE_BUILTIN_BASE, target })
  }
  const projectId = sessionRecords.pick(rootSessionId, ['projectId'])?.projectId
  if (shuvixFileKindOfProject(projectId)) pushBuiltin()

  const selected = selectedBaseNames(rootSessionId)
  const names = userBaseNames()
  for (const wanted of selected) {
    if (wanted === KNOWLEDGE_BUILTIN_BASE) {
      pushBuiltin()
      continue
    }
    const match = names.find((n) => nfc(n) === nfc(wanted))
    if (!match) continue
    const bundle = userBundleId(match)
    out.push({
      name: match,
      target: { bundle, dir: bundleDir(bundle), label: `knowledge base "${match}"` }
    })
  }
  return out
}

/** 解析工具参数里的 base —— 只认这条会话启用了的库 */
export async function resolveBase(
  rootSessionId: string,
  base: string
): Promise<SessionBundleTarget | { error: string }> {
  const name = base.trim()
  const enabled = enabledTargets(rootSessionId)
  const hit = enabled.find((e) => nfc(e.name) === nfc(name))
  if (hit) return hit.target
  // 项目库恒启用，点不中只可能是会话不属于项目 —— 直说原因，别让它以为是用户没勾
  if (name === KNOWLEDGE_PROJECT_BASE) return { error: NO_PROJECT }

  if (enabled.length === 0) {
    return {
      error:
        'No knowledge base is enabled for this session — the user picks which bases a session uses in its settings.'
    }
  }
  const known = enabled.map((e) => `"${e.name}"`).join(', ')
  return {
    error: `"${name}" is not one of this session's knowledge bases. Enabled: ${known}.`
  }
}

/**
 * 围栏要列的库：启用且此刻真在的那些。名字用磁盘上的拼写（NFC 归一在 enabledTargets 里做掉了
 * —— 与工具解析同一份结果，不再各过滤一遍），项目库带上项目当前的名字，内置库带一句它是什么。
 * **不带目录**（2026-11-08）：库目录只有知识库管理员知道，别的 agent 按库名 + 条目名经 `knowledge` 读、交。
 */
export function enabledBaseChoices(rootSessionId: string): KnowledgeGuideBase[] {
  const projectName = rootProject(rootSessionId)?.name ?? ''
  return enabledTargets(rootSessionId).map(({ name, target }) => ({
    name,
    readonly: target.readonly,
    note: name === KNOWLEDGE_BUILTIN_BASE ? BUILTIN_GUIDE_NOTE : undefined,
    label:
      name === KNOWLEDGE_PROJECT_BASE
        ? projectName
        : name === KNOWLEDGE_BUILTIN_BASE
          ? BUILTIN_GUIDE_LABEL
          : ''
  }))
}

/** 本会话启用且此刻真的在的库（工具 `bases` 的回包；`dir` 只印给知识库管理员） */
export async function listBases(rootSessionId: string): Promise<KnowledgeBaseInfo[]> {
  return enabledTargets(rootSessionId).map(({ name, target }) => ({
    base: name,
    label: target.label,
    dir: target.dir,
    ...(target.readonly
      ? { note: 'read-only: search and read it; nothing can be submitted here' }
      : {})
  }))
}

/**
 * 配置界面的候选项与此刻生效的选择。`explicit` 为假表示这条会话（及其项目）从没设过 —— 缺省只启用内置
 * 说明书，所以界面上只勾着它；用户一改就落成这条会话自己的。项目库不是候选项：有项目就恒启用（见文件头）。
 * ShuviX 文件笔记本里的说明书同理：它在那里恒启用，列成一个没勾的选项只会让人以为它关着、勾了也没用。
 */
export function knowledgeBaseOptions(rootSessionId?: string): {
  options: KnowledgeBaseOption[]
  selected: string[]
  explicit: boolean
} {
  // 内置库垫底：它是说明书，不是用户的内容；目录不在（资源没发到位）就不给这一项
  const builtinOption: KnowledgeBaseOption[] = builtinTarget()
    ? [{ name: KNOWLEDGE_BUILTIN_BASE, label: builtinBaseDisplayName() }]
    : []
  const userOptions = userBaseNames().map((name) => ({ name, label: name }))
  if (!rootSessionId)
    return {
      options: [...userOptions, ...builtinOption],
      selected: builtinOption.map((o) => o.name),
      explicit: false
    }
  const row = sessionRecords.pick(rootSessionId, ['projectId', 'parentId', 'settings'])
  const options = shuvixFileKindOfProject(row?.projectId)
    ? userOptions
    : [...userOptions, ...builtinOption]

  // 「有人明确设过」要走完整条回落链 —— 漏掉父会话那一级，子会话就会显示成「还没选过」
  const parent = row?.parentId
    ? sessionRecords.pick(row.parentId, ['projectId', 'settings'])
    : undefined
  const explicit =
    Array.isArray(row?.settings?.knowledgeBases) ||
    Array.isArray(parent?.settings?.knowledgeBases) ||
    !!projectSelection(projectContextIdOf(row) ?? projectContextIdOf(parent))
  return { options, selected: selectedBaseNames(rootSessionId), explicit }
}
