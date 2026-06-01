/**
 * Widget 模块入口 —— 主进程持有的 widget 运行时 + 导出能力。
 *
 * 公共 API：
 * - `widgetService` —— widget 生命周期编排（init/build/rename/archive/delete）
 * - `widgetServer` —— per-process HTTP 服务（/w/<id>/ 路由 + SSE live-reload）
 * - `exportWidget` / `WidgetExportError` —— 导出为独立 Vite 工程
 * - `EXPORTED_VERSIONS` —— 导出时生成的 package.json 依赖版本表
 *
 * 消费方：
 * - src/main/index.ts —— 在应用退出前优雅关闭
 * - src/main/ipc/widgetHandlers.ts —— 向 renderer 暴露 widget:* IPC
 * - src/main/tools/dev.ts —— dev 工具（kind=widget）
 */

export { widgetService } from './widgetService'
export { widgetServer } from './widgetServer'
export { exportWidget, WidgetExportError } from './widgetExporter'
export { EXPORTED_VERSIONS } from './exportedVersions'
export type { ExportedPackageName } from './exportedVersions'
export { runWidgetDbQuery, WidgetDbError } from './widgetDb'
