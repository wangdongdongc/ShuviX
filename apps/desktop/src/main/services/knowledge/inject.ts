/**
 * `<knowledge>` 围栏（桌面接线）—— createAgent 的 resolveKnowledge seam 实现（设计 §7）。
 *
 * 挑选规则：索引 = 项目条目 → 全局条目 → bot 条目 → 最近 5 条会话摘要，都不含 deprecated 与绑定概念
 * （project.md / bot.md 只是目录的名片）；wiki 只给主题计数。旧项目记忆只读列出（D3）。
 * 根目录不存在也返回围栏：零条目时表头 + 写入段仍在，否则库永远无法从空启动。
 */
import { join } from 'path'
import {
  BOT_CONCEPT_FILE,
  KNOWLEDGE_DIRS,
  PROJECT_CONCEPT_FILE
} from '@shuvix/chat-protocol/knowledge'
import {
  KNOWLEDGE_TOOL_NAME,
  renderKnowledgeFence,
  type KnowledgeConcept,
  type KnowledgeLegacyMemory,
  type KnowledgeWikiTopic
} from '@shuvix/agent-runtime'
import { getProjectMemoryDir } from '../../utils/paths'
import { scanProjectMemories } from '../memory'
import { getKnowledgeRoot } from './knowledgePaths'
import { scanKnowledge } from './scan'
import { sessionFenceScopes, sessionKnowledgeContext } from './scopes'

const RECENT_SESSIONS = 5

function inDir(path: string, dir: string | null): boolean {
  return !!dir && path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/')
}

function isBinding(c: KnowledgeConcept): boolean {
  return c.path.endsWith(`/${PROJECT_CONCEPT_FILE}`) || c.path.endsWith(`/${BOT_CONCEPT_FILE}`)
}

function generatedMs(c: KnowledgeConcept): number {
  const t = c.generated ? Date.parse(c.generated.at) : NaN
  return Number.isNaN(t) ? 0 : t
}

export async function resolveKnowledgeFence(
  rootSessionId: string,
  ctx: { tools: readonly string[] }
): Promise<string | null> {
  const [{ concepts }, scopes, session] = await Promise.all([
    scanKnowledge(),
    sessionFenceScopes(rootSessionId),
    sessionKnowledgeContext(rootSessionId)
  ])
  const live = concepts.filter((c) => c.status !== 'deprecated' && !isBinding(c))
  const sessionsDir = session.projectDir
    ? `${session.projectDir}/${KNOWLEDGE_DIRS.sessions}`
    : KNOWLEDGE_DIRS.sessions

  const globalEntries = live.filter((c) => inDir(c.path, KNOWLEDGE_DIRS.global))
  const projectEntries = live.filter((c) => inDir(c.path, session.projectDir))
  const botEntries = live.filter((c) => inDir(c.path, session.botDir))
  const sessionEntries = live
    .filter((c) => inDir(c.path, sessionsDir))
    .sort((a, b) => generatedMs(b) - generatedMs(a))
    .slice(0, RECENT_SESSIONS)

  const index = [...projectEntries, ...globalEntries, ...botEntries, ...sessionEntries]

  const topicCounts = new Map<string, number>()
  for (const c of live) {
    if (!c.path.startsWith(`${KNOWLEDGE_DIRS.wiki}/`)) continue
    const topic = c.path.split('/')[1]
    if (!topic || c.path.split('/').length < 3) continue
    topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
  }
  const wikiTopics: KnowledgeWikiTopic[] = [...topicCounts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([topic, count]) => ({ topic, count }))

  let legacy: KnowledgeLegacyMemory[] = []
  if (session.project) {
    const dir = getProjectMemoryDir(session.project.id)
    legacy = scanProjectMemories(session.project.id).map((m) => ({
      path: join(dir, `${m.slug}.md`),
      recall: m.recall || m.description
    }))
  }

  return renderKnowledgeFence({
    root: getKnowledgeRoot(),
    scopes,
    index,
    wikiTopics,
    legacy,
    now: new Date(),
    writing: ctx.tools.includes(KNOWLEDGE_TOOL_NAME) ? 'tool' : 'file'
  })
}
