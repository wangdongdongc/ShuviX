/**
 * 桌面端 environment 动态卡片渲染器（Node os/fs/electron）。
 *
 * 内置卡片的定义/顺序/静态文案已上移到 @shuvix/agent-runtime（跨端共享，内容走共享 i18n），
 * 这里只保留平台相关的 environment 计算 + 把共享定义再导出，避免改动既有 import 路径。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { type as osType, release as osRelease, platform } from 'os'
import { app } from 'electron'
import i18next from 'i18next'
import { formatLanguageDisplay, type BuiltinRenderCtx } from '@shuvix/agent-runtime'

// 共享定义再导出（既有 settingsHandlers / systemPromptService 仍从本模块引用）
export {
  BUILTIN_SECTION_ORDER,
  ENVIRONMENT_SECTION_ID,
  isBuiltinSectionId,
  isDynamicBuiltin,
  getBuiltinTitle,
  getStaticBuiltinContent,
  type BuiltinSectionId,
  type BuiltinRenderCtx
} from '@shuvix/agent-runtime'

/** environment 卡片的动态内容（桌面 Node 实现） */
export function computeEnvironment(ctx: BuiltinRenderCtx): string {
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
  // 注意：工作目录路径不在 environment 卡片里输出，避免与 buildSystemPrompt
  // 中"Project working directory: ..."/"Working directory: ..."行重复。
  // 这里仍然需要 cwd 用来检测是否为 git 仓库。
  const items = [
    `${i18next.t('systemPromptCards.environment.git')}: ${isGit ? 'Yes' : 'No'}`,
    `${i18next.t('systemPromptCards.environment.platform')}: ${platform()}`,
    `${i18next.t('systemPromptCards.environment.shell')}: ${shellName}`,
    `${i18next.t('systemPromptCards.environment.os')}: ${osLine}`,
    `${i18next.t('systemPromptCards.environment.date')}: ${currentDate}`,
    `${i18next.t('systemPromptCards.environment.language')}: ${formatLanguageDisplay(i18next.language)}`,
    `${i18next.t('systemPromptCards.environment.appVersion')}: ShuviX ${appVersion}`
  ]
  return items.map((line) => `- ${line}`).join('\n')
}
