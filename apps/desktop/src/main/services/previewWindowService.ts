/**
 * 文件预览窗口 —— 应用里「点开一个文件」（Files 面板、笔记本 [[双链]]、对话里的文件链接、
 * 工具卡片的缩略图、音视频 dock 的展开）统一在独立窗口里打开，不再落到右侧面板：
 *
 *  - md（.md / .markdown）→ 协作编辑窗口（markdownWindowService，与从系统打开的 md 同一个窗口）；
 *  - 其余能预览的（文本 / 代码、图片、PDF、音视频、Office、电子书）→ 本服务的只读预览窗口；
 *  - 不支持预览的（二进制、超过上限、读不了）→ **不响应**：不开窗、不提示，只记一行日志。
 *
 * 能不能预览由共享内核 classifyPreviewFile 判（只 stat + 最多读前 8KB），与窗口里 files.read
 * 用的是同一份判定，「开不开窗」与「窗里显示什么」不会漂移。
 *
 * 预览窗口不建会话：它借发起请求那一刻的活跃会话 id 读文件（files.read / shuvix-preview:// 都按
 * 会话解析相对路径，而这里交过去的永远是绝对路径），所以会话之后被删了也照样读得出来。
 * 同一个文件（按真实路径）只开一个窗口，再打开就把已有的窗口带到前面。
 */
import { BrowserWindow } from 'electron'
import { basename, isAbsolute, join } from 'path'
import { realpathSync } from 'fs'
import { classifyPreviewFile, isPreviewable } from '@shuvix/agent-runtime'
import { sessionService } from './sessionService'
import { openMarkdownFile } from './markdownWindowService'
import { guardAppWindow } from './externalOpen'
import { isMarkdownPath } from '../utils/markdownFiles'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { createLogger } from '../logger'
import { loadRendererPage } from '../utils/rendererPage'

const log = createLogger('PreviewWindow')

/** 新窗口相对上一个错开的像素（连开几个文件时不完全叠在一起） */
const CASCADE_STEP = 24
const WINDOW_CSS_WIDTH = 900
const WINDOW_HEIGHT = 760

interface PreviewWindowDeps {
  getThemeBgColor: () => string
  /** 用户的 UI 缩放（zoomFactor）：页面按它缩放，窗口宽度也得跟着换算 */
  getZoomFactor: () => number
}

let deps: PreviewWindowDeps | null = null

/** 真实路径 → 打开着的预览窗口 */
const windows = new Map<string, BrowserWindow>()

export function initPreviewWindowService(options: PreviewWindowDeps): void {
  deps = options
}

/** 真实路径（解开符号链接、macOS 上取磁盘上的大小写）—— 同一个文件的不同写法落到同一个窗口 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

export interface OpenFileParams {
  /** 发起请求时的活跃会话（相对路径按它的工作目录解析；预览窗口读文件时借用它的 id） */
  sessionId: string
  /** 绝对路径，或相对该会话工作目录的路径 */
  path: string
  /** 谁发起的：'agent' 时预览顶栏亮出来源横幅与完整路径 */
  openedBy?: 'agent' | 'user'
}

/**
 * 在独立窗口里打开一个文件（md → 协作编辑窗口；其余可预览的 → 预览窗口；其余不响应）。
 * @returns 是否有一个窗口在显示这个文件（新开的或已有的）
 */
export async function openFileInWindow(params: OpenFileParams): Promise<boolean> {
  const workingDirectory = sessionService.getById(params.sessionId)?.workingDirectory
  // 相对路径只有会话的工作目录能解；会话没了又给的是相对路径 → 解不出来，不响应
  if (!isAbsolute(params.path) && !workingDirectory) {
    log.warn(`会话没有工作目录，无法解析相对路径，忽略: ${params.path}`)
    return false
  }
  const absolute = resolveReadPath(params.path, workingDirectory ?? '')

  const path = canonicalPath(absolute)
  // 是不是 md 两头都认（与 md 窗口同口径）：点的是 `notes.md`，或它链到一个 md
  if (isMarkdownPath(absolute) || isMarkdownPath(path)) return openMarkdownFile(absolute)

  if (!deps) {
    log.error(`服务未初始化，忽略 ${path}`)
    return false
  }

  // 已经开着就带到前面 —— 先于分类：文件此刻读不了（被删、被换成二进制）也该让用户看到那扇窗
  const open = windows.get(path)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.show()
    open.focus()
    return true
  }

  const cls = await classifyPreviewFile(nodeFileSystemPort, path)
  if (!isPreviewable(cls)) {
    log.info(`不支持预览（${cls.kind}），不响应: ${path}`)
    return false
  }
  return openPreviewWindow(deps, path, params.sessionId, params.openedBy ?? 'user')
}

function openPreviewWindow(
  deps: PreviewWindowDeps,
  path: string,
  sessionId: string,
  openedBy: 'agent' | 'user'
): boolean {
  const fileName = basename(path)
  const offset = windows.size * CASCADE_STEP
  const anchor = BrowserWindow.getFocusedWindow()?.getBounds()
  const win = new BrowserWindow({
    width: Math.round(WINDOW_CSS_WIDTH * deps.getZoomFactor()),
    height: WINDOW_HEIGHT,
    ...(anchor ? { x: anchor.x + CASCADE_STEP + offset, y: anchor.y + CASCADE_STEP + offset } : {}),
    minWidth: 360,
    minHeight: 300,
    title: fileName,
    show: false,
    backgroundColor: deps.getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // 与主窗口同样的守卫：内容里的链接点开走系统浏览器，而不是把这个窗口带去外站
  guardAppWindow(win)
  windows.set(path, win)
  log.info(`打开 ${path} session=${sessionId}`)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  // 页面自己的 <title> 不该盖掉文件名
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => {
    if (windows.get(path) === win) windows.delete(path)
  })

  const query = new URLSearchParams({ sessionId, path, openedBy })
  loadRendererPage(win, `file-preview?${query.toString()}`)
  return true
}
