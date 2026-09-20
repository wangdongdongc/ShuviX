/**
 * 会话 → 知识库：这条会话**启用了哪几个库**，以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * 启用哪些是一条**活的回落链**（不落库、不快照）：
 *   会话设过 → 父会话设过（子会话抄上一级）→ 项目设过 → 缺省**一个都不启用**。
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
 */
import { existsSync } from 'fs'
import { KNOWLEDGE_BUILTIN_BASE, KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import type { KnowledgeBaseInfo } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
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
  /** 只读（内置库）：工具的 `create` 拒绝、侧栏没有新建、写钩子与变更管线绕开 */
  readonly?: boolean
}

/** 配置界面用的一个候选库 */
export interface KnowledgeBaseOption {
  /** 选择里存的名字：用户库的目录名，或保留名 `project` / `shuvix` */
  name: string
  /** 人读名：项目库是项目当前的名字（没有项目时为空），用户库就是目录名，内置库是产品名 */
  label: string
}

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base.'

/** 保留名：工具里优先于同名用户库 */
const RESERVED_BASE_NAMES: readonly string[] = [KNOWLEDGE_PROJECT_BASE, KNOWLEDGE_BUILTIN_BASE]

/**
 * 内置库在 `<knowledge_bases>` 围栏里的一句说明（英文：那是提示词）。要说清两件事 —— 里面是什么
 * （模型才知道什么问题该来这里查）、只读（免得它把笔记往这里记）。不含斜杠与数字：围栏承诺不带
 * 路径与计数，e2e 就是拿这两个字符判的。
 */
const BUILTIN_GUIDE_LABEL =
  "ShuviX's own reference (read-only): how its agent, bot, policy and hook files, knowledge entries and skills are written, and where they live"

function rootProject(rootSessionId: string): Project | undefined {
  const picked = sessionDao.pick(rootSessionId, ['projectId'])
  return picked?.projectId ? projectDao.findById(picked.projectId) : undefined
}

/** 工具可点名的用户库名（与保留名同名的目录除外） */
function userBaseNames(): string[] {
  return listUserLibraries().filter((name) => !RESERVED_BASE_NAMES.includes(name))
}

/** 去空白、去空、去重；不过滤「此刻存不存在」—— 库改了名也留在选择里，用的时候才发现 */
function sanitize(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))]
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

/**
 * 这条会话启用了哪几个库（回落链，见文件头）。
 *
 * **缺省是空的**（2026-09-17 裁决）：谁都没设过 = 一个库都不启用，围栏整个不注入，工具答「本会话没有
 * 启用任何知识库」。此前缺省是「全部用户库 + 项目库 + 内置库」，理由是「建了库就用得上，不必先去勾
 * 一遍」；实际用下来相反 —— 新会话开箱就把用户所有库（常常跨领域）摊给 agent，搜出来的多是无关条目。
 * 范围由用户圈定才有意义，所以改成显式勾选，内置的说明书也不例外。
 */
export function selectedBaseNames(rootSessionId: string): string[] {
  const row = sessionDao.pick(rootSessionId, ['projectId', 'parentId', 'settings'])
  const own = row?.settings?.knowledgeBases
  if (Array.isArray(own)) return sanitize(own)

  const parent = row?.parentId
    ? sessionDao.pick(row.parentId, ['projectId', 'settings'])
    : undefined
  const fromParent = parent?.settings?.knowledgeBases
  if (Array.isArray(fromParent)) return sanitize(fromParent)

  const fromProject = projectSelection(row?.projectId ?? parent?.projectId ?? null)
  if (fromProject) return fromProject

  return []
}

/** 本会话所属项目的库（目录可能还不存在 —— 那就是一个空库） */
export function sessionBundle(rootSessionId: string): SessionBundleTarget | { error: string } {
  const project = rootProject(rootSessionId)
  if (!project) return { error: NO_PROJECT }
  const bundle = projectBundleId(project.id)
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}

/** 启用了哪些库、这台机器上又真的有哪些 —— 两者的交集才是这条会话能点名的 */
export function enabledTargets(
  rootSessionId: string
): { name: string; target: SessionBundleTarget }[] {
  const selected = selectedBaseNames(rootSessionId)
  const names = userBaseNames()
  const out: { name: string; target: SessionBundleTarget }[] = []
  for (const wanted of selected) {
    if (wanted === KNOWLEDGE_PROJECT_BASE) {
      const target = sessionBundle(rootSessionId)
      if (!('error' in target)) out.push({ name: wanted, target })
      continue
    }
    if (wanted === KNOWLEDGE_BUILTIN_BASE) {
      const target = builtinTarget()
      if (target) out.push({ name: wanted, target })
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
 */
export function enabledBaseChoices(rootSessionId: string): KnowledgeBaseOption[] {
  const projectName = rootProject(rootSessionId)?.name ?? ''
  return enabledTargets(rootSessionId).map(({ name }) => ({
    name,
    label:
      name === KNOWLEDGE_PROJECT_BASE
        ? projectName
        : name === KNOWLEDGE_BUILTIN_BASE
          ? BUILTIN_GUIDE_LABEL
          : ''
  }))
}

/** 本会话启用且此刻真的在的库（工具 `bases` 的回包） */
export async function listBases(rootSessionId: string): Promise<KnowledgeBaseInfo[]> {
  return enabledTargets(rootSessionId).map(({ name, target }) => ({
    base: name,
    label: target.label,
    dir: target.dir,
    ...(target.readonly ? { note: 'read-only: search and read it, never create or edit here' } : {})
  }))
}

/**
 * 配置界面的候选项与此刻生效的选择。`explicit` 为假表示这条会话（及其项目）从没设过 —— 缺省是空的，
 * 所以界面上一个也没勾；用户一勾就落成这条会话自己的。
 */
export function knowledgeBaseOptions(rootSessionId?: string): {
  options: KnowledgeBaseOption[]
  selected: string[]
  explicit: boolean
} {
  const project = rootSessionId ? rootProject(rootSessionId) : undefined
  // 没给会话（项目配置对话框）时也给项目库这一项：那里配的正是「这个项目的新会话缺省用哪些」
  const projectOption: KnowledgeBaseOption[] =
    !rootSessionId || project ? [{ name: KNOWLEDGE_PROJECT_BASE, label: project?.name ?? '' }] : []
  // 内置库垫底：它是说明书，不是用户的内容；目录不在（资源没发到位）就不给这一项
  const builtinOption: KnowledgeBaseOption[] = builtinTarget()
    ? [{ name: KNOWLEDGE_BUILTIN_BASE, label: builtinBaseDisplayName() }]
    : []
  const options = [
    ...userBaseNames().map((name) => ({ name, label: name })),
    ...projectOption,
    ...builtinOption
  ]
  if (!rootSessionId) return { options, selected: [], explicit: false }

  // 「有人明确设过」要走完整条回落链 —— 漏掉父会话那一级，子会话就会显示成「还没选过」
  const row = sessionDao.pick(rootSessionId, ['projectId', 'parentId', 'settings'])
  const parent = row?.parentId
    ? sessionDao.pick(row.parentId, ['projectId', 'settings'])
    : undefined
  const explicit =
    Array.isArray(row?.settings?.knowledgeBases) ||
    Array.isArray(parent?.settings?.knowledgeBases) ||
    !!projectSelection(row?.projectId ?? parent?.projectId ?? null)
  return { options, selected: selectedBaseNames(rootSessionId), explicit }
}
