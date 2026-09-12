/**
 * bundles —— 一个绑定实体一个 bundle（本期只有 `projects/<projectId>/`）。这里钉两件事：
 * 建一个 bundle 是「目录 + project.md + index 投影 + git init 基线提交」四件事一次做完；
 * **目录名就是项目 id** —— 不会撞、不随改名变，所以不需要去重；而绑定的真源仍是 project.md 的
 * `resource`，改名前用 slug 建出来的旧目录照样被认出来（这条兜底也钉在下面）。
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
  it('BD-1 建一个项目 bundle：目录名取项目 id + project.md（宿主 actor + shuvix://project/<id> 绑定 + okf 标记）+ 自己的 index / log 投影 + git init 一条基线提交', async () => {
    expect(isBundleInitialized('projects/p1')).toBe(false)

    const bundle = await ensureProjectBundle(project())
    // 目录名是 id 而不是项目名的 slug：项目可以改名，id 不会
    expect(bundle).toBe('projects/p1')
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
    expect(containerDirs()).toEqual(['p1'])
    expect(read(bundle, 'project.md')).toBe(before)
    expect(gitCommitCount(bundleAt(root, bundle))).toBe(commits)

    expect(await findProjectBundle('nope')).toBeNull()
    // bundle 边界是 `projects/<id>`：容器里的散文件不是 bundle，bundle 内子目录也不是根
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

  it('BD-3 目录名不再需要去重：同名的两个项目各拿各的 id 目录；名字里有什么字符都不影响目录名', async () => {
    const first = await ensureProjectBundle(project())
    const second = await ensureProjectBundle(project({ id: 'p2' }))
    expect(first).toBe('projects/p1')
    expect(second).toBe('projects/p2')
    expect(await findProjectBundle('p1')).toBe(first)
    expect(await findProjectBundle('p2')).toBe(second)

    // 名字 slug 化为空、含空格大小写 —— 目录名一概只看 id
    expect(await ensureProjectBundle(project({ id: 'p3', name: '###' }))).toBe('projects/p3')
    expect(containerDirs()).toEqual(['p1', 'p2', 'p3'])
  })

  /**
   * 目录名只是快路径。改名那一版（v0.1.45 及更早）用项目名的 slug 当目录名，那些 bundle
   * 已经在用户盘上了 —— 按 id 直取落空之后必须还能按 resource 找回来，否则会给同一个项目
   * 再建一个空库。
   */
  it('BD-3b 目录名对不上时按 resource 兜底：旧 slug 目录仍解析得到，且不会再建一个 id 目录', async () => {
    seedConcept(root, `${PROJECTS}/acme-corp/project.md`, [
      'type: Project',
      'title: Acme Corp',
      'resource: shuvix://project/p1'
    ])
    seedConcept(root, `${PROJECTS}/acme-corp/index.md`, [])
    invalidateKnowledgeScan()

    expect(await findProjectBundle('p1')).toBe('projects/acme-corp')
    expect(await ensureProjectBundle(project())).toBe('projects/acme-corp')
    expect(containerDirs()).toEqual(['acme-corp'])
  })

  it('BD-4 项目改名不搬家：目录名是 id，改名后同一个 id 仍解析到原目录，不建新目录、不加提交', async () => {
    const bundle = await ensureProjectBundle(project())
    const commits = gitCommitCount(bundleAt(root, bundle))

    const renamed = project({ name: 'Globex' })
    expect(await ensureProjectBundle(renamed)).toBe(bundle)
    expect(await findProjectBundle('p1')).toBe(bundle)
    expect(containerDirs()).toEqual(['p1'])
    // 文件里的 title 是建库那一刻的名字，改名不回写：侧栏显示的当前名字由 entries 视图给
    expect(read(bundle, 'project.md')).toContain('title: Acme Corp')
    expect(gitCommitCount(bundleAt(root, bundle))).toBe(commits)
  })
})
