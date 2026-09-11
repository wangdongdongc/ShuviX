/**
 * services/knowledge 单测的公共夹具 —— 临时 shuvix 根、bundle 内种文件、git CLI 读回。
 *
 * 根是**容器**不是 bundle：库的形状是 `<root>/projects/<slug>/`，每个 bundle 自带自己的
 * index / log / .git。所以路径助手都要「bundle id + bundle 内相对路径」两段，git 助手的 cwd
 * 也是某个 bundle 目录而不是根。纯辅助（无 vi.mock：mock 必须写在各测试文件顶部才会被提升）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** 本期唯一的 bundle 容器（夹具不引生产常量，值对不上要在用例里看得见） */
export const PROJECTS = 'projects'

/** 两个现成的 bundle id，省得每个用例自己拼 */
export const BUNDLE = `${PROJECTS}/acme`
export const OTHER_BUNDLE = `${PROJECTS}/beta`

export function makeTempRoot(prefix = 'shuvix-kb-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** bundle 根的绝对路径（root 是 shuvix 根，bundle 是根相对 id 如 `projects/acme`） */
export function bundleAt(root: string, bundle: string): string {
  return join(root, ...bundle.split('/'))
}

/** bundle 内某个文件的绝对路径 */
export function fileAt(root: string, bundle: string, rel: string): string {
  return join(bundleAt(root, bundle), ...rel.split('/'))
}

/** 写一份文件（自动建父目录）；rel 是 `/` 分隔的**根相对**路径（含 bundle 前缀） */
export function seedFile(root: string, rel: string, text: string): string {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf-8')
  return abs
}

/** 一份概念文本：frontmatter 行 + 正文（尾随换行） */
export function conceptText(frontmatter: string[], body = 'body'): string {
  return ['---', ...frontmatter, '---', '', body, ''].join('\n')
}

export function seedConcept(
  root: string,
  rel: string,
  frontmatter: string[],
  body?: string
): string {
  return seedFile(root, rel, conceptText(frontmatter, body))
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** `git log --format=<fmt>` 的各条（新 → 旧；单行格式用）；cwd 是 bundle 目录 */
export function gitLog(cwd: string, format = '%s'): string[] {
  return git(cwd, ['log', `--format=${format}`])
    .split('\n')
    .filter(Boolean)
}

/** HEAD 的完整提交信息（去尾随空白） */
export function gitHeadMessage(cwd: string): string {
  return git(cwd, ['log', '-1', '--format=%B']).trimEnd()
}

export function gitCommitCount(cwd: string): number {
  return Number(git(cwd, ['rev-list', '--count', 'HEAD']).trim())
}

/** HEAD 提交触及的路径（字典序） */
export function gitHeadFiles(cwd: string): string[] {
  return git(cwd, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort()
}

/** `git status --porcelain`（去尾随空白；干净为空串） */
export function gitStatus(cwd: string): string {
  return git(cwd, ['status', '--porcelain']).trimEnd()
}
