/**
 * 面板布局持久化 — 统一管理 sidebar/chat/preview 的宽度和开关状态
 *
 * 持久化 key: window.panelLayout
 * 主进程启动时从此 key 读取并计算窗口宽度，关闭时保存 chatWidth
 * renderer 侧在面板宽度/开关变化时实时更新
 */

const SETTINGS_KEY = 'window.panelLayout'

interface PanelLayout {
  sidebarWidth: number
  sidebarOpen: boolean
  chatWidth: number
  previewWidth: number
  previewOpen: boolean
}

/** 合并部分布局字段并持久化（debounce 避免高频写入） */
let pendingUpdate: Partial<PanelLayout> = {}
let timer: ReturnType<typeof setTimeout> | null = null

export function persistPanelLayout(partial: Partial<PanelLayout>): void {
  Object.assign(pendingUpdate, partial)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 200)
}

async function flush(): Promise<void> {
  timer = null
  const update = pendingUpdate
  pendingUpdate = {}
  try {
    const raw = await window.api?.settings?.get(SETTINGS_KEY)
    const current: PanelLayout = raw
      ? JSON.parse(raw)
      : {
          sidebarWidth: 240,
          sidebarOpen: true,
          chatWidth: 720,
          previewWidth: 480,
          previewOpen: false
        }
    const merged = { ...current, ...update }
    window.api?.settings?.set({ key: SETTINGS_KEY, value: JSON.stringify(merged) })
  } catch {
    /* ignore */
  }
}

/** 加载持久化的面板布局（应用初始化时调用一次） */
export async function loadPanelLayout(): Promise<Partial<PanelLayout>> {
  try {
    const raw = await window.api?.settings?.get(SETTINGS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return {}
}
