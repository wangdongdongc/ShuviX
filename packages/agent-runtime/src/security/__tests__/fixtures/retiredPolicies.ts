/**
 * 2026-10-01 从出厂删掉的八份内置策略 —— 原样（去掉 `shuvix-builtin: true`）留作**测试夹具**。
 *
 * 用户裁定「出厂不要硬限制、默认尽可能少问」，这八份不再随包发布；但它们挂靠的执行点
 * （enforceGitOp / enforceDatabase / enforceUrl 的站点门 / L1 调用门 / 命令结构事实 objects.commands…）
 * 都还在，留给用户自写策略。测试把它们当作「用户自己写的一份策略」装进 provider.getUserPolicies，
 * 继续钉住这些执行点的接线与命令解析的覆盖 —— 也顺带证明：用户照抄这几份，就能把门加回来。
 *
 * 只给测试用；产品代码不得导入（同 builtinPolicies/inlineSources.ts 的规矩）。
 */
import { parsePolicyDefinitionFile } from '../../policyFile'
import type { UserPolicyFile } from '../../types'

export type RetiredPolicyName =
  | 'protect-system'
  | 'block-catastrophic-commands'
  | 'protect-bot-files'
  | 'protect-shuvix-config'
  | 'git-safety'
  | 'ask-on-sub-session'
  | 'ask-on-database'
  | 'ask-on-new-site'

const RAW = import.meta.glob('./*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** 夹具 md 原文（e2e 把它写进隔离实例的 ~/.shuvix/policies/ 时用） */
export function retiredPolicyMd(name: RetiredPolicyName): string {
  const raw = RAW[`./${name}.md`]
  if (raw === undefined) throw new Error(`no retired policy fixture '${name}'`)
  return raw
}

/** 解析好的用户策略（文件名 = `<name>.md`），可直接塞进 provider.getUserPolicies 的返回值 */
export function retiredPolicy(name: RetiredPolicyName): UserPolicyFile {
  const parsed = parsePolicyDefinitionFile(retiredPolicyMd(name), name, (msg) => {
    throw new Error(msg)
  })
  if (!parsed) throw new Error(`retired policy fixture '${name}' failed to parse`)
  return { ...parsed, fileName: `${name}.md` }
}
