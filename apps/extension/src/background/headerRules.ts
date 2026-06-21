/**
 * declarativeNetRequest 动态规则 —— 在网络层为出网的 LLM 请求注入自定义请求头。
 *
 * 浏览器 `fetch` 无法设置 `User-Agent` 等「禁止修改的请求头」（forbidden headers），
 * 故 agent-runtime modelResolver 里设到 `resolvedModel.headers` 的 UA 会被静默丢弃。
 * 这里用 DNR（工作在网络栈，不受该限制）重写请求头，与桌面行为对齐：
 *  - 内置 provider：baseUrl 含 api.kimi.com → 强制 `User-Agent: Claude-Code/1.0.0`
 *    （等价桌面 modelResolver.ts 的 kimi 分支）
 *  - 自定义 provider：注入 metadata.customHeaders 里的全部头
 *    （等价桌面自定义分支读取 metadata.customHeaders）
 *
 * 数据源为 chrome.storage.local（settingsStore 持久化的 providerOverrides / customProviderIds），
 * 每次直接读最新值重建，避免缓存陈旧。
 */
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'

// 与 settingsStore 的存储键一致
const KEY_OVERRIDES = 'providerOverrides'
const KEY_CUSTOM = 'customProviderIds'

const KIMI_HOST = 'api.kimi.com'
const KIMI_USER_AGENT = 'Claude-Code/1.0.0'

interface StoredOverride {
  baseUrl?: string
  metadata?: string
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** 解析 metadata.customHeaders（与桌面 modelResolver 约定一致） */
function parseCustomHeaders(metadata?: string): Record<string, string> {
  if (!metadata) return {}
  try {
    const meta = JSON.parse(metadata)
    if (meta?.customHeaders && typeof meta.customHeaders === 'object') {
      return meta.customHeaders as Record<string, string>
    }
  } catch {
    /* 忽略无效 JSON */
  }
  return {}
}

/** 由当前 provider 配置构造 DNR 动态规则集合 */
export async function buildHeaderRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  const store = await chrome.storage.local.get([KEY_OVERRIDES, KEY_CUSTOM])
  const overrides = (store[KEY_OVERRIDES] as Record<string, StoredOverride>) ?? {}
  const customIds = (store[KEY_CUSTOM] as string[]) ?? []

  // (baseUrl, headers) 列表：内置 + 自定义
  const targets: { baseUrl: string; headers: Record<string, string> }[] = []

  for (const p of BUILTIN_PROVIDERS) {
    const baseUrl = p.baseUrl ?? '' // 内置 URL 恒由目录决定，忽略任何覆盖
    const headers: Record<string, string> = {}
    // 内置分支：仅 kimi 强制 UA（桌面内置分支不读 customHeaders）
    if (baseUrl.includes(KIMI_HOST)) headers['User-Agent'] = KIMI_USER_AGENT
    if (Object.keys(headers).length) targets.push({ baseUrl, headers })
  }

  for (const id of customIds) {
    const o = overrides[id]
    if (!o?.baseUrl) continue
    const headers = parseCustomHeaders(o.metadata)
    if (Object.keys(headers).length) targets.push({ baseUrl: o.baseUrl, headers })
  }

  const rules: chrome.declarativeNetRequest.Rule[] = []
  let id = 1
  for (const t of targets) {
    const host = hostOf(t.baseUrl)
    if (!host) continue
    rules.push({
      id: id++,
      priority: 1,
      condition: {
        urlFilter: `||${host}/`,
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType]
      },
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: Object.entries(t.headers).map(([header, value]) => ({
          header,
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value
        }))
      }
    })
  }
  return rules
}

/** 原子替换全部动态规则（先删旧再加新） */
export async function syncHeaderRules(): Promise<void> {
  try {
    const addRules = await buildHeaderRules()
    const old = await chrome.declarativeNetRequest.getDynamicRules()
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map((r) => r.id),
      addRules
    })
  } catch (err) {
    console.error('[shuvix-sw] sync header rules failed', err)
  }
}
