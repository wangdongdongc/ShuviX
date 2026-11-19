/**
 * File preview IPC contract — shared between main (filePreviewService) and renderer (FilePreview)
 *
 * Discriminated union over outcome so the renderer can show placeholders for
 * binary / oversized / sandbox-rejected files without surfacing them as Errors.
 * (Binary files are not previewable — the desktop never opens a preview window for one;
 * `binary` stays as a fallback for a file that turned binary while its window was open.)
 */

export type FileReadResult =
  | {
      kind: 'text'
      path: string
      content: string
      size: number
      lines: number
      ext: string
    }
  | {
      kind: 'image'
      path: string
      mimeType: string
      dataBase64: string
      size: number
      ext: string
      /** 解析自文件头的像素尺寸（不解码）。渲染端据此判断解码内存开销 —— 文件字节数
       *  与解码后大小无关（解压炸弹）。SVG 与无法识别的格式为 undefined，按「未知」放行。 */
      pixelWidth?: number
      pixelHeight?: number
    }
  | {
      kind: 'office'
      path: string
      /** 渲染端渲染器路由：'docx' → docx-preview；'sheet' → SheetJS 表格（xlsx/xlsm/xls/ods） */
      officeKind: 'docx' | 'sheet'
      /** 完整文件字节 base64（读取前已过 PREVIEW_OFFICE_MAX_BYTES 门控） */
      dataBase64: string
      size: number
      ext: string
    }
  | {
      kind: 'ebook'
      /** 绝对路径 —— 渲染端经 useMediaUrl 取字节（桌面 shuvix-preview:// / 扩展 blob:）。
       *  刻意不带 base64：图文书动辄几十 MB，走 IPC 传字节既慢又白涨 33% 体积。 */
      path: string
      /** 解析器路由。三者在渲染端归一成同一个 LoadedBook（见 ebookLoaders） */
      ebookKind: 'epub' | 'fb2' | 'cbz'
      size: number
      ext: string
    }
  | {
      kind: 'binary'
      path: string
      size: number
      ext: string
    }
  | {
      kind: 'pdf'
      /** 绝对路径 —— 渲染端用 sessionId + path 拼 shuvix-preview://... 喂给 iframe */
      path: string
      size: number
      ext: string
    }
  | {
      kind: 'media'
      /** 'video' → <video controls>；'audio' → <audio controls> */
      mediaType: 'video' | 'audio'
      /** 绝对路径 —— 渲染端拼 shuvix-preview:// 流式播放 */
      path: string
      /** 显式 MIME，避免某些容器（mov/webm）自动嗅探失败 */
      mimeType: string
      size: number
      ext: string
    }
  | {
      kind: 'too-large'
      path: string
      size: number
      cap: number
    }
  | {
      kind: 'not-allowed'
      path: string
      reason: string
    }
  | {
      kind: 'error'
      path: string
      message: string
    }

/**
 * 为什么一个文件没能在窗口里打开（`files.open` 拒绝时）—— 发起的窗口据此给一句轻提示：
 *  - `unsupported`：二进制等没有预览方式的文件（`ext` 是扩展名，可能为空）；
 *  - `too-large`：超过这一类文件的预览上限（`size` / `cap` 字节）；
 *  - `missing`：文件不在了；`directory`：是个文件夹；
 *  - `unreadable`：其它读不了的情况（权限、会话没有工作目录解不出相对路径、无头运行 …）。
 */
export type FileOpenRefusal =
  | { reason: 'unsupported'; ext: string }
  | { reason: 'too-large'; size: number; cap: number }
  | { reason: 'missing' }
  | { reason: 'directory' }
  | { reason: 'unreadable' }

/** `files.open` 的结果：开了（新开的或带到前面的已有窗口），或没开及原因 */
export type FileOpenResult = { opened: true } | ({ opened: false } & FileOpenRefusal)
