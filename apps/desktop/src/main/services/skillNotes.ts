/**
 * 技能笔记 —— 点侧栏「技能」分组里的一行，打开的是那个技能目录里的 `SKILL.md`，与 bot / agent
 * 档案、知识库条目同一条路：一份文件至多一条笔记本会话，重复打开复用，编辑与自动保存全归笔记本。
 *
 * 与注册表笔记（registryNotes）分开写，因为技能的承载项目不是一张写死的表：
 *   - 默认目录与内置目录各一个固定 id；
 *   - **外部目录数量不定、路径任意**，承载项目按目录名现拼（`__skills:<name>__`），
 *     目录被移除时连同它的承载项目与笔记会话一并清掉 —— 留着就是一堆指向不存在目录的会话。
 * 内置目录的 path 随界面语言变（`Resources/skills/<lang>/`），与内置知识库同策：
 * 切语言时把那一行改指到新语言的目录上（`syncSkillBuiltinProject`）。
 *
 * notebookPath 是「技能目录名 + /SKILL.md」——一个技能是目录而不是单文件，伴随文件
 * （`references/…`）就在旁边，笔记本的工作目录正好是承载根，双链与内嵌图片按相对路径解析。
 */
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import {
  SKILL_BUILTIN_PROJECT_ID,
  SKILL_DEFAULT_PROJECT_ID,
  isSkillProjectId,
  skillExternalProjectId,
  skillNotebookPath
} from '@shuvix/chat-protocol/skillNotes'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import { skillService } from './skillService'
import { getBuiltinSkillsDir, getDefaultSkillsDir } from '../utils/paths'
import type { Project, SessionInfo, Skill } from '../types'

/** 承载项目的名字不对用户露出（项目列表过滤掉了），只在日志与调试里认得出是谁 */
function carrierName(skill: Skill): string {
  if (skill.source === 'builtin') return 'Builtin Skills'
  if (skill.source === 'external') return `Skills: ${skill.dirName}`
  return 'Skills'
}

/** 这个技能的承载项目 id + 根目录（根决定 notebookPath 相对谁解析） */
function carrierOf(skill: Skill): { id: string; root: string } | null {
  if (skill.source === 'builtin')
    return { id: SKILL_BUILTIN_PROJECT_ID, root: getBuiltinSkillsDir() }
  if (skill.source === 'default')
    return { id: SKILL_DEFAULT_PROJECT_ID, root: getDefaultSkillsDir() }
  if (skill.source === 'external' && skill.dirName) {
    const dir = skillService.listExternalDirs().find((d) => d.name === skill.dirName)
    return dir ? { id: skillExternalProjectId(dir.name), root: dir.path } : null
  }
  // 项目级技能不进侧栏（它随当前会话的项目变，而这一组是全局的）
  return null
}

/**
 * 技能在磁盘上的目录名 —— 取 `basePath` 的最后一段，**不要从 `skill.name` 切**。
 *
 * 一个技能的 `name` 来自 SKILL.md frontmatter 的 `name`（解析不出才回落到目录名，见
 * skillService.loadSkillFromDir），所以目录叫 `my-dir`、frontmatter 写 `name: other` 时两者
 * 并不相等 —— 按名字拼路径会拼出一个不存在的文件，点开毫无反应。`basePath` 才是扫描时
 * 记下的那个真目录。
 */
function skillDirName(skill: Skill): string {
  return basename(skill.basePath)
}

/** 确保某个承载项目存在并与当前根目录一致；不发 project.changed —— 列表不可见 */
function ensureCarrier(id: string, name: string, root: string): Project {
  const existing = projectDao.findById(id)
  if (existing) {
    // 容错：历史行的 path / name 与当前值不一致时纠正（home 迁移、内置目录随语言切换）
    const patch: Partial<Pick<Project, 'name' | 'path'>> = {}
    if (existing.path !== root) patch.path = root
    if (existing.name !== name) patch.name = name
    if (Object.keys(patch).length === 0) return existing
    projectDao.update(id, patch)
    return { ...existing, ...patch }
  }
  const now = Date.now()
  const project: Project = {
    id,
    name,
    path: root,
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: now,
    updatedAt: now
  }
  projectDao.insert(project)
  return project
}

/**
 * 打开 / 复用一个技能的 `SKILL.md` 笔记本（main 单线程 + 同步 SQLite，查建原子）。
 *
 * `name` 来自渲染进程，按不可信入参处理：只接受**当前注册表里真的有**的技能，并再确认那份
 * SKILL.md 确实存在 —— 技能目录可能刚被删掉，清单是上一轮扫描的。
 */
export function openSkillNote(name: string, title?: string): SessionInfo {
  const skill = skillService.findByName(name)
  if (!skill) throw new Error(`Skill "${name}" not found`)
  const carrier = carrierOf(skill)
  if (!carrier) throw new Error(`Skill "${name}" has no notebook carrier`)

  const notebookPath = skillNotebookPath(skillDirName(skill))
  const filePath = join(carrier.root, notebookPath)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Skill file not found: ${notebookPath}`)
  }

  const project = ensureCarrier(carrier.id, carrierName(skill), carrier.root)
  const session =
    sessionDao.findByProjectAndNotebookPath(project.id, notebookPath) ??
    sessionService.create({
      projectId: project.id,
      notebookPath,
      title: title?.trim() || skillDirName(skill)
    })
  return { ...session, workingDirectory: project.path }
}

/**
 * 内置技能目录随界面语言换一版（`Resources/skills/<lang>/`）——把承载项目的 path 指到新语言
 * 那一版上。技能目录名各语言相同，所以已经开着的笔记 notebookPath 不变，读到的就是新语言的
 * 那份文件（与内置知识库同策）。
 */
export function syncSkillBuiltinProject(): void {
  if (!projectDao.findById(SKILL_BUILTIN_PROJECT_ID)) return
  ensureCarrier(SKILL_BUILTIN_PROJECT_ID, 'Builtin Skills', getBuiltinSkillsDir())
}

/**
 * 删掉一个外部技能目录的承载项目与它下面的笔记会话 —— 目录都移除了，那些会话指向的文件
 * 已经与本应用无关。默认目录与内置目录的承载项目从不删（它们恒存在）。
 */
export async function dropExternalSkillCarrier(dirName: string): Promise<void> {
  const id = skillExternalProjectId(dirName)
  if (!projectDao.findById(id)) return
  for (const session of sessionDao.findByProjectId(id)) await sessionService.delete(session.id)
  projectDao.deleteById(id)
}

export { isSkillProjectId }
