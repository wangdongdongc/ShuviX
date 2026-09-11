/**
 * bundle 的建立与定位（设计 §3 / §5）—— 本期只有项目 bundle：`projects/<slug>/`。
 *
 * **绑定的真源是 bundle 里的 `project.md`**（`resource: shuvix://project/<id>`），目录名只是
 * 给人看的 slug（决策 D2）：项目改名只改 project.md 的 title，目录不动。
 *
 * 懒建：目录的出现应当是用户或 agent 写入的结果，不在启动时建。建一个 bundle = mkdir +
 * 写绑定概念 + 投影它的 index + `git init` 基线提交，四件事一次做完。
 */
import { existsSync, readdirSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { PROJECT_CONCEPT_FILE, projectResource } from '@shuvix/chat-protocol/knowledge'
import { buildConceptText, slugify } from '@shuvix/agent-runtime'
import type { Project } from '../../dao/types/project'
import { createLogger } from '../../logger'
import { PROJECTS_CONTAINER, bundleDir, bundleFilePath } from './knowledgePaths'
import { projectBundle } from './projection'
import { ensureBundleRepo } from './repo'
import { invalidateKnowledgeScan, listBundles, scanBundle } from './scan'

const log = createLogger('Knowledge')

/** 宿主自身写文件时的 actor（OKF §5.2 `process:<id>`） */
export const HOST_ACTOR = 'process:shuvix'

/** 某个 bundle 是否已经建出来（有 index.md 即算） */
export function isBundleInitialized(bundle: string): boolean {
  return existsSync(bundleFilePath(bundle, 'index.md'))
}

/** 按 `project.md` 的 resource 绑定找项目 bundle；没有返回 null */
export async function findProjectBundle(projectId: string): Promise<string | null> {
  const resource = projectResource(projectId)
  for (const bundle of listBundles()) {
    const { concepts } = await scanBundle(bundle)
    const hit = concepts.find((c) => c.path === PROJECT_CONCEPT_FILE && c.resource === resource)
    if (hit) return bundle
  }
  return null
}

/** 容器里已被占用的目录名（slug 去重用） */
function takenDirNames(): Set<string> {
  try {
    return new Set(
      readdirSync(bundleDir(PROJECTS_CONTAINER), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    )
  } catch {
    return new Set()
  }
}

function uniqueSlug(base: string): string {
  const taken = takenDirNames()
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * 项目 bundle：已有就返回，没有就建出来（目录 + `project.md` + index 投影 + git init）。
 * 返回 bundle id（如 `projects/acme`）。
 */
export async function ensureProjectBundle(project: Project): Promise<string> {
  const existing = await findProjectBundle(project.id)
  if (existing) return existing

  const bundle = `${PROJECTS_CONTAINER}/${uniqueSlug(slugify(project.name, 'project'))}`
  await mkdir(bundleDir(bundle), { recursive: true })
  const now = new Date()
  const content = buildConceptText(
    {
      type: 'Project',
      title: project.name,
      description: `Knowledge base of the project "${project.name}".`,
      resource: projectResource(project.id),
      status: 'stable',
      generated: { by: HOST_ACTOR, at: now.toISOString() }
    },
    `Entries here are read by sessions of this project.`
  )
  await writeFile(bundleFilePath(bundle, PROJECT_CONCEPT_FILE), content, 'utf-8')
  invalidateKnowledgeScan(bundle)
  await projectBundle(bundle, {
    date: now.toISOString().slice(0, 10),
    op: 'Creation',
    path: PROJECT_CONCEPT_FILE,
    title: project.name,
    actor: HOST_ACTOR
  })
  await ensureBundleRepo(bundle)
  log.info(`created knowledge bundle ${bundle} for project ${project.id}`)
  return bundle
}
