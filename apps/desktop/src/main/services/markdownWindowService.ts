/**
 * 从系统打开的 md 窗口 —— 用户在 Finder / 资源管理器里「用 ShuviX 打开」一个 md 文件，
 * 得到的不是主窗口，而是一个独立的笔记本窗口：live preview 编辑器 + 底部输入卡片。
 *
 * 一个窗口一条**内存会话**（sessionService.create 的 `ephemeral`）：行与对话树都只在内存里，
 * 不进侧栏、不进日历、不记活跃；窗口关掉就删会话，对话随之消失。会话在开窗时就建 —— 编辑器读写
 * 文件都要一个会话 id（工作目录由会话给），而内存会话建出来不落任何东西；Agent 仍是第一次发送时才懒建。
 *
 * 会话的形态：
 *  - 不属于任何项目，工作目录是文件所在的目录（settings.workingDirectory）—— md 里的相对图片能显示，
 *    Agent 的 ls / grep 看得到文件的邻居；
 *  - notebookPath 是文件名（相对工作目录），根档案按形态推导为 `notebook`；
 *  - 事件经本窗口自己的前端绑定送达（主窗口可能根本没开过）。
 *
 * 同一个文件（按真实路径）只开一个窗口，再打开就把已有的窗口带到前面。
 */
import { BrowserWindow } from 'electron'
import { basename, dirname, join, resolve } from 'path'
import { realpathSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { chatFrontendRegistry, type ChatFrontend } from '../frontend/core'
import { sessionService } from './sessionService'
import { guardAppWindow } from './externalOpen'
import { isExistingFile, isMarkdownPath } from '../utils/markdownFiles'
import { createLogger } from '../logger'

const log = createLogger('MarkdownWindow')

/** 新窗口相对上一个错开的像素（同时打开几个文件时不完全叠在一起） */
const CASCADE_STEP = 24

interface MarkdownWindowDeps {
  getThemeBgColor: () => string
  /** 由 main-entry 注入 ElectronFrontend 工厂：service 层不反向依赖 frontend-impl */
  createFrontend: (window: BrowserWindow, id: string) => ChatFrontend
}

let deps: MarkdownWindowDeps | null = null

/** 真实路径 → 打开着的窗口 */
const windows = new Map<string, { window: BrowserWindow; sessionId: string }>()

export function initMarkdownWindowService(options: MarkdownWindowDeps): void {
  deps = options
}

/** 真实路径（解开符号链接、macOS 上取磁盘上的大小写）—— 同一个文件的不同写法落到同一个窗口 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * 在独立窗口里打开一个 md 文件。已经开着就聚焦那个窗口。
 * 不是 md、不存在或不是普通文件的路径只记日志，不开窗。
 *
 * 之后的一切（读写、标题、工作目录）都按**真实路径**走：原子保存是「临时文件 rename 过去」，
 * 对着符号链接做会把链接换成一个普通文件。是不是 md 则两头都认 —— 用户双击的是 `notes.md`，
 * 它指向哪个名字不该让它打不开。
 *
 * @returns 是否有一个窗口在显示这个文件（新开的或已有的）
 */
export function openMarkdownFile(filePath: string): boolean {
  if (!deps) {
    log.error(`服务未初始化，忽略 ${filePath}`)
    return false
  }
  const path = canonicalPath(filePath)
  if (!(isMarkdownPath(filePath) || isMarkdownPath(path)) || !isExistingFile(path)) {
    log.warn(`不是可打开的 md 文件，忽略: ${filePath}`)
    return false
  }

  const open = windows.get(path)
  if (open && !open.window.isDestroyed()) {
    if (open.window.isMinimized()) open.window.restore()
    open.window.show()
    open.window.focus()
    return true
  }

  const fileName = basename(path)
  const session = sessionService.create(
    { title: fileName, notebookPath: fileName },
    { ephemeral: true, workingDirectory: dirname(path) }
  )

  const offset = windows.size * CASCADE_STEP
  const anchor = BrowserWindow.getFocusedWindow()?.getBounds()
  const win = new BrowserWindow({
    width: 960,
    height: 820,
    ...(anchor ? { x: anchor.x + CASCADE_STEP + offset, y: anchor.y + CASCADE_STEP + offset } : {}),
    minWidth: 480,
    minHeight: 400,
    title: fileName,
    show: false,
    backgroundColor: deps.getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // 标题栏的文件代理图标（⌘ 点标题看路径、拖出文件）
  if (process.platform === 'darwin') win.setRepresentedFilename(path)
  // 与主窗口同样的守卫：正文里的链接点开走系统浏览器，而不是把这个窗口带去外站
  guardAppWindow(win)

  const frontend = deps.createFrontend(win, `markdown-window:${session.id}`)
  chatFrontendRegistry.bind(session.id, frontend)
  windows.set(path, { window: win, sessionId: session.id })
  log.info(`打开 ${path} session=${session.id}`)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  // 页面自己的 <title> 不该盖掉文件名
  win.on('page-title-updated', (event) => event.preventDefault())

  win.on('closed', () => {
    if (windows.get(path)?.window === win) windows.delete(path)
    chatFrontendRegistry.unbind(session.id, frontend.id)
    // 删会话 = 停 Agent、杀后台任务、丢内存里的行与对话树、清 tool_results/<id>。工作目录是用户的，不动
    void sessionService
      .delete(session.id)
      .then(() => log.info(`关闭 ${path}，内存会话已删除 session=${session.id}`))
      .catch((err) => log.warn(`删除内存会话失败 session=${session.id}: ${err}`))
  })

  // 编辑器拿**绝对路径**：md 里的相对图片按文档所在目录解析，只在文档路径是绝对路径时才做
  // （LivePreviewEditor 的 resolveMarkdownImageSrc）。会话里的 notebookPath 仍是文件名 ——
  // notebook 档案的提示词说的是「相对工作目录」，给它文件名这句话才准
  const hash = `markdown-window?sessionId=${encodeURIComponent(session.id)}&path=${encodeURIComponent(path)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  return true
}
