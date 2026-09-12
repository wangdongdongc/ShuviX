/**
 * bundle 的建立与定位（设计 §3 / §5）—— 本期只有项目 bundle：`projects/<projectId>/`。
 *
 * **目录名就是项目 id**（uuidv7）。曾经用项目名的 slug，两个毛病：slug 会撞（得挂 `-2` 后缀），
 * 而且项目可以改名 —— 名字一改，目录名就成了谁也对不上的旧词。id 不重、不变，目录名于是不再
 * 需要去重，`findProjectBundle` 也从「扫全部 bundle 比对 resource」变成一次 existsSync。
 *
 * **绑定的真源仍是 `project.md` 的 `resource: shuvix://project/<id>`**（决策 D2）：目录名只是
 * 快路径，改名前建出来的旧 bundle、或从别处 clone 进来目录名对不上的，照样能被 resource 认出来。
 * 给人看的名字全部走 UI —— 侧栏取项目的**当前**名字（services/knowledge/entries.ts）。
 *
 * 懒建：目录的出现应当是用户或 agent 写入的结果，不在启动时建。建一个 bundle = mkdir +
 * 写绑定概念 + 投影它的 index + `git init` 基线提交，四件事一次做完。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { PROJECT_CONCEPT_FILE, projectResource } from '@shuvix/chat-protocol/knowledge'
import { buildConceptText } from '@shuvix/agent-runtime'
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

/**
 * 找项目 bundle：先按目录名直取（`projects/<id>`），落空再按 `project.md` 的 resource 全扫一遍
 * —— 后者兜住改名前用 slug 当目录名建出来的旧 bundle，以及外来 clone。都没有返回 null。
 */
export async function findProjectBundle(projectId: string): Promise<string | null> {
  const byId = `${PROJECTS_CONTAINER}/${projectId}`
  if (isBundleInitialized(byId)) return byId

  const resource = projectResource(projectId)
  for (const bundle of listBundles()) {
    const { concepts } = await scanBundle(bundle)
    const hit = concepts.find((c) => c.path === PROJECT_CONCEPT_FILE && c.resource === resource)
    if (hit) return bundle
  }
  return null
}

/**
 * 项目 bundle：已有就返回，没有就建出来（目录 + `project.md` + index 投影 + git init）。
 * 返回 bundle id（`projects/<projectId>`）。
 */
export async function ensureProjectBundle(project: Project): Promise<string> {
  const existing = await findProjectBundle(project.id)
  if (existing) return existing

  const bundle = `${PROJECTS_CONTAINER}/${project.id}`
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
