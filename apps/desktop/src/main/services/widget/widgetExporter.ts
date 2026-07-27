/**
 * WidgetExporter —— 把 widget 目录打包成一个独立可运行的 Vite 工程 zip。
 *
 * 产出 <target>/<id>.zip，解压后得到：
 *   <id>/
 *     package.json / vite.config.ts / tsconfig.json / tsconfig.node.json
 *     index.html / EXPORT_NOTES.md
 *     src/index.css
 *     <widget 源文件原样打包，排除 widget.json 与 .git / node_modules / 系统垃圾文件>
 *
 * 为什么是 zip 而不是直接铺目录：导出目标通常落在用户自己的工程里，直接铺文件会把
 * widget 的 .git 变成嵌套仓库、并与目标目录已有文件混在一起；单文件产物边界清楚，
 * 由用户显式解压。归档里带一层以 id 命名的顶层目录，解压不会散落到当前目录。
 *
 * 约束：目标 zip 不能落在 ~/.shuvix 内（widget 源目录本身也在其中）；默认不覆盖已有文件，
 * 仅当调用方已就"这一个具体路径"取得用户确认时才允许覆盖（见 overwrite 参数）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'
import { zipSync, strToU8 } from 'fflate'
import { writeFileAtomic } from '../../utils/atomicWrite'
import { widgetService } from './widgetService'
import { bundlerResourcePath } from '../bundler'
import { createLogger } from '../../logger'
import { EXPORTED_VERSIONS } from './exportedVersions'

const log = createLogger('WidgetExporter')

export type WidgetExportErrorCode =
  | 'WIDGET_NOT_FOUND'
  | 'TARGET_EXISTS'
  | 'INVALID_PATH'
  | 'PACK_FAILED'

export class WidgetExportError extends Error {
  constructor(
    readonly code: WidgetExportErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WidgetExportError'
  }
}

export interface ExportWidgetResult {
  /** 生成的 zip 绝对路径 */
  zipPath: string
  /** 归档内文件条目数 */
  entryCount: number
  /** zip 字节数 */
  byteSize: number
}

/** 任意层级都不进归档：版本库内部、依赖目录、系统垃圾文件 */
const EXCLUDED_ANYWHERE = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

/** 可替换占位符集合 */
interface Placeholders {
  WIDGET_ID: string
  WIDGET_NAME: string
  WIDGET_DESCRIPTION: string
  EXPORT_DATE: string
  REACT_VERSION: string
  REACT_DOM_VERSION: string
  REACT_ROUTER_VERSION: string
  TAILWINDCSS_VERSION: string
  TAILWINDCSS_VITE_VERSION: string
  TYPES_REACT_VERSION: string
  TYPES_REACT_DOM_VERSION: string
  VITEJS_PLUGIN_REACT_VERSION: string
  TYPESCRIPT_VERSION: string
  VITE_VERSION: string
}

function buildPlaceholders(widget: {
  id: string
  name: string
  description: string
}): Placeholders {
  return {
    WIDGET_ID: widget.id,
    WIDGET_NAME: escapeForJson(widget.name),
    WIDGET_DESCRIPTION: escapeForJson(widget.description),
    EXPORT_DATE: new Date().toISOString().slice(0, 10),
    REACT_VERSION: EXPORTED_VERSIONS.react,
    REACT_DOM_VERSION: EXPORTED_VERSIONS['react-dom'],
    REACT_ROUTER_VERSION: EXPORTED_VERSIONS['react-router'],
    TAILWINDCSS_VERSION: EXPORTED_VERSIONS.tailwindcss,
    TAILWINDCSS_VITE_VERSION: EXPORTED_VERSIONS['@tailwindcss/vite'],
    TYPES_REACT_VERSION: EXPORTED_VERSIONS['@types/react'],
    TYPES_REACT_DOM_VERSION: EXPORTED_VERSIONS['@types/react-dom'],
    VITEJS_PLUGIN_REACT_VERSION: EXPORTED_VERSIONS['@vitejs/plugin-react'],
    TYPESCRIPT_VERSION: EXPORTED_VERSIONS.typescript,
    VITE_VERSION: EXPORTED_VERSIONS.vite
  }
}

/** 仅 JSON 字符串值里用到：转义反斜杠和双引号，保持模板能直接替换 */
function escapeForJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function interpolate(template: string, values: Placeholders): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    const v = (values as unknown as Record<string, string>)[key]
    return v !== undefined ? v : match
  })
}

/** 静态模板根目录 */
function getExportTemplateDir(): string {
  return bundlerResourcePath('export-template/widget')
}

/**
 * 归一化导出目标为 zip 文件绝对路径：
 *   以 .zip 结尾   → 就是该文件
 *   其余（目录形态）→ <目录>/<id>.zip
 *
 * 调用方（CLI 准入校验）需要在真正导出前拿到同一个路径，故单独导出。
 */
export function resolveExportZipPath(widgetId: string, requestedTarget: string): string {
  const abs = resolve(requestedTarget)
  return /\.zip$/i.test(abs) ? abs : join(abs, `${widgetId}.zip`)
}

/**
 * 导出 widget 为独立 Vite 工程 zip。
 * 约定：调用方已完成目标路径的外部授权（UI 走 dialog、CLI 走准入校验）
 */
export async function exportWidget(params: {
  id: string
  targetPath: string
  /**
   * 调用方已就"归一化后的这个路径"征得用户同意。UI 仅在保存对话框返回的路径就是最终
   * 写入路径时才置 true（用户输了不带 .zip 的名字时最终路径是别的文件，对话框没问过它）；
   * CLI 无确认通道，恒为 false。
   */
  overwrite?: boolean
}): Promise<ExportWidgetResult> {
  const widget = widgetService.getById(params.id)
  if (!widget) {
    throw new WidgetExportError('WIDGET_NOT_FOUND', `Widget "${params.id}" not found.`)
  }

  const zipPath = resolveExportZipPath(widget.id, params.targetPath)
  validateZipPath(zipPath)

  if (!params.overwrite && existsSync(zipPath)) {
    throw new WidgetExportError(
      'TARGET_EXISTS',
      `A file already exists at ${zipPath}. Pick another path or remove it first.`
    )
  }

  try {
    const placeholders = buildPlaceholders(widget)
    const files: Record<string, Uint8Array> = {}
    // 归档内顶层目录 = widget id，解压即得一个完整工程目录
    const rootDir = widget.id

    // 1) 模板树（.tmpl 插值后去掉后缀）
    collectTemplateTree(getExportTemplateDir(), rootDir, placeholders, files)
    // 2) widget 源文件叠加 —— 与模板同名时模板优先
    collectWidgetSources(widgetService.getWidgetDir(widget.id), rootDir, files)

    const archive = zipSync(files, { level: 6 })
    mkdirSync(dirname(zipPath), { recursive: true })
    // 原子写：中途失败不会在用户报告到的路径上留下一个截断的 zip
    writeFileAtomic(zipPath, archive)

    const entryCount = Object.keys(files).length
    log.info(
      `Exported widget "${widget.id}" → ${zipPath} (${entryCount} entries, ${archive.byteLength} bytes)`
    )
    return { zipPath, entryCount, byteSize: archive.byteLength }
  } catch (err) {
    if (err instanceof WidgetExportError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new WidgetExportError('PACK_FAILED', `Export failed: ${msg}`)
  }
}

/** 禁止把归档写进 ShuviX 数据目录（widget 源目录本身也在其中） */
function validateZipPath(zipPath: string): void {
  const shuvix = resolve(join(homedir(), '.shuvix'))
  if (zipPath === shuvix || zipPath.startsWith(shuvix + sep)) {
    throw new WidgetExportError(
      'INVALID_PATH',
      `Target path cannot be inside the ShuviX data directory (${shuvix}).`
    )
  }
}

/**
 * 递归收集模板目录到归档条目：
 *   foo.tmpl → 插值后以 foo 入档
 *   foo      → 原样入档（二进制安全）
 * zipDir 一律用 '/' 拼接 —— zip 内部路径分隔符与平台无关。
 */
function collectTemplateTree(
  templateRoot: string,
  zipDir: string,
  placeholders: Placeholders,
  files: Record<string, Uint8Array>
): void {
  for (const entry of readdirSync(templateRoot, { withFileTypes: true })) {
    const srcPath = join(templateRoot, entry.name)
    if (entry.isDirectory()) {
      collectTemplateTree(srcPath, `${zipDir}/${entry.name}`, placeholders, files)
      continue
    }
    if (!entry.isFile()) continue
    const isTmpl = entry.name.endsWith('.tmpl')
    const destName = isTmpl ? entry.name.slice(0, -'.tmpl'.length) : entry.name
    files[`${zipDir}/${destName}`] = isTmpl
      ? strToU8(interpolate(readFileSync(srcPath, 'utf-8'), placeholders))
      : new Uint8Array(readFileSync(srcPath))
  }
}

/**
 * 递归收集 widget 源文件到归档条目：
 *   - 根目录的 widget.json 不入档（元数据由 ShuviX 维护，导出后无意义）
 *   - .git / node_modules / 系统垃圾文件任意层级都不入档
 *   - 与模板生成的同名文件冲突时模板优先
 *   - 非普通文件/目录（符号链接等）跳过
 */
function collectWidgetSources(
  widgetDir: string,
  rootDir: string,
  files: Record<string, Uint8Array>
): void {
  const walk = (absDir: string, zipDir: string, isRoot: boolean): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (EXCLUDED_ANYWHERE.has(entry.name)) continue
      if (isRoot && entry.name === 'widget.json') continue
      const absPath = join(absDir, entry.name)
      const key = `${zipDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(absPath, key, false)
        continue
      }
      if (!entry.isFile()) continue
      if (files[key] !== undefined) continue // 模板已生成，不被源文件覆盖
      files[key] = new Uint8Array(readFileSync(absPath))
    }
  }
  walk(widgetDir, rootDir, true)
}
