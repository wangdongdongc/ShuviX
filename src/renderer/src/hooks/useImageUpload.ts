import { useCallback, useState } from 'react'
import { fileToImageData } from '../utils/imageProcessing'
import { useChatStore } from '../stores/chatStore'

/**
 * 图片上传 Hook — 封装文件选择、拖拽、粘贴的图片处理逻辑
 */
export function useImageUpload(modelSupportsVision: boolean) {
  const { addPendingImage } = useChatStore()
  const [isDragging, setIsDragging] = useState(false)

  /** 处理文件列表中的图片 */
  const handleImageFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    for (const file of imageFiles) {
      const imgData = await fileToImageData(file)
      addPendingImage(imgData)
    }
  }, [addPendingImage])

  /** 拖拽进入 */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (modelSupportsVision) setIsDragging(true)
  }, [modelSupportsVision])

  /** 拖拽离开 */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  /** 拖拽释放 */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (!modelSupportsVision) return
    const files = e.dataTransfer.files
    if (files.length > 0) void handleImageFiles(files)
  }, [modelSupportsVision, handleImageFiles])

  /** 粘贴图片 */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!modelSupportsVision) return
    const items = e.clipboardData.items
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) void handleImageFiles(imageFiles)
  }, [modelSupportsVision, handleImageFiles])

  return { isDragging, handleImageFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste }
}
