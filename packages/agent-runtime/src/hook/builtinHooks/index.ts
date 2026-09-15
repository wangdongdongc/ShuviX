/**
 * 内置 hook（md 文件 + 构建器，跨端共享）。
 *
 * 与 builtinAgents 同一交付形态：md 经 `?raw` 内联进 bundle，宿主注册表现算列表，
 * 用户以 `~/.shuvix/hooks/<name>.md` 同名覆盖。加一个内置 hook = md/ 放文件 +
 * 本文件加一条 import 与 spec 条目。
 */
import { buildBuiltinHook, type BuiltinHookDeps, type BuiltinHookSpec } from './spec'
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'
import type { ParsedHookFile } from '../hookFile'

import autoTitleEn from './md/auto-title.md?raw'
import autoTitleZh from './md/auto-title.zh.md?raw'
import autoTitleJa from './md/auto-title.ja.md?raw'

export { buildBuiltinHook, type BuiltinHookDeps, type BuiltinHookSpec } from './spec'

/**
 * 会话自动标题：首条 prompt 起一个快标题，第二轮结束后精修一次；两条绑定都派发内置 `titler`。
 * 三语言整文件回落，只有 `shuvix-displayName` / `description` 随语言变。
 */
export const AUTO_TITLE_HOOK_SPEC: BuiltinHookSpec = {
  name: 'auto-title',
  sources: { en: autoTitleEn, zh: autoTitleZh, ja: autoTitleJa }
}

export const BUILTIN_HOOK_SPECS: readonly BuiltinHookSpec[] = [AUTO_TITLE_HOOK_SPEC]

/** 按宿主 deps 现算全部内置 hook（语言切换自动跟随） */
export function buildBuiltinHooks(deps: BuiltinHookDeps): ParsedHookFile[] {
  return BUILTIN_HOOK_SPECS.map((spec) => buildBuiltinHook(spec, deps)).filter(
    (h): h is ParsedHookFile => h !== null
  )
}

/**
 * 内置 hook 的 md **原文**（设置页只读展示 + 「创建覆盖副本」的初值）。
 * 原文本就以字符串形式躺在 bundle 里（`?raw`），拿来即最保真。未知名返回 null。
 */
export function getBuiltinHookSource(name: string, deps: BuiltinHookDeps = {}): string | null {
  const spec = BUILTIN_HOOK_SPECS.find((s) => s.name === name)
  return spec ? pickLocalizedSource(spec.sources, deps.language) : null
}
