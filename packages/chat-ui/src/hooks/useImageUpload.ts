import { useCallback, useState } from 'react'
import { fileToImageData } from '../utils/imageProcessing'
import { useChatStore } from '../stores/chatStore'

/** 添加的文件怎么进输入框（图片之外的那条路） */
export interface FileAttachOptions {
  /** 文件在本机的绝对路径（拿不到 → 空串）；不给 = 这个宿主看不到用户设备上的文件（web、Chrome 面板） */
  pathOf?: (file: File) => string
  /** 这些文件以路径引用的方式加进输入框 */
  onPaths: (files: { path: string; name: string }[]) => void
  /** 这些文件加不进来（告诉用户，别让它们消失得无声无息） */
  onRejected: (names: string[]) => void
}

/** useImageUpload 返回值类型 */
export interface UseImageUploadReturn {
  /** 是否正在拖拽中 */
  isDragging: boolean
  /** 分流一批文件：模型能看的图片进待发图片，其余有路径的走路径引用，再其余的报告 */
  handleImageFiles: (files: FileList | File[]) => Promise<void>
  /** 拖拽进入事件处理 */
  handleDragOver: (e: React.DragEvent) => void
  /** 拖拽离开事件处理 */
  handleDragLeave: (e: React.DragEvent) => void
  /** 拖拽释放事件处理 */
  handleDrop: (e: React.DragEvent) => void
  /**
   * 粘贴事件处理。返回 true = 粘贴的是磁盘上的文件、已经处理：调用方不要再贴文字（那段文字只是文件名）。
   * Office 之类复制的「文字 + 图片」没有路径，返回 false，文字照常贴
   */
  handlePaste: (e: React.ClipboardEvent) => boolean
}

/**
 * 文件添加 Hook — 封装文件选择、拖拽、粘贴的分流：模型能看的图片作为图片附上，其余文件有本机路径的走路径引用
 * @param modelSupportsVision 当前模型是否支持视觉输入
 */
export function useImageUpload(
  modelSupportsVision: boolean,
  attach?: FileAttachOptions
): UseImageUploadReturn {
  const { addPendingImage } = useChatStore()
  const [isDragging, setIsDragging] = useState(false)
  const accepts = modelSupportsVision || !!attach?.pathOf

  const handleImageFiles = useCallback(
    async (files: FileList | File[]) => {
      const paths: { path: string; name: string }[] = []
      const rejected: string[] = []
      for (const file of Array.from(files)) {
        if (modelSupportsVision && file.type.startsWith('image/')) {
          try {
            addPendingImage(await fileToImageData(file))
            continue
          } catch {
            // 浏览器解不开的格式（HEIC、TIFF……）：往下当普通文件
          }
        }
        const path = attach?.pathOf?.(file)
        if (path) paths.push({ path, name: file.name })
        else rejected.push(file.name)
      }
      if (paths.length > 0) attach?.onPaths(paths)
      if (rejected.length > 0) attach?.onRejected(rejected)
    },
    [addPendingImage, modelSupportsVision, attach]
  )

  /** 拖拽进入 */
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (accepts) setIsDragging(true)
    },
    [accepts]
  )

  /** 拖拽离开 */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  /** 拖拽释放 */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      const files = e.dataTransfer.files
      if (files.length > 0) void handleImageFiles(files)
    },
    [handleImageFiles]
  )

  /** 粘贴文件 / 图片 */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent): boolean => {
      const files: File[] = []
      for (const item of e.clipboardData.items) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (files.some((file) => attach?.pathOf?.(file))) {
        e.preventDefault()
        void handleImageFiles(files.filter((file) => attach?.pathOf?.(file)))
        return true
      }
      if (modelSupportsVision) {
        const images = files.filter((file) => file.type.startsWith('image/'))
        if (images.length > 0) void handleImageFiles(images)
      }
      // 图片之外的文件没路径：加不进来。模型不能看图时粘贴的截图照旧不作声（它往往只是顺带的，文字才是要贴的）
      const others = files.filter((file) => !file.type.startsWith('image/'))
      if (others.length > 0) attach?.onRejected(others.map((file) => file.name))
      return false
    },
    [modelSupportsVision, handleImageFiles, attach]
  )

  return {
    isDragging,
    handleImageFiles,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste
  } satisfies UseImageUploadReturn
}
