import { BUILTIN_HOOK_SPECS, BUILTIN_POLICY_SPECS } from '@shuvix/agent-runtime'
import {
  isDisableableObjectId,
  parseObjectId,
  type MdObjectKind
} from '@shuvix/chat-protocol/mdMeta'

/**
 * 这个对象 id 有没有禁用开关（ShuviX 扩展元数据，chat-protocol MD_DISABLEABLE_KINDS）：内置形态、类型与
 * `kind` 一致、名字真在随包的 spec 里。持有它的文件（内置本身，或沿用了内置 id 的覆盖副本）才给开关 ——
 * mdMetaService 的写入口、hookService / policyService 的列表与笔记视图共用这一个判定，免得侧栏给出一个
 * 点了必然失败的开关（手写的 `hook:builtin:不存在`），或 hook 文件上出现一个其实在切策略的开关。
 * 不给 `kind` = 只看 id 本身（写入口用：按 id 里的类型段核对）。
 */
export function isKnownDisableableBuiltin(objectId: string, kind?: MdObjectKind): boolean {
  if (!isDisableableObjectId(objectId)) return false
  const parsed = parseObjectId(objectId)
  if (parsed?.form !== 'builtin') return false
  if (kind && parsed.kind !== kind) return false
  const specs = parsed.kind === 'hook' ? BUILTIN_HOOK_SPECS : BUILTIN_POLICY_SPECS
  return specs.some((spec) => spec.name === parsed.name)
}
