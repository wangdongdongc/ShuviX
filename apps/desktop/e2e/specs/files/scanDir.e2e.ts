/**
 * files.scanDir（按目录浅扫描，文件树懒加载的后端）全链路：
 * IPC → filesWatcherService.scanSessionDir → dirScan（纯 readdir 只扫一层，
 * 浏览场景不做 gitignore 过滤，唯一例外是 .git 目录不列出）。
 *
 * 纯 IPC 断言（不碰 DOM）：种子一棵固定形状的目录树，验根/子目录两级扫描的 files/dirs
 * 形状与过滤语义。不触发任何 LLM。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createProject, waitRendererReady } from '../../harness/seed'

interface ScanDirResult {
  files: string[]
  dirs: string[]
  root: string | null
}

let app: E2EApp
let projectDir: string
let sid = ''

const scanDir = (dir: string): Promise<ScanDirResult> =>
  // sid 在 beforeAll 里就位，模板串在调用时才求值
  app.main.eval(`window.api.files.scanDir(${JSON.stringify({ sessionId: sid, dir })})`)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)

  // 种子目录树：top.ts / a(f1.ts, b/f2.ts, b/c/f3.ts) / empty/ / node_modules/（.gitignore
  // 忽略，但浏览场景所见即磁盘所有，照常列出）/ .git/（永不出现）
  projectDir = join(app.home, 'proj')
  mkdirSync(join(projectDir, 'a/b/c'), { recursive: true })
  mkdirSync(join(projectDir, 'empty'))
  mkdirSync(join(projectDir, 'node_modules/pkg'), { recursive: true })
  mkdirSync(join(projectDir, '.git'))
  writeFileSync(join(projectDir, 'top.ts'), '')
  writeFileSync(join(projectDir, 'a/f1.ts'), '')
  writeFileSync(join(projectDir, 'a/b/f2.ts'), '')
  writeFileSync(join(projectDir, 'a/b/c/f3.ts'), '')
  writeFileSync(join(projectDir, 'node_modules/dep.js'), '')
  writeFileSync(join(projectDir, 'node_modules/pkg/index.js'), '')
  writeFileSync(join(projectDir, '.git/HEAD'), '')
  writeFileSync(join(projectDir, '.gitignore'), 'node_modules/\n')

  const { id } = await createProject(app.main, { name: 'e2e-files', path: projectDir })
  const s = await app.main.eval<{ id: string }>(
    `window.api.session.create(${JSON.stringify({ title: 'e2e-files', projectId: id })})`
  )
  sid = s.id
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('files.scanDir', () => {
  it('根目录：只列一层（直接子文件 + 直接子目录，尾斜杠），浏览不做 gitignore 过滤', async () => {
    const r = await scanDir('')
    expect(r.root).toBe(projectDir)
    // 直接子文件只有这两个；子目录内容要展开对应目录才返回
    expect(r.files).toEqual(['.gitignore', 'top.ts'])
    // .gitignore 忽略的目录照常出现（对标 VSCode Explorer）；.git 除外
    expect(r.dirs).toEqual(['a/', 'empty/', 'node_modules/'])
  })

  it('子目录：带前缀、只列一层；展开 node_modules 能看到被 gitignore 忽略的内容', async () => {
    const r = await scanDir('a')
    expect(r.files).toEqual(['a/f1.ts'])
    expect(r.dirs).toEqual(['a/b/'])
    const nm = await scanDir('node_modules')
    expect(nm.files).toEqual(['node_modules/dep.js'])
    expect(nm.dirs).toEqual(['node_modules/pkg/'])
  })

  it('目录不存在返回空列表而非报错', async () => {
    const r = await scanDir('no/such/dir')
    expect(r.root).toBe(projectDir)
    expect(r).toMatchObject({ files: [], dirs: [] })
  })
})
