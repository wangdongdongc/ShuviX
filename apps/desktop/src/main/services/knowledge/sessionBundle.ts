/**
 * 会话 → 知识库：这条会话**启用了哪几个库**，以及工具参数里的 `base` 解析到哪个 bundle。
 *
 * 启用哪些是一条**活的回落链**（不落库、不快照）：
 *   会话设过 → 父会话设过（子会话抄上一级）→ 项目设过 → 缺省「全部用户库 +（属于项目时）项目库」。
 * 与扩展能力勾选（`enabledTools`）的快照语义刻意不同：那一份在创建 Agent 时读死、之后只读，因为
 * 工具表烤进了 pi；知识库是这里每次调用现查的，所以新建一个库、改一次选择，下一次工具调用就作数。
 *
 * 选择是**硬边界**：`bases` 只列启用的，点名没启用的库直接报错并列出启用了哪些。用户自己的库常常
 * 跨领域，一把搜全部不是好事 —— 范围由用户圈定，圈定之后「在选中的库里一起搜」才有意义。
 *
 * 库名按**目录清单**精确匹配（与侧栏、扫描同一份清单，两边归一成 NFC），不拿拼出来的路径去 stat：
 * 大小写不敏感的文件系统上 `Notes` 能 stat 到 `notes/`，id 却成了另一个写法。
 * 保留名 `project` 优先：目录恰好叫 `project` 的用户库够不着工具。
 */
import { KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import type { KnowledgeBaseInfo } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import type { Project } from '../../dao/types/project'
import { bundleDir, projectBundleId, userBundleId } from './knowledgePaths'
import { listUserLibraries } from './scan'

export interface SessionBundleTarget {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>`） */
  bundle: string
  /** bundle 根的绝对路径（项目库的目录可能还不存在） */
  dir: string
  /** 人读标签 */
  label: string
}

/** 配置界面用的一个候选库 */
export interface KnowledgeBaseOption {
  /** 选择里存的名字：用户库的目录名，或保留名 `project` */
  name: string
  /** 人读名：项目库是项目当前的名字（没有项目时为空），用户库就是目录名 */
  label: string
}

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base.'

function rootProject(rootSessionId: string): Project | undefined {
  const picked = sessionDao.pick(rootSessionId, ['projectId'])
  return picked?.projectId ? projectDao.findById(picked.projectId) : undefined
}

/** 工具可点名的用户库名（保留名 `project` 的同名目录除外） */
function userBaseNames(): string[] {
  return listUserLibraries().filter((name) => name !== KNOWLEDGE_PROJECT_BASE)
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
 * 这条会话启用了哪几个库（回落链，见文件头）。缺省是「全部用户库 +（属于项目时）项目库」——
 * 用户建了库就用得上，不必先去勾一遍；项目库排在后面：它还在，但不再是主角。
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

  // `project` 只跟着**会话自己**的项目：sessionBundle 也只看这一列，两处必须同口径，
  // 否则缺省里会出现一个解析不出来的名字
  return [...userBaseNames(), ...(row?.projectId ? [KNOWLEDGE_PROJECT_BASE] : [])]
}

/** 本会话所属项目的库（目录可能还不存在 —— 那就是一个空库） */
export function sessionBundle(rootSessionId: string): SessionBundleTarget | { error: string } {
  const project = rootProject(rootSessionId)
  if (!project) return { error: NO_PROJECT }
  const bundle = projectBundleId(project.id)
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}

/** 启用了哪些库、这台机器上又真的有哪些 —— 两者的交集才是这条会话能点名的 */
function enabledTargets(rootSessionId: string): { name: string; target: SessionBundleTarget }[] {
  const selected = selectedBaseNames(rootSessionId)
  const names = userBaseNames()
  const out: { name: string; target: SessionBundleTarget }[] = []
  for (const wanted of selected) {
    if (wanted === KNOWLEDGE_PROJECT_BASE) {
      const target = sessionBundle(rootSessionId)
      if (!('error' in target)) out.push({ name: wanted, target })
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
 * —— 与工具解析同一份结果，不再各过滤一遍），项目库带上项目当前的名字。
 */
export function enabledBaseChoices(rootSessionId: string): KnowledgeBaseOption[] {
  const projectName = rootProject(rootSessionId)?.name ?? ''
  return enabledTargets(rootSessionId).map(({ name }) => ({
    name,
    label: name === KNOWLEDGE_PROJECT_BASE ? projectName : ''
  }))
}

/** 本会话启用且此刻真的在的库（工具 `bases` 的回包） */
export async function listBases(rootSessionId: string): Promise<KnowledgeBaseInfo[]> {
  return enabledTargets(rootSessionId).map(({ name, target }) => ({
    base: name,
    label: target.label,
    dir: target.dir
  }))
}

/**
 * 配置界面的候选项与此刻生效的选择。`explicit` 为假表示这条会话（及其项目）从没设过 ——
 * 界面上勾的是回落出来的缺省，用户一改就落成这条会话自己的。
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
  const options = [...userBaseNames().map((name) => ({ name, label: name })), ...projectOption]
  if (!rootSessionId) return { options, selected: [], explicit: false }

  // 「有人明确设过」要走完整条回落链 —— 漏掉父会话那一级，子会话就会显示成「还没选过」
  const row = sessionDao.pick(rootSessionId, ['projectId', 'parentId', 'settings'])
  const parent = row?.parentId ? sessionDao.pick(row.parentId, ['projectId', 'settings']) : undefined
  const explicit =
    Array.isArray(row?.settings?.knowledgeBases) ||
    Array.isArray(parent?.settings?.knowledgeBases) ||
    !!projectSelection(row?.projectId ?? parent?.projectId ?? null)
  return { options, selected: selectedBaseNames(rootSessionId), explicit }
}
