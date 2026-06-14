/**
 * WidgetExporter —— 把 widget 目录导出成一个独立可运行的 Vite 项目。
 *
 * 生成结构：
 *   <target>/
 *     package.json / vite.config.ts / tsconfig.json / tsconfig.node.json
 *     index.html / .gitignore / EXPORT_NOTES.md
 *     src/index.css
 *     <widget 源文件原样拷贝，排除 widget.json>
 *
 * 约束：目标目录必须不存在或为空；目标不能是 homedir / ~/.shuvix/ 内 / widget 源目录本身。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { widgetService } from './widgetService'
import { bundlerResourcePath } from '../bundler'
import { createLogger } from '../../logger'
import { EXPORTED_VERSIONS } from './exportedVersions'

const log = createLogger('WidgetExporter')

export type WidgetExportErrorCode =
  | 'WIDGET_NOT_FOUND'
  | 'TARGET_NOT_EMPTY'
  | 'INVALID_PATH'
  | 'COPY_FAILED'

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
  filesWritten: string[]
  targetPath: string
}

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
 * 导出 widget 为独立 Vite 项目。
 * 约定：调用方已完成 targetPath 的外部授权（UI 走 dialog、tool 走 assertSandboxWrite）
 */
export async function exportWidget(params: {
  id: string
  targetPath: string
}): Promise<ExportWidgetResult> {
  const widget = widgetService.getById(params.id)
  if (!widget) {
    throw new WidgetExportError('WIDGET_NOT_FOUND', `Widget "${params.id}" not found.`)
  }

  const targetPath = resolve(params.targetPath)
  validateTargetPath(targetPath, widget.id)

  const createdTarget = !existsSync(targetPath)
  if (!createdTarget) {
    const entries = readdirSync(targetPath)
    if (entries.length > 0) {
      throw new WidgetExportError(
        'TARGET_NOT_EMPTY',
        `Target directory is not empty: ${targetPath}. Please pick or create an empty folder.`
      )
    }
  } else {
    mkdirSync(targetPath, { recursive: true })
  }

  const filesWritten: string[] = []
  try {
    const placeholders = buildPlaceholders(widget)

    // 1) 按模板目录递归写入生成文件（.tmpl 后缀 → 插值后去掉后缀）
    writeTemplateTree(getExportTemplateDir(), targetPath, placeholders, filesWritten)

    // 2) 拷贝 widget 源文件（排除 widget.json）—— 与模板文件若同名则模板不会被覆盖（cpSync 的 force:false）
    const widgetDir = widgetService.getWidgetDir(widget.id)
    copyWidgetSources(widgetDir, targetPath, filesWritten)

    log.info(
      `Exported widget "${widget.id}" → ${targetPath} (${filesWritten.length} files written)`
    )
    return { filesWritten, targetPath }
  } catch (err) {
    if (err instanceof WidgetExportError) throw err
    // 本次创建的目录失败则清理；用户预先选的目录不动
    if (createdTarget) {
      try {
        rmSync(targetPath, { recursive: true, force: true })
      } catch (cleanupErr) {
        log.warn(`Cleanup failed for ${targetPath}:`, cleanupErr)
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new WidgetExportError('COPY_FAILED', `Export failed: ${msg}`)
  }
}

/** 禁止 target 指向敏感目录或 widget 源目录本身 */
function validateTargetPath(targetPath: string, widgetId: string): void {
  const home = resolve(homedir())
  const shuvix = resolve(join(homedir(), '.shuvix'))
  const widgetDir = resolve(widgetService.getWidgetDir(widgetId))

  if (targetPath === home) {
    throw new WidgetExportError('INVALID_PATH', 'Target path cannot be the home directory.')
  }
  if (
    targetPath === shuvix ||
    targetPath.startsWith(shuvix + '/') ||
    targetPath.startsWith(shuvix + '\\')
  ) {
    throw new WidgetExportError(
      'INVALID_PATH',
      `Target path cannot be inside the ShuviX data directory (${shuvix}).`
    )
  }
  if (
    targetPath === widgetDir ||
    targetPath.startsWith(widgetDir + '/') ||
    targetPath.startsWith(widgetDir + '\\')
  ) {
    throw new WidgetExportError(
      'INVALID_PATH',
      'Target path cannot be inside the widget source directory itself.'
    )
  }
}

/**
 * 递归处理模板目录：
 *   foo.tmpl  → 读取内容 → 插值 → 写入 foo（去掉 .tmpl 后缀）
 *   foo       → 原样写入（二进制安全地用 Buffer 读写）
 *   子目录    → 递归
 */
function writeTemplateTree(
  templateRoot: string,
  targetRoot: string,
  placeholders: Placeholders,
  filesWritten: string[]
): void {
  const entries = readdirSync(templateRoot, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(templateRoot, entry.name)
    if (entry.isDirectory()) {
      const destDir = join(targetRoot, entry.name)
      mkdirSync(destDir, { recursive: true })
      writeTemplateTree(srcPath, destDir, placeholders, filesWritten)
      continue
    }
    const isTmpl = entry.name.endsWith('.tmpl')
    const destName = isTmpl ? entry.name.slice(0, -'.tmpl'.length) : entry.name
    const destPath = join(targetRoot, destName)
    mkdirSync(dirname(destPath), { recursive: true })
    if (isTmpl) {
      const raw = readFileSync(srcPath, 'utf-8')
      writeFileSync(destPath, interpolate(raw, placeholders), 'utf-8')
    } else {
      // 非模板文件原样拷贝（支持二进制）
      cpSync(srcPath, destPath, { force: false })
    }
    filesWritten.push(destName)
  }
}

/**
 * 把 widget 源目录合并到 target：
 *   - 排除 widget.json
 *   - 不覆盖模板已生成的文件
 *   - 子目录递归合并（两边都有 src/ 时只补差异）
 */
function copyWidgetSources(widgetDir: string, targetDir: string, filesWritten: string[]): void {
  mergeCopy(widgetDir, targetDir, filesWritten, '', (relPath) => {
    // 根目录下的 widget.json 永不拷贝
    return relPath === 'widget.json'
  })
}

function mergeCopy(
  srcRoot: string,
  destRoot: string,
  filesWritten: string[],
  relDir: string,
  skip: (relPath: string) => boolean
): void {
  const srcDir = join(srcRoot, relDir)
  const destDir = join(destRoot, relDir)
  const entries = readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = relDir ? join(relDir, entry.name) : entry.name
    if (skip(relPath)) continue
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(destPath)) {
        mkdirSync(destPath, { recursive: true })
      }
      mergeCopy(srcRoot, destRoot, filesWritten, relPath, skip)
    } else {
      if (existsSync(destPath)) continue // 不覆盖模板已生成的文件
      cpSync(srcPath, destPath, { force: false })
      filesWritten.push(relPath)
    }
  }
}
