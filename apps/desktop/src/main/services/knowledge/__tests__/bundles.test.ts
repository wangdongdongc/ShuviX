/**
 * bundles —— 一个绑定实体一个 bundle（本期只有 `projects/<slug>/`）。这里钉两件事：
 * 建一个 bundle 是「目录 + project.md + index 投影 + git init 基线提交」四件事一次做完；
 * **绑定的真源是 project.md 的 `resource`，目录名只是给人看的 slug** —— 所以同一个项目永远
 * 解析到同一个目录（同名项目各自 -2 去重），项目改名也不搬家。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { parseConceptText } from '@shuvix/agent-runtime'
import { HOST_ACTOR, ensureProjectBundle, findProjectBundle, isBundleInitialized } from '../bundles'
import { flushKnowledgeCommits } from '../repo'
import { invalidateKnowledgeScan } from '../scan'
import type { Project } from '../../../dao/types/project'
import {
  PROJECTS,
  bundleAt,
  fileAt,
  gitCommitCount,
  gitHeadFiles,
  gitLog,
  gitStatus,
  makeTempRoot,
  seedConcept
} from './fixture'

let root: string

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Acme Corp',
  path: '/repos/acme',
  systemPrompt: '',
  settings: {},
  archivedAt: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

const read = (bundle: string, rel: string): string =>
  readFileSync(fileAt(root, bundle, rel), 'utf-8')

const containerDirs = (): string[] =>
  readdirSync(join(root, PROJECTS), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(async () => {
  await flushKnowledgeCommits()
  rmSync(root, { recursive: true, force: true })
})

describe('ensureProjectBundle', () => {
  it('BD-1 建一个项目 bundle：目录（slug 取项目名）+ project.md（宿主 actor + shuvix://project/<id> 绑定 + okf 标记）+ 自己的 index / log 投影 + git init 一条基线提交', async () => {
    expect(isBundleInitialized('projects/acme-corp')).toBe(false)

    const bundle = await ensureProjectBundle(project())
    expect(bundle).toBe('projects/acme-corp')
    expect(isBundleInitialized(bundle)).toBe(true)

    const conceptMd = read(bundle, 'project.md')
    // 标记按字面钉：它是别的消费者认出「这是一份 OKF 条目」的那一行
    expect(conceptMd).toContain('shuvix: okf v0.2')
    const concept = parseConceptText(conceptMd, 'project.md')!
    expect(concept).toMatchObject({
      type: 'Project',
      title: 'Acme Corp',
      resource: 'shuvix://project/p1',
      status: 'stable'
    })
    // 宿主自己写的文件盖宿主的章（OKF §5.2 `process:<id>`），不冒充任何 agent
    expect(HOST_ACTOR).toBe('process:shuvix')
    expect(concept.generated?.by).toBe(HOST_ACTOR)

    const index = read(bundle, 'index.md')
    expect(index.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true)
    expect(index).toContain('* [Acme Corp](project.md)')
    expect(read(bundle, 'log.md')).toContain(
      `- **Creation** /project.md — Acme Corp · by ${HOST_ACTOR}`
    )

    // 每个 bundle 自带一个仓库：基线提交把刚建出来的三份文件一次收进去
    const dir = bundleAt(root, bundle)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(gitLog(dir, '%s')).toEqual(['kb(init): knowledge base'])
    expect(gitHeadFiles(dir)).toEqual(['index.md', 'log.md', 'project.md'])
    expect(gitStatus(dir)).toBe('')
  })

  it('BD-2 幂等：同一个项目第二次解析到同一个 bundle，不建第二个目录、不重写 project.md、不加提交；findProjectBundle 未知 id → null，容器里的散 project.md 与子目录里的 project.md 都不是绑定', async () => {
    const bundle = await ensureProjectBundle(project())
    const before = read(bundle, 'project.md')
    const commits = gitCommitCount(bundleAt(root, bundle))

    expect(await ensureProjectBundle(project())).toBe(bundle)
    expect(await findProjectBundle('p1')).toBe(bundle)
    expect(containerDirs()).toEqual(['acme-corp'])
    expect(read(bundle, 'project.md')).toBe(before)
    expect(gitCommitCount(bundleAt(root, bundle))).toBe(commits)

    expect(await findProjectBundle('nope')).toBeNull()
    // bundle 边界是 `projects/<slug>`：容器里的散文件不是 bundle，bundle 内子目录也不是根
    seedConcept(root, `${PROJECTS}/project.md`, [
      'type: Project',
      'title: Stray',
      'resource: shuvix://project/p8'
    ])
    seedConcept(root, `${bundle}/sub/project.md`, [
      'type: Project',
      'title: Nested',
      'resource: shuvix://project/p9'
    ])
    expect(await findProjectBundle('p8')).toBeNull()
    expect(await findProjectBundle('p9')).toBeNull()
  })

  it('BD-3 slug 只是目录名：同名的第二个项目拿 `-2`，各自绑各自的 id；名字 slug 化为空时回落 project', async () => {
    const first = await ensureProjectBundle(project())
    const second = await ensureProjectBundle(project({ id: 'p2' }))
    expect(first).toBe('projects/acme-corp')
    expect(second).toBe('projects/acme-corp-2')
    expect(await findProjectBundle('p1')).toBe(first)
    expect(await findProjectBundle('p2')).toBe(second)

    expect(await ensureProjectBundle(project({ id: 'p3', name: '###' }))).toBe('projects/project')
    expect(containerDirs()).toEqual(['acme-corp', 'acme-corp-2', 'project'])
  })

  it('BD-4 项目改名不搬家：绑定按 resource 查，改名后同一个 id 仍解析到原目录，不建新目录、不加提交', async () => {
    const bundle = await ensureProjectBundle(project())
    const commits = gitCommitCount(bundleAt(root, bundle))

    const renamed = project({ name: 'Globex' })
    expect(await ensureProjectBundle(renamed)).toBe(bundle)
    expect(await findProjectBundle('p1')).toBe(bundle)
    expect(containerDirs()).toEqual(['acme-corp'])
    // 目录名与 title 都是旧的：改名同步 title 是别处的事，这里只保证不新建
    expect(read(bundle, 'project.md')).toContain('title: Acme Corp')
    expect(gitCommitCount(bundleAt(root, bundle))).toBe(commits)
  })
})
