/**
 * services/knowledge 单测的公共夹具 —— 临时 shuvix 根、bundle 内种文件、git CLI 读回。
 *
 * 根是**容器**不是 bundle：库的形状是 `<root>/projects/<id>/`，每个 bundle 自带自己的
 * .git。所以路径助手都要「bundle id + bundle 内相对路径」两段，git 助手的 cwd
 * 也是某个 bundle 目录而不是根。纯辅助（无 vi.mock：mock 必须写在各测试文件顶部才会被提升）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, type Dirent } from 'node:fs'
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

/**
 * 用户根替身：knowledge 相关测试把 getUserKnowledgeRootDir 替成 shuvix 根的兄弟目录 `<root>-user`。
 * 它不在 root 之下 —— 往用户根写东西的用例得自己在 afterEach 里把它也删掉。
 */
export function userRootOf(root: string): string {
  return `${root}-user`
}

/**
 * 内置库根替身：getBuiltinKnowledgeDir 替成 shuvix 根的又一个兄弟目录 `<root>-builtin`
 * （既有用例里它**不存在**，所以「没有内置库」是缺省）。真要有内置库就 `seedBuiltin` 往里种 ——
 * 它同样不在 root 之下，与 `userRootOf` 一个坑：种过的用例得自己在 afterEach 里把它删掉。
 */
export function builtinRootOf(root: string): string {
  return `${root}-builtin`
}

/** 内置库某个语言那一版的绝对目录（`<内置根>/<库名>/<语言>`）—— bundle 目录就是这一层 */
export function builtinLangAt(root: string, name: string, lang: string): string {
  return join(builtinRootOf(root), name, lang)
}

/**
 * 往内置库种一份文件：`rel` 是**内置根相对**的 `<库名>/<语言>/<库内相对路径>`
 * （语言那一层不进 bundle id，但在磁盘上实打实存在）。
 */
export function seedBuiltin(root: string, rel: string, text: string): string {
  return seedFile(builtinRootOf(root), rel, text)
}

/** 同上，内容是一份概念文本 */
export function seedBuiltinConcept(
  root: string,
  rel: string,
  frontmatter: string[],
  body?: string
): string {
  return seedBuiltin(root, rel, conceptText(frontmatter, body))
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

/**
 * 目录下的全部条目（递归，`/` 分隔、目录带尾随 `/`、含隐藏项，字典序）；目录不在返回 `[]`。
 *
 * 「调用前后磁盘没有多出东西」一律比它：只比名字不比内容，新长出来的目录（空的也算）、
 * 多写的文件、被删掉的东西都看得见 —— 单看 `readdirSync` 只能看见最外一层。
 */
export function treeOf(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, prefix: string): void => {
    let items: Dirent[]
    try {
      items = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        out.push(`${rel}/`)
        walk(join(abs, item.name), rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(dir, '')
  return out.sort()
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

/** 任意 git CLI 读回（原样输出，不裁剪）；cwd 是 bundle 目录 */
export function gitOutput(cwd: string, args: string[]): string {
  return git(cwd, args)
}

/**
 * 以用户本人（Alice）的身份跑 git CLI —— 造「用户自带的仓库」用。分支名、身份、签名开关都写在
 * 命令行上，不依赖本机的全局 git 配置。
 */
export function gitAsUser(cwd: string, args: string[]): string {
  return git(cwd, [
    '-c',
    'init.defaultBranch=main',
    '-c',
    'user.name=Alice',
    '-c',
    'user.email=alice@example.com',
    '-c',
    'commit.gpgsign=false',
    ...args
  ])
}

/** 某个提交触及的路径（字典序）；根提交即它收下的全部文件 */
export function gitCommitFiles(cwd: string, rev: string): string[] {
  return git(cwd, ['show', '--name-only', '--format=', rev]).split('\n').filter(Boolean).sort()
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
