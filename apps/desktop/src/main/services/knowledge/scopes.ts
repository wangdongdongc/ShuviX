/**
 * 会话 → 作用域（设计 §3 / §5 scopes.ts）。
 *
 * 一个根会话的作用域：`global` 恒有；有项目 → `projects/<slug>`（目录按 project.md 的
 * `resource` 绑定查找，不存在时**不建** —— 首次写入才建）；bot 会话 → `bots/<name>`；
 * 会话摘要住在项目的 `sessions/`（无项目则顶层 `sessions/`），按 `shuvix://session/<id>` upsert。
 *
 * 目录名是 slug（人可读，允许 Unicode），绑定真源是目录里的绑定概念（决策 D2）：
 * 项目改名只改 project.md 的 title，目录不动。
 */
import { existsSync, readdirSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import {
  BOT_CONCEPT_FILE,
  KNOWLEDGE_DIRS,
  PROJECT_CONCEPT_FILE,
  botResource,
  projectResource,
  sessionResource,
  type KnowledgeScopeKind
} from '@shuvix/chat-protocol/knowledge'
import { buildConceptText, slugify, type KnowledgeScopeTarget } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import type { Project } from '../../dao/types/project'
import { recordKnowledgeChange } from './changes'
import { fromBundlePath } from './knowledgePaths'
import { HOST_ACTOR, ensureKnowledgeRoot } from './root'
import { findBotDir, findProjectDir, invalidateKnowledgeScan } from './scan'

export interface SessionKnowledgeContext {
  project: Project | null
  /** `projects/<slug>`；项目尚无作用域目录为 null */
  projectDir: string | null
  bot: string | null
  /** `bots/<name>`；尚无为 null */
  botDir: string | null
}

/** 根会话的知识库上下文（只读；不建目录） */
export async function sessionKnowledgeContext(
  rootSessionId: string
): Promise<SessionKnowledgeContext> {
  const picked = sessionDao.pick(rootSessionId, ['projectId', 'settings'])
  const project = picked?.projectId ? (projectDao.findById(picked.projectId) ?? null) : null
  const bot = picked?.settings?.bot?.trim() || null
  return {
    project,
    projectDir: project ? await findProjectDir(project.id) : null,
    bot,
    botDir: bot ? await findBotDir(bot) : null
  }
}

/** 已被占用的子目录名（slug 去重用） */
function takenDirNames(parent: string): Set<string> {
  try {
    return new Set(
      readdirSync(fromBundlePath(parent), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    )
  } catch {
    return new Set()
  }
}

function uniqueSlug(parent: string, base: string): string {
  const taken = takenDirNames(parent)
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/** 建项目作用域目录 + 绑定概念 project.md（宿主署名）；已存在则原样返回 */
export async function ensureProjectScope(project: Project): Promise<string> {
  await ensureKnowledgeRoot()
  const existing = await findProjectDir(project.id)
  if (existing) return existing
  const dir = `${KNOWLEDGE_DIRS.projects}/${uniqueSlug(KNOWLEDGE_DIRS.projects, slugify(project.name, 'project'))}`
  await mkdir(fromBundlePath(dir), { recursive: true })
  const rel = `${dir}/${PROJECT_CONCEPT_FILE}`
  const text = buildConceptText(
    {
      type: 'Project',
      title: project.name,
      description: `Binds this directory to the ShuviX project "${project.name}" — its memory lives here.`,
      resource: projectResource(project.id),
      status: 'stable',
      sources: [{ resource: project.path, title: 'project root' }],
      generated: { by: HOST_ACTOR, at: new Date().toISOString() }
    },
    `Project memory for **${project.name}** (\`${project.path}\`). Entries in this directory are read by every session of that project; \`sessions/\` holds its session summaries.`
  )
  await writeFile(fromBundlePath(rel), text, 'utf-8')
  invalidateKnowledgeScan(rel)
  recordKnowledgeChange({ path: rel, op: 'Creation', title: project.name, actor: HOST_ACTOR })
  return dir
}

/** 建 bot 作用域目录 + 绑定概念 bot.md；已存在则原样返回 */
export async function ensureBotScope(botName: string): Promise<string> {
  await ensureKnowledgeRoot()
  const existing = await findBotDir(botName)
  if (existing) return existing
  const dir = `${KNOWLEDGE_DIRS.bots}/${uniqueSlug(KNOWLEDGE_DIRS.bots, slugify(botName, 'bot'))}`
  await mkdir(fromBundlePath(dir), { recursive: true })
  const rel = `${dir}/${BOT_CONCEPT_FILE}`
  const text = buildConceptText(
    {
      type: 'Bot',
      title: botName,
      description: `Binds this directory to the bot "${botName}" — what it has learned lives here.`,
      resource: botResource(botName),
      status: 'stable',
      generated: { by: HOST_ACTOR, at: new Date().toISOString() }
    },
    `Memory of the bot **${botName}**. Entries in this directory are read by every agent acting for that bot.`
  )
  await writeFile(fromBundlePath(rel), text, 'utf-8')
  invalidateKnowledgeScan(rel)
  recordKnowledgeChange({ path: rel, op: 'Creation', title: botName, actor: HOST_ACTOR })
  return dir
}

/**
 * knowledge 工具的作用域解析：会话上下文 + 作用域名 → 目标目录。
 * `create` 为真时缺失的项目 / bot / wiki 主题目录在此建出；为假时返回可读的 error。
 */
export async function resolveSessionScopeTarget(
  rootSessionId: string,
  scope: KnowledgeScopeKind,
  opts: { topic?: string; create: boolean }
): Promise<KnowledgeScopeTarget | { error: string }> {
  if (opts.create) await ensureKnowledgeRoot()
  const ctx = await sessionKnowledgeContext(rootSessionId)
  switch (scope) {
    case 'global':
      return { dir: KNOWLEDGE_DIRS.global, label: 'global' }
    case 'project': {
      if (!ctx.project)
        return { error: 'This session belongs to no project — use scope "global" instead.' }
      const dir = ctx.projectDir ?? (opts.create ? await ensureProjectScope(ctx.project) : null)
      if (!dir) return { error: `Project "${ctx.project.name}" has no knowledge entries yet.` }
      return { dir, label: `project "${ctx.project.name}"` }
    }
    case 'session': {
      let projectDir = ctx.projectDir
      if (!projectDir && ctx.project && opts.create)
        projectDir = await ensureProjectScope(ctx.project)
      const dir = projectDir ? `${projectDir}/${KNOWLEDGE_DIRS.sessions}` : KNOWLEDGE_DIRS.sessions
      if (!opts.create && !existsSync(fromBundlePath(dir)))
        return { error: 'No session summaries recorded yet.' }
      return { dir, label: 'session summaries', sessionResource: sessionResource(rootSessionId) }
    }
    case 'bot': {
      if (!ctx.bot)
        return { error: 'This session is not bound to a bot — there is no bot scope here.' }
      const dir = ctx.botDir ?? (opts.create ? await ensureBotScope(ctx.bot) : null)
      if (!dir) return { error: `Bot "${ctx.bot}" has no knowledge entries yet.` }
      return { dir, label: `bot "${ctx.bot}"` }
    }
    case 'wiki': {
      const topic = opts.topic?.trim()
      if (!topic) {
        if (opts.create)
          return { error: 'Writing to scope "wiki" needs `topic` (the topic directory).' }
        return { dir: KNOWLEDGE_DIRS.wiki, label: 'wiki' }
      }
      const dir = `${KNOWLEDGE_DIRS.wiki}/${slugify(topic, 'topic')}`
      if (opts.create) await mkdir(fromBundlePath(dir), { recursive: true })
      else if (!existsSync(fromBundlePath(dir)))
        return { error: `Wiki topic "${topic}" does not exist yet.` }
      return { dir, label: `wiki topic "${topic}"` }
    }
    case 'raw':
      if (opts.create) await mkdir(fromBundlePath(KNOWLEDGE_DIRS.raw), { recursive: true })
      return { dir: KNOWLEDGE_DIRS.raw, label: 'raw sources' }
  }
}
