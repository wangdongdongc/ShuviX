/**
 * WidgetService — widget 项目的业务编排
 * - 目录 / manifest 写入
 * - DB 记录同步
 * - 通过 widgetServer 触发打包并返回 URL
 *
 * 注意：widget 目录的会话 allowList 注入由外层调用方（dev 工具 / ipc handler）
 * 在拿到 projectDir 后自行调用 sessionService.addAllowListPatterns 完成，
 * 模块内部不再反向依赖 sessionService。
 */

import { mkdirSync, existsSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { widgetDao, type Widget } from '../../dao/widgetDao'
import { widgetServer } from './widgetServer'
import { getWidgetsDir } from '../../utils/paths'
import { createLogger } from '../../logger'
import { applyWidgetSchema, WidgetDbError } from './widgetDb'

/** 广播 widget 列表 / 服务器状态变更 —— 所有 BrowserWindow 都会收到 */
export function broadcastWidgetChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('widget:changed')
  }
}

const log = createLogger('WidgetService')

const WIDGET_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)+$/

export type WidgetTemplate = 'blank' | 'app'

export interface WidgetSummary {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  openCount: number
  archivedAt: number
}

function toSummary(w: Widget): WidgetSummary {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastOpenedAt: w.lastOpenedAt,
    openCount: w.openCount,
    archivedAt: w.archivedAt
  }
}

export interface InitWidgetParams {
  id: string
  name: string
  description: string
  template: WidgetTemplate
}

export interface InitWidgetResult {
  id: string
  projectDir: string
  url: string
  buildSuccess: boolean
  buildErrors?: string[]
  files: string[]
}

export interface BuildWidgetResult {
  id: string
  url: string
  buildSuccess: boolean
  buildErrors?: string[]
}

class WidgetService {
  /** 获取某个 widget 在本地文件系统上的根目录 */
  getWidgetDir(id: string): string {
    return join(getWidgetsDir(), id)
  }

  validateId(id: string): void {
    if (!WIDGET_ID_REGEX.test(id)) {
      throw new Error(
        `Invalid widget id "${id}". Expected kebab-case with at least one dash, e.g. "json-formatter" or "expr-playground-7a".`
      )
    }
  }

  listActive(): WidgetSummary[] {
    return widgetDao.findAllActive().map(toSummary)
  }

  listArchived(): WidgetSummary[] {
    return widgetDao.findAllArchived().map(toSummary)
  }

  getById(id: string): Widget | undefined {
    return widgetDao.findById(id)
  }

  /**
   * 如果 widget 元数据里保存了 dbSchema，重跑一遍保证 schema/表都在
   * （应用首次启动或 DB 被清理后能自愈）。失败仅记日志，不抛出。
   */
  private async reapplySavedSchemaIfAny(widget: Widget): Promise<void> {
    const saved = widget.metadata?.dbSchema
    if (typeof saved !== 'string' || saved.trim().length === 0) return
    try {
      await applyWidgetSchema(widget.id, saved)
    } catch (e) {
      log.warn(`reapplying saved dbSchema for ${widget.id} failed: ${(e as Error).message}`)
    }
  }

  /** 初始化新 widget —— 写 scaffold 文件 + 插入 DB + 首次打包 */
  async init(params: InitWidgetParams): Promise<InitWidgetResult> {
    this.validateId(params.id)
    if (widgetDao.findById(params.id)) {
      throw new Error(`Widget id "${params.id}" already exists. Choose a different id.`)
    }
    const dir = this.getWidgetDir(params.id)
    if (existsSync(dir)) {
      throw new Error(
        `Widget directory already exists but no DB record: ${dir}. Remove the directory or choose a different id.`
      )
    }
    mkdirSync(dir, { recursive: true })

    const files = this.scaffold(dir, params)
    const now = Date.now()
    const widget: Widget = {
      id: params.id,
      name: params.name,
      description: params.description,
      entryFile: 'index.tsx',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: 0,
      openCount: 0,
      archivedAt: 0,
      metadata: {}
    }
    widgetDao.insert(widget)

    const build = await widgetServer.registerAndBuild(params.id, dir, widget.entryFile)
    const url = widgetServer.getUrl(params.id) ?? ''
    log.info(
      `init widget id=${params.id} success=${build.success} files=${files.length} url=${url}`
    )
    broadcastWidgetChanged()
    return {
      id: params.id,
      projectDir: dir,
      url,
      buildSuccess: build.success,
      buildErrors: build.errors,
      files
    }
  }

  /** 重新打包 —— 未注册时会先从 DB 读取补注册（例如新会话里 AI 调 build 而未经 open） */
  async build(id: string): Promise<BuildWidgetResult> {
    this.validateId(id)
    const widget = widgetDao.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)
    const dir = this.getWidgetDir(id)
    if (!existsSync(dir)) {
      throw new Error(`Widget directory missing: ${dir}`)
    }

    let result: { success: boolean; errors?: string[] }
    if (widgetServer.hasWidget(id)) {
      result = await widgetServer.rebuild(id)
    } else {
      await this.reapplySavedSchemaIfAny(widget)
      result = await widgetServer.registerAndBuild(id, dir, widget.entryFile)
    }
    const url = widgetServer.getUrl(id) ?? ''
    return { id, url, buildSuccess: result.success, buildErrors: result.errors }
  }

  /**
   * 启动单个 widget —— 注册到 server（若未注册）并确保 server 已启动
   * 与 open() 的差异：不更新 lastOpenedAt / openCount，仅用于"启动"按钮
   */
  async startWidget(id: string): Promise<{ url: string; buildSuccess: boolean }> {
    const widget = widgetDao.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)
    const dir = this.getWidgetDir(id)
    if (!existsSync(dir)) {
      throw new Error(`Widget directory missing: ${dir}`)
    }
    let buildSuccess = true
    if (!widgetServer.hasWidget(id)) {
      await this.reapplySavedSchemaIfAny(widget)
      const build = await widgetServer.registerAndBuild(id, dir, widget.entryFile)
      buildSuccess = build.success
    } else {
      await widgetServer.ensureStarted()
    }
    const url = widgetServer.getUrl(id) ?? ''
    broadcastWidgetChanged()
    return { url, buildSuccess }
  }

  /** 停止单个 widget —— 仅从 server 注销，不关闭 server */
  stopWidget(id: string): void {
    widgetServer.unregisterWidget(id)
    broadcastWidgetChanged()
  }

  /** 侧边栏卡片点击 —— 惰性启动 server，确保注册，更新计数 */
  async open(id: string): Promise<{ url: string; widget: WidgetSummary }> {
    const widget = widgetDao.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)
    const dir = this.getWidgetDir(id)
    if (!existsSync(dir)) {
      throw new Error(`Widget directory missing: ${dir}`)
    }
    if (!widgetServer.hasWidget(id)) {
      await this.reapplySavedSchemaIfAny(widget)
      await widgetServer.registerAndBuild(id, dir, widget.entryFile)
    } else {
      // 已注册则确保 server 已启动（首次 registerAndBuild 已启动）
      await widgetServer.ensureStarted()
    }
    widgetDao.markOpened(id)
    const updated = widgetDao.findById(id)!
    const url = widgetServer.getUrl(id) ?? ''
    broadcastWidgetChanged()
    return { url, widget: toSummary(updated) }
  }

  /** 归档 / 取消归档 */
  setArchived(id: string, archived: boolean): void {
    widgetDao.update(id, { archivedAt: archived ? Date.now() : 0 })
    if (archived) {
      widgetServer.unregisterWidget(id)
    }
    broadcastWidgetChanged()
  }

  /**
   * 安装/更新 widget 的 DB schema
   *
   * 流程：
   *   1. 跑 DDL（如失败抛出，metadata 不更新）
   *   2. 成功后把 DDL 字符串写入 widget.metadata.dbSchema
   *
   * 同一 widget 重复调用 = 覆盖式更新 schema（用户加表/索引/迁移走这个）。
   * 应用启动时 widget 注册阶段也会自动重跑一次保证幂等。
   */
  async setDbSchema(id: string, ddl: string): Promise<{ id: string; applied: boolean }> {
    this.validateId(id)
    const widget = widgetDao.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)

    try {
      await applyWidgetSchema(id, ddl)
    } catch (e) {
      if (e instanceof WidgetDbError) {
        throw new Error(`[${e.code}] ${e.message}`)
      }
      throw e
    }

    widgetDao.update(id, {
      metadata: { ...widget.metadata, dbSchema: ddl }
    })
    log.info(`db-init succeeded for widget=${id}`)
    return { id, applied: true }
  }

  /** 删除 widget：移除 DB 记录 + 服务器注册 + 文件目录 */
  delete(id: string): void {
    this.validateId(id)
    widgetServer.unregisterWidget(id)
    const dir = this.getWidgetDir(id)
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        log.error(`Failed to remove widget dir ${dir}:`, err)
      }
    }
    widgetDao.deleteById(id)
    broadcastWidgetChanged()
  }

  rename(id: string, name: string, description?: string): void {
    widgetDao.update(id, {
      name,
      ...(description !== undefined ? { description } : {})
    })
    // 更新 manifest
    const manifestPath = join(this.getWidgetDir(id), 'widget.json')
    if (existsSync(manifestPath)) {
      const widget = widgetDao.findById(id)
      if (widget) this.writeManifest(manifestPath, widget)
    }
    broadcastWidgetChanged()
  }

  /** 停止 widget HTTP 服务器（下次打开时自动重启） */
  stopServer(): void {
    widgetServer.stop()
    broadcastWidgetChanged()
  }

  // ────── scaffold ──────

  private scaffold(dir: string, params: InitWidgetParams): string[] {
    const files: string[] = []
    const widget: Widget = {
      id: params.id,
      name: params.name,
      description: params.description,
      entryFile: 'index.tsx',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: 0,
      openCount: 0,
      archivedAt: 0,
      metadata: {}
    }
    this.writeManifest(join(dir, 'widget.json'), widget)
    files.push('widget.json')

    writeFileSync(join(dir, 'README.md'), this.scaffoldReadme(params), 'utf-8')
    files.push('README.md')

    writeFileSync(join(dir, 'index.tsx'), this.scaffoldIndex(params), 'utf-8')
    files.push('index.tsx')

    if (params.template === 'app') {
      writeFileSync(join(dir, 'App.tsx'), this.scaffoldApp(params), 'utf-8')
      files.push('App.tsx')
    }
    return files
  }

  private writeManifest(path: string, widget: Widget): void {
    const manifest = {
      id: widget.id,
      name: widget.name,
      description: widget.description,
      entryFile: widget.entryFile,
      createdAt: widget.createdAt
    }
    writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8')
  }

  private scaffoldReadme(params: InitWidgetParams): string {
    return `# ${params.name}

${params.description}

> Widget id: \`${params.id}\`

## 用途
在这里描述这个 widget 解决什么问题、主要交互是什么。下次新会话里的 AI 会读这个文件。

## 结构
- \`index.tsx\` — React 入口。host HTML 只提供空的 \`<div id="root"></div>\`，入口文件**必须**在末尾自己调用 \`createRoot(root).render(<Component/>)\` 才会渲染。scaffold 中的挂载块带有"DO NOT DELETE"锚点注释，**重构时请保留**，否则页面会一片空白且无任何报错。
- \`widget.json\` — 元数据（由系统维护，不要手动修改 id）
- 其他组件 / 样式 可按需组织

## 可用依赖
React、ReactDOM、React Router、Tailwind CSS v4 —— 无其他 npm 包。

## 设计规范（维护时也要遵守）
Widget 是**紧凑的单一用途工具**，不是落地页 / 仪表盘。类比：菜单栏小应用、浏览器扩展弹窗。

- **必须支持暗黑模式**：所有颜色 class 都要配 \`dark:\` 变体（Widget 自动跟随 OS 主题）
- **文字小**：正文 \`text-xs\` / \`text-sm\`，标题最多 \`text-base\`；\`font-medium\` 而非 \`font-bold\`
- **空间紧凑**：\`p-3\` / \`gap-2\`；避免 \`p-8\` 大留白
- **无装饰**：不要 hero / 欢迎屏 / 大阴影 / 渐变背景 / 居中窄卡片
- **立即反馈**：本地计算用 \`useMemo\` 实时展示，不加假 loading
- **强调色**：accent 用 \`violet-500\` / \`violet-400\`（与 ShuviX 的 widget 身份一致）
- **表面色**：\`bg-white dark:bg-neutral-950\`（页面），\`bg-neutral-50 dark:bg-neutral-900\`（二级面板）
- **边框**：\`border-neutral-200 dark:border-neutral-800\`
- **文字色**：主 \`text-neutral-900 dark:text-neutral-100\`；次 \`text-neutral-600 dark:text-neutral-400\`

## 扩展记录
<!-- 每次修改后在这里留一行变更说明，帮助下一次维护 -->
`
  }

  private scaffoldIndex(params: InitWidgetParams): string {
    if (params.template === 'app') {
      return `import { createRoot } from 'react-dom/client'
import App from './App'

// ═══════════════════════════════════════════════════════════════════
// ⚠️  MOUNT BOILERPLATE — REQUIRED — DO NOT DELETE
// ───────────────────────────────────────────────────────────────────
// The host HTML only provides <div id="root"></div>. Without the
// createRoot call below the page renders BLANK (no error, no warning).
// If you refactor index.tsx, keep this block at the bottom of the file.
// ═══════════════════════════════════════════════════════════════════
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<App />)
}
`
    }
    // blank 模板：暗色模式友好的紧凑起点，避免 hero / 居中窄卡片等 anti-pattern
    return `import { createRoot } from 'react-dom/client'

/**
 * ${escapeJs(params.name)}
 * 设计规范要点：
 * - 所有颜色都配 dark: 变体（自动跟随系统主题）
 * - 紧凑密集、无 hero、无大阴影、accent 用 violet-500
 */
function Widget() {
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto p-4">
        <header className="mb-4">
          <h1 className="text-base font-semibold">${escapeJs(params.name)}</h1>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            ${escapeJs(params.description)}
          </p>
        </header>
        <section className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-xs text-neutral-600 dark:text-neutral-400">
          编辑{' '}
          <code className="font-mono text-[11px] bg-neutral-200/60 dark:bg-neutral-800 px-1 py-0.5 rounded">
            index.tsx
          </code>{' '}
          开始开发。遵守 <code>README.md</code> 中的设计规范。
        </section>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// ⚠️  MOUNT BOILERPLATE — REQUIRED — DO NOT DELETE
// ───────────────────────────────────────────────────────────────────
// The host HTML only provides <div id="root"></div>. Without the
// createRoot call below the page renders BLANK (no error, no warning).
// If you refactor index.tsx, keep this block at the bottom of the file.
// ═══════════════════════════════════════════════════════════════════
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(<Widget />)
}
`
  }

  private scaffoldApp(params: InitWidgetParams): string {
    return `/**
 * ${escapeJs(params.name)}
 * 设计规范：所有颜色配 dark: 变体、紧凑密集、accent 用 violet-500
 */
export default function App() {
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto p-4">
        <header className="mb-4">
          <h1 className="text-base font-semibold">${escapeJs(params.name)}</h1>
          <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
            ${escapeJs(params.description)}
          </p>
        </header>
        {/* 在这里构建 widget 主体 */}
      </div>
    </div>
  )
}
`
  }
}

function escapeJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/"/g, '\\"')
}

export const widgetService = new WidgetService()
