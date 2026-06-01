/**
 * 面板布局持久化 — 统一管理 sidebar/chat/browser 的宽度和开关状态
 *
 * 作用域（scope）按窗口区分：
 * - 主窗口：window.panelLayout
 * - 悬浮窗：window.panelLayout.pinned.<sessionId>
 *
 * 主进程启动主窗口时从主窗口 key 读取窗口宽度；
 * pinnedChatService 在创建/关闭悬浮窗时按 sessionId 维度读写。
 */

/** 当前 renderer window 的作用域（由 URL hash 推导，模块加载时确定一次） */
function detectScope(): string {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  if (hash.startsWith('#pinned-chat')) {
    const qIdx = hash.indexOf('?')
    if (qIdx >= 0) {
      const params = new URLSearchParams(hash.slice(qIdx + 1))
      const sid = params.get('sessionId')
      if (sid) return `pinned.${sid}`
    }
  }
  return 'main'
}

const SCOPE = detectScope()
const SETTINGS_KEY = SCOPE === 'main' ? 'window.panelLayout' : `window.panelLayout.${SCOPE}`

/** 是否为悬浮窗作用域（pinned 窗口可恢复 browserOpen，主窗口由 useAppInit 自己决定） */
export const isPinnedScope = SCOPE !== 'main'

interface PanelLayout {
  sidebarWidth: number
  sidebarOpen: boolean
  chatWidth: number
  browserWidth: number
  browserOpen: boolean
}

/** 合并部分布局字段并持久化（debounce 避免高频写入） */
let pendingUpdate: Partial<PanelLayout> = {}
let timer: ReturnType<typeof setTimeout> | null = null

export function persistPanelLayout(partial: Partial<PanelLayout>): void {
  Object.assign(pendingUpdate, partial)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 200)
}

/** 从持久化 JSON 读取布局，兼容旧 key（previewWidth / previewOpen） */
function parseLayout(raw: string): PanelLayout {
  const parsed = JSON.parse(raw) as Partial<PanelLayout> & {
    previewWidth?: number
    previewOpen?: boolean
  }
  return {
    sidebarWidth: parsed.sidebarWidth ?? 240,
    sidebarOpen: parsed.sidebarOpen ?? true,
    chatWidth: parsed.chatWidth ?? 720,
    browserWidth: parsed.browserWidth ?? parsed.previewWidth ?? 480,
    browserOpen: parsed.browserOpen ?? parsed.previewOpen ?? false
  }
}

async function flush(): Promise<void> {
  timer = null
  const update = pendingUpdate
  pendingUpdate = {}
  try {
    const raw = await window.api?.settings?.get(SETTINGS_KEY)
    const current: PanelLayout = raw
      ? parseLayout(raw)
      : {
          sidebarWidth: 240,
          sidebarOpen: true,
          chatWidth: 720,
          browserWidth: 480,
          browserOpen: false
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
    if (raw) return parseLayout(raw)
  } catch {
    /* ignore */
  }
  return {}
}
