/**
 * 原生 CDP 方法边界策略 —— `cdp` action 的单一真源拦截表。
 *
 * 只拦越出 tab 边界或绕过用户级安全设置的方法（会话劫持、Browser 全局、证书豁免）；
 * 已知域内的其余方法直接执行（无审批门控）。未知域默认 blocked（fail-safe）。
 */

/**
 * 整域拒绝 + 原因（对 agent 可读，指向替代路径）。
 * Tracing 是浏览器级端点，per-tab debugger（两端）都打不通 —— 完整 trace 走宿主专属方案（P2）。
 */
const BLOCKED_DOMAINS: Record<string, string> = {
  Browser: 'browser-wide control is outside the tab boundary',
  Target: 'target/session management could hijack other tabs',
  Tethering: 'port forwarding is outside the automation scope',
  SystemInfo: 'system information is outside the tab boundary',
  Tracing: 'tracing is a browser-level endpoint, unavailable on per-tab CDP'
}

/** 域内点名拒绝的方法（域本身可用） */
const BLOCKED_METHODS: Record<string, string> = {
  'Page.close': 'closes the tab out-of-band — use the close_tab action instead',
  'Page.crash': 'intentionally crashing the page is not allowed',
  'Security.setIgnoreCertificateErrors': 'certificate trust is a user-level setting',
  'Network.setUserAgentOverride': 'use Emulation.setUserAgentOverride (gated) instead'
}

/** 已知域（未列出的域一律 blocked——fail-safe） */
const KNOWN_DOMAINS = new Set([
  'Accessibility',
  'Animation',
  'Audits',
  'BackgroundService',
  'CacheStorage',
  'Console',
  'CSS',
  'Database',
  'Debugger',
  'DeviceOrientation',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'DOMStorage',
  'Emulation',
  'EventBreakpoints',
  'Fetch',
  'HeapProfiler',
  'IndexedDB',
  'Input',
  'Inspector',
  'IO',
  'LayerTree',
  'Log',
  'Media',
  'Memory',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'PerformanceTimeline',
  'Profiler',
  'Runtime',
  'Schema',
  'Security',
  'ServiceWorker',
  'Storage',
  'WebAudio',
  'WebAuthn'
])

/** 检查一个 CDP 方法（"Domain.method" 形式）是否被拦截；返回拦截原因，可执行返回 null */
export function blockedCdpReason(method: string): string | null {
  const dot = method.indexOf('.')
  if (dot <= 0 || dot === method.length - 1) {
    return 'malformed method — expected "Domain.method"'
  }
  const domain = method.slice(0, dot)

  const domainReason = BLOCKED_DOMAINS[domain]
  if (domainReason) return domainReason
  if (!KNOWN_DOMAINS.has(domain)) {
    return `unknown CDP domain "${domain}"`
  }
  return BLOCKED_METHODS[method] ?? null
}

// ====== uid 宏 ======
//
// 打通 A11y snapshot 的 uid 体系与原生协议：params 里任何位置可写
//   { "$uid": "e7" }   → 解析为该元素的 backendNodeId（数字）
//   { "$uidX": "e7" }  → 元素中心 x 坐标
//   { "$uidY": "e7" }  → 元素中心 y 坐标
// 使 DOM.scrollIntoViewIfNeeded / CSS.getMatchedStylesForNode / Input.dispatchMouseEvent(hover)
// 等方法直接复用 snapshot 产物。

interface UidResolver {
  getNode(uid: string): { backendDOMNodeId?: number } | undefined
  resolveCoordinates(uid: string): Promise<{ x: number; y: number }>
}

function macroKey(value: unknown): '$uid' | '$uidX' | '$uidY' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1) return null
  const k = keys[0]
  return k === '$uid' || k === '$uidX' || k === '$uidY' ? k : null
}

/** 递归解析 params 中的 uid 宏；同一 uid 的坐标解析在一次调用内缓存 */
export async function resolveUidMacros(
  value: unknown,
  controller: UidResolver,
  coordCache = new Map<string, { x: number; y: number }>()
): Promise<unknown> {
  const key = macroKey(value)
  if (key) {
    const uid = String((value as Record<string, unknown>)[key])
    if (key === '$uid') {
      const backendId = controller.getNode(uid)?.backendDOMNodeId
      if (backendId == null) {
        throw new Error(
          `Unknown uid "${uid}" — take a snapshot first, uids come from the latest snapshot.`
        )
      }
      return backendId
    }
    let coords = coordCache.get(uid)
    if (!coords) {
      coords = await controller.resolveCoordinates(uid)
      coordCache.set(uid, coords)
    }
    return key === '$uidX' ? coords.x : coords.y
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => resolveUidMacros(v, controller, coordCache)))
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = await resolveUidMacros(v, controller, coordCache)
    }
    return out
  }
  return value
}
