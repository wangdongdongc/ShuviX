/**
 * 内置工作流（md 文件 + 构建器，跨端共享）。
 *
 * 与 builtinAgents 同一交付形态：md 经 `?raw` 内联进 bundle，宿主注册表现算列表，
 * 用户以 `~/.shuvix/workflows/<name>.md` 同名覆盖。加一个内置工作流 = md/ 放文件 +
 * 本文件加一条 import 与 spec 条目。
 */
import { buildBuiltinWorkflow, type BuiltinWorkflowDeps, type BuiltinWorkflowSpec } from './spec'
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'
import type { ParsedWorkflowFile } from '../workflowFile'

import autoTitleEn from './md/auto-title.md?raw'
import autoTitleZh from './md/auto-title.zh.md?raw'
import autoTitleJa from './md/auto-title.ja.md?raw'
import botChatEn from './md/bot-chat.md?raw'
import botChatZh from './md/bot-chat.zh.md?raw'
import botChatJa from './md/bot-chat.ja.md?raw'

export { buildBuiltinWorkflow, type BuiltinWorkflowDeps, type BuiltinWorkflowSpec } from './spec'

/**
 * 会话自动标题。三语言整文件回落，纪律同 bot-chat：**本地化只许动人读面**
 * （`shuvix-displayName` / `description` / 散文），```js workflow`` 脚本块与
 * ```json schema=`` 块必须与 en 逐字节同（守护测试钉住）—— 行为永远只有一份。
 */
export const AUTO_TITLE_WORKFLOW_SPEC: BuiltinWorkflowSpec = {
  name: 'auto-title',
  sources: { en: autoTitleEn, zh: autoTitleZh, ja: autoTitleJa }
}

/**
 * 聊天会话里每个 bot 跑的管线。**没有 `shuvix-workflow-on`** —— 没有埋点指向它，
 * 由会话按名 invoke（bot md 的 `shuvix-bot-pipeline.workflow` 指向这里）。
 *
 * 三语言整文件回落（同 builtinAgents）；**脚本与 schema 块必须与 en 逐字节同**
 * （守护测试钉住）—— 本地化只许动散文与提示词，行为永远只有一份。
 */
export const BOT_CHAT_WORKFLOW_SPEC: BuiltinWorkflowSpec = {
  name: 'bot-chat',
  sources: { en: botChatEn, zh: botChatZh, ja: botChatJa }
}

export const BUILTIN_WORKFLOW_SPECS: readonly BuiltinWorkflowSpec[] = [
  AUTO_TITLE_WORKFLOW_SPEC,
  BOT_CHAT_WORKFLOW_SPEC
]

/** 按宿主 deps 现算全部内置工作流（语言切换自动跟随） */
export function buildBuiltinWorkflows(deps: BuiltinWorkflowDeps): ParsedWorkflowFile[] {
  return BUILTIN_WORKFLOW_SPECS.map((spec) => buildBuiltinWorkflow(spec, deps)).filter(
    (w): w is ParsedWorkflowFile => w !== null
  )
}

/**
 * 内置工作流的 md **原文**（设置页只读展示 + 「创建覆盖副本」的初值）。
 *
 * 直接回原文而非像 agent/policy 那样序列化解析结果 —— 那两者的内置档案序列化是
 * 既有设计，而工作流正文是「文档散文 + 具名代码块」的混合体：脚本块与说明文字
 * 都无法从解析产物还原。原文本就以字符串形式躺在 bundle 里（`?raw`），拿来即最保真。
 * 未知名返回 null。
 */
export function getBuiltinWorkflowSource(
  name: string,
  deps: BuiltinWorkflowDeps = {}
): string | null {
  const spec = BUILTIN_WORKFLOW_SPECS.find((s) => s.name === name)
  return spec ? pickLocalizedSource(spec.sources, deps.language) : null
}
