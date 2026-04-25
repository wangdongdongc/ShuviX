import { EXPLORE } from './explore'
import { RESEARCH } from './research'
import type { BuiltinSubAgentDef } from './types'

/** 所有内置 sub-agent 定义，注册顺序 = UI 展示顺序 */
export const BUILTIN_SUB_AGENTS: readonly BuiltinSubAgentDef[] = [EXPLORE, RESEARCH]

export type { BuiltinSubAgentDef } from './types'
