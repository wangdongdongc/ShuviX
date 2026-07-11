/**
 * 原生 CDP 方法安全分类 —— `cdp` action 的单一真源策略表。
 *
 * 三分类（fail-safe）：
 *   - safe：只读/无副作用（getter、enable/disable、快照类），直接执行；
 *   - mutating：改变页面/浏览器状态（输入、导航、模拟、存储写），走 autoApprove 审批门控；
 *   - blocked：越出 tab 边界或绕过用户级安全设置（会话劫持、Browser 全局、证书豁免），拒绝执行。
 * 未知方法默认 mutating（新 Chrome 版本方法可用但要审批）；未知域默认 blocked。
 */

export type CdpMethodClass = 'safe' | 'mutating' | 'blocked'

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

/** 只读方法名模式（任何已知域下匹配即 safe） */
const SAFE_METHOD_PATTERNS = [
  /^get[A-Z]/, // getResponseBody / getComputedStyleForNode / getDocument …
  /^describe[A-Z]/, // describeNode
  /^query[A-Z]/, // querySelector / querySelectorAll
  /^search[A-Z]/, // searchInResource
  /^request[A-Z]/, // requestNode / requestChildNodes（DOM 检视）
  /^resolve[A-Z]/, // resolveNode / resolveAnimation
  /^capture[A-Z]/, // captureSnapshot / captureScreenshot
  /^collectClassNames/,
  /^takeCoverageDelta$/,
  /^enable$/,
  /^disable$/
]

/** 点名强制 mutating 的方法（模式会误判为 safe，但实际有副作用） */
const MUTATING_METHOD_OVERRIDES = new Set([
  // Fetch.enable 带拦截模式时会挂起所有匹配请求直到显式 continue —— 误用会让页面静默卡死
  'Fetch.enable'
])

/** 点名 safe 的方法（不符合上述模式但确实只读） */
const SAFE_METHODS = new Set([
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Runtime.globalLexicalScopeNames',
  'DOM.pushNodeByPathToFrontend',
  'DOM.getBoxModel',
  'CSS.startRuleUsageTracking',
  'CSS.stopRuleUsageTracking',
  'Profiler.start',
  'Profiler.stop',
  'Performance.getMetrics',
  'IO.read',
  'IO.close',
  'Audits.checkContrast',
  'HeapProfiler.collectGarbage'
])

/** 分类一个 CDP 方法（"Domain.method" 形式） */
export function classifyCdpMethod(method: string): { cls: CdpMethodClass; reason?: string } {
  const dot = method.indexOf('.')
  if (dot <= 0 || dot === method.length - 1) {
    return { cls: 'blocked', reason: 'malformed method — expected "Domain.method"' }
  }
  const domain = method.slice(0, dot)
  const name = method.slice(dot + 1)

  const domainReason = BLOCKED_DOMAINS[domain]
  if (domainReason) return { cls: 'blocked', reason: domainReason }
  if (!KNOWN_DOMAINS.has(domain)) {
    return { cls: 'blocked', reason: `unknown CDP domain "${domain}"` }
  }
  const methodReason = BLOCKED_METHODS[method]
  if (methodReason) return { cls: 'blocked', reason: methodReason }

  if (MUTATING_METHOD_OVERRIDES.has(method)) return { cls: 'mutating' }
  if (SAFE_METHODS.has(method)) return { cls: 'safe' }
  if (SAFE_METHOD_PATTERNS.some((re) => re.test(name))) return { cls: 'safe' }

  // 未知/写类方法：可用但要审批（fail-safe 默认）
  return { cls: 'mutating' }
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
