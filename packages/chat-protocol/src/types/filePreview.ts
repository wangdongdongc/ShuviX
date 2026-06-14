/**
 * File preview IPC contract — shared between main (filePreviewService) and renderer (FilePreview)
 *
 * Discriminated union over outcome so the renderer can show placeholders for
 * binary / oversized / sandbox-rejected files without surfacing them as Errors.
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
      kind: 'hex'
      path: string
      /** 文件实际字节数；truncated 时 > data.length */
      size: number
      ext: string
      /** 文件前 bytesShown 个字节。走 Electron 结构化克隆原生 Uint8Array 路径，不 base64。
       *  Buffer 是 Uint8Array 子类，主进程可直接返回 Buffer，类型兼容。 */
      data: Uint8Array
      /** data.length，渲染端不必重算 */
      bytesShown: number
      /** size > bytesShown */
      truncated: boolean
      /** 例 "PE (Windows EXE/DLL)" / "PNG image" / "Mach-O 64-bit"；无匹配则 undefined */
      magic?: string
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
