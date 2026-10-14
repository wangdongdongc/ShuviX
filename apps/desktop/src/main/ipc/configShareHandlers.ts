import { defineHandler } from './registry'
import { configShareService } from '../services/configShareService'
import type {
  ConfigSharePayload,
  ExportOptions,
  ImportSelection
} from '@shuvix/chat-protocol/types/configShare'

/**
 * 配置导出/导入 IPC 处理器
 */
export function registerConfigShareHandlers(): void {
  defineHandler('config:buildExportSnapshot', () => {
    return configShareService.buildExportSnapshot()
  })

  defineHandler('config:buildExportPayload', (_ctx, options: ExportOptions) => {
    return configShareService.buildExportPayload(options)
  })

  defineHandler('config:parseImportPayload', (_ctx, encoded: string) => {
    return configShareService.parseImportPayload(encoded)
  })

  defineHandler('config:planImport', (_ctx, payload: ConfigSharePayload) => {
    return configShareService.planImport(payload)
  })

  defineHandler(
    'config:applyImport',
    async (_ctx, params: { payload: ConfigSharePayload; selection: ImportSelection }) => {
      // providers.changed 由 configShareService.applyImportPayload 在服务层发布
      return configShareService.applyImportPayload(params.payload, params.selection)
    }
  )
}
