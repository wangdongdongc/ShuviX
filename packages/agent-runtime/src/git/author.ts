/**
 * commit 署名解析 —— 四级解析链，两端共用（差异只在 env.resolveAuthorFallback）：
 *
 * 1. params.authorName + params.authorEmail（两者都给才生效 —— 扩展端的逃生口）
 * 2. 仓库 .git/config 的 user.name / user.email（isomorphic-git getConfig）
 * 3. env.resolveAuthorFallback()（桌面解析 ~/.gitconfig [user] 段；扩展不注入）
 * 4. 全缺 → 返回 undefined，由 commitOp 转为业务错误（AUTHOR_MISSING_MESSAGE）
 *
 * 明确不做：固定 ShuviX 署名（错误归属比报错更糟）、隐式写回 config。committer 恒等于 author。
 */
import * as git from 'isomorphic-git'
import type { GitAuthor, GitCache, GitEnv } from './env'
import type { GitOpParams } from './ops'

/** author 无法解析时 commit 返回的业务错误文案（details.error 与 text 均含此句） */
export const AUTHOR_MISSING_MESSAGE =
  'Cannot commit: no author identity. Pass authorName and authorEmail to this commit call (ask the user for their name/email if unknown), or configure user.name/user.email in the repository .git/config.'

/**
 * 按上述解析链解析 commit 署名；1/2/3 级都无命中时返回 undefined（不抛错）。
 * name/email 必须同时齐备才算命中（config 只有其一时继续走下一级）。
 */
export async function resolveAuthor(
  env: GitEnv,
  cache: GitCache,
  params: Pick<GitOpParams, 'authorName' | 'authorEmail'>
): Promise<GitAuthor | undefined> {
  void cache // getConfig 不消费 cache；保留参数以统一 op 签名
  if (params.authorName && params.authorEmail) {
    return { name: params.authorName, email: params.authorEmail }
  }
  const { fs, dir } = env
  const name = await git.getConfig({ fs, dir, path: 'user.name' })
  const email = await git.getConfig({ fs, dir, path: 'user.email' })
  if (name && email) return { name: String(name), email: String(email) }
  if (env.resolveAuthorFallback) {
    const fb = await env.resolveAuthorFallback()
    if (fb?.name && fb?.email) return fb
  }
  return undefined
}
