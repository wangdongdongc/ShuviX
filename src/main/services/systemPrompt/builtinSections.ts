import { existsSync } from 'fs'
import { join } from 'path'
import { type as osType, release as osRelease, platform } from 'os'
import { app } from 'electron'
import i18next from 'i18next'

/** 内置系统提示词卡片 id（也用作 i18n key 后缀） */
export type BuiltinSectionId =
  | 'identity'
  | 'doing_tasks'
  | 'using_tools'
  | 'executing_actions'
  | 'tone_style'
  | 'environment'

/** 真实顺序的来源——不可被用户拖拽改变 */
export const BUILTIN_SECTION_ORDER: readonly BuiltinSectionId[] = [
  'identity',
  'doing_tasks',
  'using_tools',
  'executing_actions',
  'tone_style',
  'environment'
]

/** 内置卡片合法 id 集合，便于过滤掉残留的过期 id */
const BUILTIN_SECTION_SET: ReadonlySet<BuiltinSectionId> = new Set(BUILTIN_SECTION_ORDER)
export function isBuiltinSectionId(id: string): id is BuiltinSectionId {
  return BUILTIN_SECTION_SET.has(id as BuiltinSectionId)
}

export interface BuiltinRenderCtx {
  /** 当前会话的工作目录（仅用于 environment 卡片检测 git 仓库；不直接输出） */
  workingDirectory?: string
  /** 模型 id（用于 environment 卡片） */
  modelId?: string
  /** 模型显示名（可选） */
  modelDisplayName?: string
}

interface BuiltinSectionDef {
  titleKey: string
  /** 静态文案 i18n key（与 compute 二选一） */
  contentKey?: string
  /** 动态文案生成器（与 contentKey 二选一） */
  compute?: (ctx: BuiltinRenderCtx) => string
}

/** environment 卡片的动态内容 */
function computeEnvironment(ctx: BuiltinRenderCtx): string {
  const cwd = ctx.workingDirectory || process.cwd()
  const isGit = existsSync(join(cwd, '.git'))
  const shellName = (() => {
    const shell = process.env.SHELL || 'unknown'
    if (shell.includes('zsh')) return 'zsh'
    if (shell.includes('bash')) return 'bash'
    if (shell.includes('fish')) return 'fish'
    return shell
  })()
  const osLine = `${osType()} ${osRelease()}`
  const currentDate = new Date().toISOString().slice(0, 10)
  const appVersion = (() => {
    try {
      return app.getVersion()
    } catch {
      return 'unknown'
    }
  })()
  const modelLine = ctx.modelId
    ? ctx.modelDisplayName
      ? `${ctx.modelDisplayName} (${ctx.modelId})`
      : ctx.modelId
    : 'unknown'

  // 注意：工作目录路径不在 environment 卡片里输出，避免与 buildSystemPrompt
  // 中"Project working directory: ..."/"Working directory: ..."行重复。
  // 这里仍然需要 cwd 用来检测是否为 git 仓库。
  const items = [
    `${i18next.t('systemPromptCards.environment.git')}: ${isGit ? 'Yes' : 'No'}`,
    `${i18next.t('systemPromptCards.environment.platform')}: ${platform()}`,
    `${i18next.t('systemPromptCards.environment.shell')}: ${shellName}`,
    `${i18next.t('systemPromptCards.environment.os')}: ${osLine}`,
    `${i18next.t('systemPromptCards.environment.date')}: ${currentDate}`,
    `${i18next.t('systemPromptCards.environment.model')}: ${modelLine}`,
    `${i18next.t('systemPromptCards.environment.appVersion')}: ShuviX ${appVersion}`
  ]
  return items.map((line) => `- ${line}`).join('\n')
}

const BUILTIN_SECTIONS: Record<BuiltinSectionId, BuiltinSectionDef> = {
  identity: {
    titleKey: 'systemPromptCards.identity.title',
    contentKey: 'systemPromptCards.identity.content'
  },
  doing_tasks: {
    titleKey: 'systemPromptCards.doing_tasks.title',
    contentKey: 'systemPromptCards.doing_tasks.content'
  },
  using_tools: {
    titleKey: 'systemPromptCards.using_tools.title',
    contentKey: 'systemPromptCards.using_tools.content'
  },
  executing_actions: {
    titleKey: 'systemPromptCards.executing_actions.title',
    contentKey: 'systemPromptCards.executing_actions.content'
  },
  tone_style: {
    titleKey: 'systemPromptCards.tone_style.title',
    contentKey: 'systemPromptCards.tone_style.content'
  },
  environment: {
    titleKey: 'systemPromptCards.environment.title',
    compute: computeEnvironment
  }
}

/** 取内置卡片的标题（当前 i18n 语言） */
export function getBuiltinTitle(id: BuiltinSectionId): string {
  return i18next.t(BUILTIN_SECTIONS[id].titleKey)
}

/**
 * 取内置卡片的内容文本：
 * - 静态卡片走 i18n
 * - 动态卡片走 compute
 */
export function getBuiltinContent(id: BuiltinSectionId, ctx: BuiltinRenderCtx): string {
  const def = BUILTIN_SECTIONS[id]
  if (def.compute) return def.compute(ctx)
  if (def.contentKey) return i18next.t(def.contentKey)
  return ''
}

/** 卡片是否为动态生成（用于 UI 决定是否显示"预览"按钮） */
export function isDynamicBuiltin(id: BuiltinSectionId): boolean {
  return typeof BUILTIN_SECTIONS[id].compute === 'function'
}
