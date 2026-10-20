/**
 * 写入回执里的一句「用 `shuvix policy check` 核对」（file 工具的 `writtenNote` 缝）+ 判一份策略管不管网络主体。
 * 刻意轻：只依赖解析器 —— file 工具的依赖图里不该拖进网络服务（policyCheck.ts 引的 policyGate 会连带路由与服务）。
 */
import { basename } from 'path'
import { parsePolicyDefinitionFile, type ParsedPolicyFile } from '@shuvix/agent-runtime'

/** 这份策略有没有点名 `network` 主体的规则（规则级的 subject.kind 优先，没写就看 scope） */
export function namesNetwork(policy: ParsedPolicyFile): boolean {
  return policy.rules.some((rule) => {
    const kinds = rule.conditions?.['subject.kind'] ?? policy.scope?.['subject.kind']
    return kinds?.includes('network') === true
  })
}

const POLICY_MARKER = /^shuvix:\s*policy\b/m

/** 刚写下的是一份管网络的合法策略 → 回执里那一句；否则 null（非法的已经有解析器的话了） */
export function networkPolicyCheckHint(path: string, text: string): string | null {
  if (!POLICY_MARKER.test(text)) return null
  const parsed = parsePolicyDefinitionFile(text, basename(path).replace(/\.md$/i, ''))
  if (!parsed || !namesNetwork(parsed)) return null
  return (
    `This policy decides network access. Before telling the user it is done, check it: ` +
    `\`shuvix policy check ${path}\` shows which devices get in and what each may do, as if it were installed.`
  )
}
