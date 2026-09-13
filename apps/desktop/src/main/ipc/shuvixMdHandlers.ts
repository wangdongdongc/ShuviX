import { ipcMain } from 'electron'
import { validateShuvixMdText } from '@shuvix/agent-runtime'

/**
 * shuvix 契约 md 的解析器级校验 —— frontmatter 属性卡（app-shell）经 ChatApi
 * `shuvixMd.validate` 调用。纯函数复用 agent-runtime 的真解析器（合法性语义的
 * 唯一事实源），无状态、不落盘。
 */
export function registerShuvixMdHandlers(): void {
  ipcMain.handle(
    'shuvixMd:validate',
    (_event, params: { type: string; text: string; name?: string }) =>
      validateShuvixMdText(params.type, params.text, params.name)
  )
}
