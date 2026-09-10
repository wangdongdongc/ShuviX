/**
 * services/knowledge 单测的公共夹具 —— 临时根目录、概念文件种子、git CLI 读回。
 * 纯辅助（无 vi.mock：mock 必须写在各测试文件顶部才会被提升）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function makeTempRoot(prefix = 'shuvix-kb-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 写一份文件（自动建父目录）；rel 是 `/` 分隔的 bundle 相对路径 */
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

/** `git log --format=<fmt>` 的各条（新 → 旧；单行格式用） */
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
