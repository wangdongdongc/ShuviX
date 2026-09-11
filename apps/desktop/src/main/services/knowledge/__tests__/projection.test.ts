/**
 * projectBundle —— 每次变更后重投影**该 bundle** 的 index.md、追加它的 log.md，逐份比对只写
 * 有变化的。一个 bundle 根恒有一份带 okf_version 的 index（它是「这是一个 OKF bundle」的自述），
 * 子目录的 index 不带 frontmatter；磁盘上空的子目录不投影。跨 bundle 一概不碰。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getShuvixKnowledgeRootDir: () => state.root,
  getUserKnowledgeRootDir: () => `${state.root}-user`
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { projectBundle } from '../projection'
import { invalidateKnowledgeScan, scanBundle } from '../scan'
import {
  BUNDLE,
  OTHER_BUNDLE,
  bundleAt,
  fileAt,
  makeTempRoot,
  seedConcept,
  seedFile
} from './fixture'

const OKF_FRONTMATTER = '---\nokf_version: "0.2"\n---\n'

let root: string

const read = (bundle: string, rel: string): string =>
  readFileSync(fileAt(root, bundle, rel), 'utf-8')

beforeEach(() => {
  root = makeTempRoot()
  state.root = root
  invalidateKnowledgeScan()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('projectBundle', () => {
  it('DP-1 概念目录与其祖先各得一份 index（bundle 根带 okf_version，子目录不带；磁盘上空的子目录不投影）；带事件时追加 log；别的 bundle 不受影响；再投影无变化 → 空数组、log 不追加', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedConcept(root, `${BUNDLE}/sub/x.md`, ['type: Memory', 'title: X', 'description: dx'])
    mkdirSync(bundleAt(root, `${BUNDLE}/empty`), { recursive: true })
    seedConcept(root, `${OTHER_BUNDLE}/b.md`, ['type: Memory', 'title: B', 'description: db'])

    const written = await projectBundle(BUNDLE, {
      date: '2026-09-09',
      op: 'Creation',
      path: 'a.md',
      title: 'A',
      actor: 'shuvix-work/gpt-5'
    })
    expect([...written].sort()).toEqual(['index.md', 'log.md', 'sub/index.md'])
    expect(existsSync(fileAt(root, BUNDLE, 'empty/index.md'))).toBe(false)

    const rootIndex = read(BUNDLE, 'index.md')
    expect(rootIndex.startsWith(OKF_FRONTMATTER)).toBe(true)
    expect(rootIndex).toContain('* [A](a.md) - da')
    expect(rootIndex).toContain('* [sub](sub/index.md)')
    // 子目录 index 是纯清单：带 frontmatter 的非根 index 是 OKF 的 error
    expect(read(BUNDLE, 'sub/index.md')).toBe('## Entries\n\n* [X](x.md) - dx\n')
    expect(read(BUNDLE, 'log.md')).toBe(
      '## 2026-09-09\n\n- **Creation** /a.md — A · by shuvix-work/gpt-5\n'
    )

    // 投影只写自己那一个 bundle
    expect(existsSync(fileAt(root, OTHER_BUNDLE, 'index.md'))).toBe(false)
    expect(existsSync(fileAt(root, OTHER_BUNDLE, 'log.md'))).toBe(false)

    expect(await projectBundle(BUNDLE)).toEqual([])
    expect(read(BUNDLE, 'log.md')).toBe(
      '## 2026-09-09\n\n- **Creation** /a.md — A · by shuvix-work/gpt-5\n'
    )
  })

  it('DP-2 Update 事件带 title 与 actor 进 log；投影写出的 index 在下一次扫描里已是新内容（精确失效）；没有概念的 bundle 根照样得到一份 index', async () => {
    seedConcept(root, `${BUNDLE}/a.md`, ['type: Memory', 'title: A', 'description: da'])
    seedFile(root, `${BUNDLE}/index.md`, 'stale')
    await scanBundle(BUNDLE)

    const written = await projectBundle(BUNDLE, {
      date: '2026-09-09',
      op: 'Update',
      path: 'a.md',
      title: 'A',
      actor: 'shuvix-work/gpt-5'
    })
    expect(written).toContain('index.md')
    expect(read(BUNDLE, 'log.md')).toContain('- **Update** /a.md — A · by shuvix-work/gpt-5')
    const { files } = await scanBundle(BUNDLE)
    expect(files.find((f) => f.path === 'index.md')!.text).toContain('* [A](a.md) - da')

    mkdirSync(bundleAt(root, OTHER_BUNDLE), { recursive: true })
    expect(await projectBundle(OTHER_BUNDLE)).toEqual(['index.md'])
    expect(read(OTHER_BUNDLE, 'index.md').startsWith(OKF_FRONTMATTER)).toBe(true)
    // 空 bundle 没有 log：初始化本身不是一次变更
    expect(existsSync(fileAt(root, OTHER_BUNDLE, 'log.md'))).toBe(false)
  })
})
