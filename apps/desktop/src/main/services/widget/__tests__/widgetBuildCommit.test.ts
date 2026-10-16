/**
 * `widgetService.build` + `widgetRepo.commitBuild` —— 构建成功后宿主提交整棵树（`shuvix widget build <id> [--message]`）。
 * 真的 widgetRegistry / widgetRepo / agent-runtime 的 git op，widgets 根目录是临时目录（`utils/paths` 顶掉）；
 * widgetServer（打包）、widgetDb（pglite）换成空壳，打包结果每条用例自己定；logger 的 warn 是间谍。
 * 历史用 isomorphic-git 直接读（log / listFiles / statusMatrix / readBlob）。
 *
 *   BC-1 已是仓库：改 / 增 / 删之后构建 → result.commit 是新提交的 7 位短 oid；说明 `chore(<id>): build`；
 *        署名 ShuviX Widget；HEAD 里是新内容、删掉的文件没了；之后工作树干净；结果带 id / url / buildSuccess
 *   BC-2 message 去掉首尾空白后当说明；全空白 / 空串 → 缺省说明
 *   BC-3 没有改动再构建 → 结果没有 commit 键，历史不变
 *   BC-4 构建失败 → buildSuccess false + buildErrors，不提交、HEAD 不变、工作树还是脏的
 *   BC-5 没有 .git 的旧 widget：第一次构建只有一条署名 ShuviX 的基线提交、结果没有 commit；改了再构建 → 有 commit，署名 ShuviX Widget
 *   BC-6 提交失败（.git/objects 坏掉）只记日志：构建照常返回、没有 commit、warn 被调
 *   BC-7 widget 已注册 → 走 rebuild（不走 registerAndBuild），提交照样落
 *   BC-8 .gitignore 里的 node_modules 不进提交
 *   BC-9 commitBuild 直接调在不是仓库的目录上 → undefined、不建 .git；defaultBuildMessage 的格式
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type BuildResult = { success: boolean; errors?: string[] }

const state = vi.hoisted(() => ({
  root: '',
  result: { success: true } as { success: boolean; errors?: string[] },
  warn: vi.fn()
}))

const serverMock = vi.hoisted(() => ({
  hasWidget: vi.fn(() => false),
  registerAndBuild: vi.fn(async () => state.result),
  rebuild: vi.fn(async () => state.result),
  getUrl: (id: string) => `http://127.0.0.1:1/w/${id}/`
}))

vi.mock('../../../utils/paths', () => ({ getWidgetsDir: () => state.root }))
vi.mock('../widgetServer', () => ({ widgetServer: serverMock }))
vi.mock('../widgetDb', () => ({
  applyWidgetSchema: vi.fn(),
  dropWidgetSchema: vi.fn(),
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: state.warn, error: () => {}, debug: () => {} })
}))

import { widgetService } from '../widgetService'
import { commitBuild, defaultBuildMessage, ensureRepo } from '../widgetRepo'

const ID = 'photo-wall'
let dir = ''

function setResult(result: BuildResult): void {
  state.result = result
}

/** ROOT/photo-wall/{widget.json,index.tsx}；withRepo → 先 ensureRepo 记一条基线 */
async function fixture(files: Record<string, string> = {}, withRepo = true): Promise<void> {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify({
      id: ID,
      name: 'Photo Wall',
      description: '',
      entryFile: 'index.tsx',
      createdAt: 1
    })
  )
  writeFileSync(join(dir, 'index.tsx'), 'export const v = 1\n')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  if (withRepo) await ensureRepo(dir, `chore(${ID}): scaffold widget`)
}

/** isomorphic-git 读这个 widget 仓库用的 { fs, dir } */
const env = (): { fs: typeof nodeFs; dir: string } => ({ fs: nodeFs, dir })

async function log(): Promise<Awaited<ReturnType<typeof git.log>>> {
  return git.log({ ...env() })
}

async function headFiles(): Promise<string[]> {
  return git.listFiles({ ...env(), ref: 'HEAD' })
}

async function headContent(filepath: string): Promise<string> {
  const oid = await git.resolveRef({ ...env(), ref: 'HEAD' })
  const { blob } = await git.readBlob({ ...env(), oid, filepath })
  return Buffer.from(blob).toString('utf8')
}

async function isClean(): Promise<boolean> {
  const matrix = await git.statusMatrix({ ...env() })
  return matrix.every(([, head, workdir, stage]) => head === 1 && workdir === 1 && stage === 1)
}

const subjectOf = (message: string): string => message.split('\n')[0]

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'shuvix-widget-build-'))
  dir = join(state.root, ID)
  setResult({ success: true })
  serverMock.hasWidget.mockReset().mockReturnValue(false)
  serverMock.registerAndBuild.mockClear()
  serverMock.rebuild.mockClear()
  state.warn.mockClear()
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
})

describe('BC 构建成功后的提交', () => {
  it('BC-1 改 / 增 / 删之后构建 → 一条署名 ShuviX Widget 的提交，结果带 7 位短 oid', async () => {
    await fixture({ 'old.ts': 'old\n' })
    const before = await log()

    writeFileSync(join(dir, 'index.tsx'), 'export const v = 2\n')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'new.ts'), 'new\n')
    rmSync(join(dir, 'old.ts'))

    const result = await widgetService.build(ID)

    const history = await log()
    expect(history).toHaveLength(before.length + 1)
    expect(result.commit).toMatch(/^[0-9a-f]{7}$/)
    expect(result.commit).toBe(history[0].oid.slice(0, 7))
    expect(subjectOf(history[0].commit.message)).toBe(`chore(${ID}): build`)
    expect(history[0].commit.author.name).toBe('ShuviX Widget')
    expect(history[0].commit.author.email).toBe('widget@shuvix.local')

    const files = await headFiles()
    expect(files).toContain('src/new.ts')
    expect(files).not.toContain('old.ts')
    expect(await headContent('index.tsx')).toBe('export const v = 2\n')
    expect(await isClean()).toBe(true)

    expect(result).toMatchObject({
      id: ID,
      url: `http://127.0.0.1:1/w/${ID}/`,
      buildSuccess: true
    })
    expect(serverMock.registerAndBuild).toHaveBeenCalledTimes(1)
  })

  it('BC-2 message 去掉首尾空白当说明；全空白 / 空串 → 缺省说明', async () => {
    await fixture()
    const cases: Array<[string, string]> = [
      ['  feat: add grid  ', 'feat: add grid'],
      ['   ', `chore(${ID}): build`],
      ['', `chore(${ID}): build`]
    ]
    let n = 0
    for (const [message, subject] of cases) {
      writeFileSync(join(dir, 'index.tsx'), `export const v = ${++n + 10}\n`)
      const result = await widgetService.build(ID, { message })
      expect(result.commit, JSON.stringify(message)).toMatch(/^[0-9a-f]{7}$/)
      const [head] = await log()
      expect(subjectOf(head.commit.message), JSON.stringify(message)).toBe(subject)
    }
  })

  it('BC-3 没有改动再构建 → 没有 commit 键，历史不变', async () => {
    await fixture()
    writeFileSync(join(dir, 'index.tsx'), 'export const v = 3\n')
    const first = await widgetService.build(ID)
    expect(first.commit).toMatch(/^[0-9a-f]{7}$/)
    const count = (await log()).length

    const second = await widgetService.build(ID)
    expect('commit' in second).toBe(false)
    expect(second.buildSuccess).toBe(true)
    expect(await log()).toHaveLength(count)
  })

  it('BC-4 构建失败 → 不提交，HEAD 不变，工作树还是脏的', async () => {
    await fixture()
    const head = await git.resolveRef({ ...env(), ref: 'HEAD' })
    writeFileSync(join(dir, 'index.tsx'), 'broken(\n')
    setResult({ success: false, errors: ['boom'] })

    const result = await widgetService.build(ID)

    expect(result.buildSuccess).toBe(false)
    expect(result.buildErrors).toEqual(['boom'])
    expect('commit' in result).toBe(false)
    expect(await git.resolveRef({ ...env(), ref: 'HEAD' })).toBe(head)
    expect(await isClean()).toBe(false)
  })

  it('BC-5 没有 .git 的旧 widget：先只有一条 ShuviX 基线；改了再构建才有 commit', async () => {
    await fixture({}, false)
    expect(existsSync(join(dir, '.git'))).toBe(false)

    const first = await widgetService.build(ID)
    const history = await log()
    expect(history).toHaveLength(1)
    expect(history[0].commit.author.name).toBe('ShuviX')
    expect(subjectOf(history[0].commit.message)).toBe(`chore(${ID}): baseline of existing widget`)
    expect('commit' in first).toBe(false)

    writeFileSync(join(dir, 'index.tsx'), 'export const v = 5\n')
    const second = await widgetService.build(ID)
    const after = await log()
    expect(after).toHaveLength(2)
    expect(second.commit).toBe(after[0].oid.slice(0, 7))
    expect(after[0].commit.author.name).toBe('ShuviX Widget')
  })

  it('BC-6 提交失败只记日志：构建照常返回，没有 commit', async () => {
    await fixture()
    rmSync(join(dir, '.git', 'objects'), { recursive: true, force: true })
    writeFileSync(join(dir, '.git', 'objects'), 'not a directory')
    writeFileSync(join(dir, 'index.tsx'), 'export const v = 6\n')

    const result = await widgetService.build(ID)

    expect(result.buildSuccess).toBe(true)
    expect('commit' in result).toBe(false)
    expect(state.warn).toHaveBeenCalled()
  })

  it('BC-7 已注册 → 走 rebuild，提交照样落', async () => {
    await fixture()
    serverMock.hasWidget.mockReturnValue(true)
    writeFileSync(join(dir, 'index.tsx'), 'export const v = 7\n')

    const result = await widgetService.build(ID)

    expect(serverMock.rebuild).toHaveBeenCalledWith(ID)
    expect(serverMock.registerAndBuild).not.toHaveBeenCalled()
    expect(result.commit).toBe((await log())[0].oid.slice(0, 7))
  })

  it('BC-8 .gitignore 里的 node_modules 不进提交', async () => {
    await fixture({ '.gitignore': 'node_modules/\n' })
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'module.exports = 1\n')
    writeFileSync(join(dir, 'index.tsx'), 'export const v = 8\n')

    const result = await widgetService.build(ID)

    expect(result.commit).toMatch(/^[0-9a-f]{7}$/)
    const files = await headFiles()
    expect(files).toContain('.gitignore')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
  })
})

describe('BC-9 commitBuild / defaultBuildMessage', () => {
  it('BC-9 不是仓库 → undefined，不建 .git', async () => {
    await fixture({}, false)
    await expect(commitBuild(dir, 'feat: x')).resolves.toBeUndefined()
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })

  it('BC-9 defaultBuildMessage 的格式', () => {
    expect(defaultBuildMessage('a-b')).toBe('chore(a-b): build')
  })
})
