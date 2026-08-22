/**
 * WidgetService — widget 项目的业务编排
 * - 目录 / 清单写入
 * - 通过 widgetServer 触发打包并返回 URL
 *
 * 真源是文件系统（widgetRegistry），不再有 widgets 表：
 * 身份在 <dir>/widget.json，DB schema 在 <dir>/schema.sql，
 * 宿主账目（时间戳 / 归档位）在 ~/.shuvix/widgets/.config.json。
 *
 * 注意：widget 目录的会话 allowList 注入由外层调用方在拿到 projectDir 后自行调用
 * sessionService.addAllowListPaths 完成，模块内部不反向依赖 sessionService。
 * 当前只有 cliServer 的 widget.init / widget.build 两个 handler 这么做（智能体经
 * shuvix CLI 自举时给自己开目录权限）；没有走 ipc 的注入路径。
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { widgetRegistry, WIDGET_ID_REGEX, type Widget } from './widgetRegistry'
import { appEventBus } from '../../utils/appEventBus'
import { widgetServer } from './widgetServer'
import { getWidgetsDir } from '../../utils/paths'
import { writeFileAtomic } from '../../utils/atomicWrite'
import { createLogger } from '../../logger'
import { applyWidgetSchema, dropWidgetSchema, WidgetDbError } from './widgetDb'
import { ensureRepo, commitHostChange } from './widgetRepo'

/** 发布 widget 列表 / 服务器状态变更（AppEvent 'widget.changed'，经总线广播到所有窗口） */
export function broadcastWidgetChanged(): void {
  appEventBus.publish({ type: 'widget.changed' })
}

const log = createLogger('WidgetService')

/** DB schema 的落盘文件名 —— 与 widget 子代理政策里约定的 schema.sql 同一份 */
const SCHEMA_FILE = 'schema.sql'

/** schema.sql 内容指纹 —— 用来判断文件里的 DDL 是否就是上次成功应用的那一份 */
function schemaFingerprint(ddl: string): string {
  return createHash('sha256').update(ddl, 'utf8').digest('hex').slice(0, 32)
}

export type WidgetTemplate = 'blank' | 'app'

export interface WidgetSummary {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
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
    return widgetRegistry.findAllActive().map(toSummary)
  }

  listArchived(): WidgetSummary[] {
    return widgetRegistry.findAllArchived().map(toSummary)
  }

  getById(id: string): Widget | undefined {
    return widgetRegistry.findById(id)
  }

  /** widget 的 schema.sql 绝对路径 */
  private schemaPath(id: string): string {
    return join(this.getWidgetDir(id), SCHEMA_FILE)
  }

  /**
   * 若 widget 目录里有 schema.sql，重跑一遍保证 schema/表都在
   * （应用首次启动或 DB 被清理后能自愈）。失败仅记日志，不抛出。
   *
   * 只重放**指纹对得上**的内容。schema.sql 是 agent 可写、且会跟着 git 回退的普通源文件，
   * 无条件重放等于"每次开窗都执行工作区里的任意 SQL"—— 一次没跑过 db-init 的破坏性 DDL
   * 就会在用户毫不知情时落到活库上。指纹不符时跳过并提示改走 db-init（不动数据是安全的失败方向）。
   */
  private async reapplySavedSchemaIfAny(widget: Widget): Promise<void> {
    let saved: string
    try {
      saved = readFileSync(this.schemaPath(widget.id), 'utf-8')
    } catch {
      return // 没有 schema.sql —— 无状态 widget 的正常情况
    }
    if (saved.trim().length === 0) return
    const applied = widgetRegistry.getSchemaHash(widget.id)
    if (!applied) return // 从未经 db-init 应用过：不替用户执行没跑过的 DDL
    if (applied !== schemaFingerprint(saved)) {
      log.warn(
        `${SCHEMA_FILE} of ${widget.id} differs from the last applied schema — skipping replay; run \`shuvix widget db-init\` to apply it`
      )
      return
    }
    try {
      await applyWidgetSchema(widget.id, saved)
    } catch (e) {
      log.warn(`reapplying ${SCHEMA_FILE} for ${widget.id} failed: ${(e as Error).message}`)
    }
  }

  /** 初始化新 widget —— 建目录 + 写清单与 scaffold 文件 + 首次打包 */
  async init(params: InitWidgetParams): Promise<InitWidgetResult> {
    this.validateId(params.id)
    const dir = this.getWidgetDir(params.id)
    // 目录即身份：用不带 recursive 的 mkdir，让 EEXIST 成为原子的重名判据
    // （先 existsSync 再 mkdir 存在 TOCTOU 窗口）
    try {
      mkdirSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Widget id "${params.id}" already exists (directory: ${dir}). Choose a different id, or remove that directory first.`
        )
      }
      throw err
    }

    const now = Date.now()
    const widget: Widget = {
      id: params.id,
      name: params.name,
      description: params.description,
      entryFile: 'index.tsx',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: 0,
      archivedAt: 0
    }
    widgetRegistry.insert(widget)
    const files = ['widget.json', ...this.scaffold(dir, params)]

    // 版本控制自举 —— 干净的 scaffold 就是第一个提交，之后 agent 的首次改动 diff 才可读
    await ensureRepo(dir, `chore(${params.id}): scaffold widget`)

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

  /** 重新打包 —— 未注册时会先读清单补注册（例如新会话里 AI 调 build 而未经 open） */
  async build(id: string): Promise<BuildWidgetResult> {
    this.validateId(id)
    const widget = widgetRegistry.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)
    const dir = this.getWidgetDir(id)
    if (!existsSync(dir)) {
      throw new Error(`Widget directory missing: ${dir}`)
    }

    // 历史遗留 widget（创建时还没有版本控制）在这里补上仓库。agent 的维护流程要求
    // 先 build 再改，正是为了让基线提交落在它的改动之前。
    await ensureRepo(dir, `chore(${id}): baseline of existing widget`)

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
   * 与 open() 的差异：不更新 lastOpenedAt，仅用于"启动"按钮
   */
  async startWidget(id: string): Promise<{ url: string; buildSuccess: boolean }> {
    const widget = widgetRegistry.findById(id)
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
    const widget = widgetRegistry.findById(id)
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
    widgetRegistry.markOpened(id)
    const updated = widgetRegistry.findById(id)!
    const url = widgetServer.getUrl(id) ?? ''
    broadcastWidgetChanged()
    return { url, widget: toSummary(updated) }
  }

  /** 归档 / 取消归档 */
  setArchived(id: string, archived: boolean): void {
    widgetRegistry.update(id, { archivedAt: archived ? Date.now() : 0 })
    if (archived) {
      widgetServer.unregisterWidget(id)
    }
    broadcastWidgetChanged()
  }

  /**
   * 安装/更新 widget 的 DB schema
   *
   * 流程：
   *   1. 跑 DDL（如失败抛出，schema.sql 不更新）
   *   2. 成功后把 DDL 写入 <dir>/schema.sql
   *
   * 只有"确实成功应用过"的 DDL 才会落盘 —— 这条语义是自愈重放能信任 schema.sql 的前提，
   * 也是 db-init 必须由宿主写文件、而不是直接读 agent 给的文件的原因（文件里可能是
   * 从未应用过的文本，比如刚被 git 回退过）。
   * 同一 widget 重复调用 = 覆盖式更新（加表/索引/迁移走这个）；注册阶段会重跑保证幂等。
   */
  async setDbSchema(id: string, ddl: string): Promise<{ id: string; applied: boolean }> {
    this.validateId(id)
    const widget = widgetRegistry.findById(id)
    if (!widget) throw new Error(`Widget "${id}" not found`)

    try {
      await applyWidgetSchema(id, ddl)
    } catch (e) {
      if (e instanceof WidgetDbError) {
        throw new Error(`[${e.code}] ${e.message}`)
      }
      throw e
    }

    const persisted = ddl.endsWith('\n') ? ddl : ddl + '\n'
    writeFileAtomic(this.schemaPath(id), persisted)
    // 记指纹：之后的自愈重放只认这一份内容，别的编辑一律不替用户执行
    widgetRegistry.setSchemaHash(id, schemaFingerprint(persisted))
    log.info(`db-init succeeded for widget=${id}`)
    return { id, applied: true }
  }

  /** 删除 widget：移除服务器注册 + 文件目录 + 宿主账目条目 + 它在共享库里的 schema */
  async delete(id: string): Promise<void> {
    this.validateId(id)
    widgetServer.unregisterWidget(id)
    const dir = this.getWidgetDir(id)
    let dirGone = true
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        dirGone = false
        log.error(`Failed to remove widget dir ${dir}:`, err)
      }
    }
    // 目录还在 = widget 还在（目录即身份）。此时清账目只会让它以"未归档"的面貌复活，
    // 所以宁可留着条目，让状态和事实保持一致。
    if (dirGone) {
      widgetRegistry.deleteById(id)
      // 顺带清掉共享 pglite 里的 schema，否则复用同一个 id 会静默继承旧数据
      await dropWidgetSchema(id)
    } else {
      log.warn(`widget ${id} 目录未能删除，保留其账目条目与数据库 schema`)
    }
    broadcastWidgetChanged()
  }

  async rename(id: string, name: string, description?: string): Promise<void> {
    const dir = this.getWidgetDir(id)
    if (!existsSync(widgetRegistry.manifestPathOf(id))) return
    // 清单就是真源，update 直接改它
    widgetRegistry.update(id, {
      name,
      ...(description !== undefined ? { description } : {})
    })
    // 宿主刚改了工作区文件，顺手提交，免得下次 agent 接手时看到一棵莫名其妙的脏树。
    // 必须 await：改完立刻删除该 widget 时，游离的 git 写入会把已删掉的目录重建出来
    // （isomorphic-git 写文件会 mkdirp），留下一个没有清单的空壳目录占着这个 id。
    // 只暂存 widget.json —— 别把 agent 正在改的文件卷进一个署名 ShuviX 的提交里。
    await commitHostChange(dir, `chore(${id}): sync manifest after rename`, ['widget.json'])
    broadcastWidgetChanged()
  }

  /** 停止 widget HTTP 服务器（下次打开时自动重启） */
  stopServer(): void {
    widgetServer.stop()
    broadcastWidgetChanged()
  }

  // ────── scaffold ──────

  /** 写 scaffold 文件（widget.json 不在此列 —— 清单由 widgetRegistry.insert 落盘） */
  private scaffold(dir: string, params: InitWidgetParams): string[] {
    const files: string[] = []

    writeFileSync(join(dir, '.gitignore'), '.DS_Store\nnode_modules/\n', 'utf-8')
    files.push('.gitignore')

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

> 通用设计规范（紧凑单一用途、强制暗黑模式、调色板）由内置的 **Widget Builder** 子智能体持有，
> 这里不再复述；本文件只记录这个 widget 自己的信息。

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
          开始开发。
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
