import { useEffect } from 'react'
import { create } from 'zustand'
import { useChatStore } from '@shuvix/chat-ui'

/**
 * 独立预览面板状态（会话无关，跨端共享）。
 *
 * 预览目标 = { absPath, sessionId 快照 }：sessionId 在请求时刻从活跃会话捕获，此后与
 * 会话切换解耦 —— 面板展示的内容不随切会话而变/关（「session 无关」语义）；读取仍经
 * files.read({ sessionId, path })，沿用该会话的准入/工作目录上下文。
 *
 * 面板的「露出方式」由宿主决定：桌面主窗 = 右侧面板 preview tab；扩展 / 桌面悬浮窗 =
 * PreviewOverlay 覆盖层（target 非空即显示）。store 本身不含宿主视图状态。
 */
export interface PreviewTarget {
  /** UI 路径空间的绝对路径（桌面=宿主机绝对路径；扩展=root.name/rel） */
  absPath: string
  /** 请求时刻的会话 id（files.read 的准入/根上下文） */
  sessionId: string
  /** 单调递增，同一文件重复请求也能触发宿主揭示副作用 */
  nonce: number
  /** 谁发起的预览 —— 'agent' 时 FilePreview 顶部显示来源横幅并亮出完整路径 */
  openedBy: 'agent' | 'user'
}

interface PreviewPanelState {
  target: PreviewTarget | null
  show: (absPath: string, sessionId: string, openedBy?: 'agent' | 'user') => void
  close: () => void
}

export const usePreviewPanelStore = create<PreviewPanelState>((set, get) => ({
  target: null,
  show: (absPath, sessionId, openedBy = 'user') =>
    set({ target: { absPath, sessionId, openedBy, nonce: (get().target?.nonce ?? 0) + 1 } }),
  close: () => set({ target: null })
}))

/**
 * filePreviewRequest → 预览面板目标（宿主常驻组件内调用一次）。
 *
 * chatStore.filePreviewRequest 是「打开某文件预览」的唯一信号（preview 工具事件 /
 * 笔记本 [[wiki-link]] / Files 面板点击文件都走它）；此桥把信号落为预览目标
 * （sessionId 取信号时刻的活跃会话）。宿主若需额外揭示动作（如桌面展开右侧面板并
 * 切到 preview tab），自行再订阅信号叠加。enabled=false 时忽略（如 WebUI 只读端）。
 */
export function usePreviewRequestBridge(enabled = true): void {
  const request = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!enabled || !request) return
    const sessionId = useChatStore.getState().activeSessionId
    if (sessionId)
      usePreviewPanelStore.getState().show(request.absPath, sessionId, request.openedBy)
  }, [request, enabled])
}
