/**
 * 配置分享的「可移植内核」（单一真源）—— 编解码 + 导入计划，桌面与扩展共用。
 *
 * 这里只包含与平台数据层无关的纯逻辑：魔法前缀 + base64(UTF-8) 编解码、版本校验、
 * 以及「每项将执行的动作」预计算。读写真实 provider/mcp 数据是平台叶子（桌面 DAO /
 * 扩展 chrome.storage），各端注入 lookups 即可复用同一套语义，避免两端动作判定漂移。
 */
import { CONFIG_SHARE_MAGIC, type ConfigSharePayload, type ImportPlan } from './types/configShare'

/** base64 编码 UTF-8 字符串（Node Buffer / 浏览器 btoa 双栈可用） */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** base64 解码回 UTF-8 字符串（Node Buffer / 浏览器 atob 双栈可用） */
function decodeBase64(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf-8')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 编码 payload 为可粘贴的分享串（魔法前缀 + base64(JSON)） */
export function encodeConfigSharePayload(payload: ConfigSharePayload): string {
  return CONFIG_SHARE_MAGIC + encodeBase64(JSON.stringify(payload))
}

/**
 * 解码并校验分享串，失败抛带可读 code 的 Error（与 UI 的 mapParseError 对齐）：
 * MAGIC_MISMATCH / BASE64_INVALID / JSON_INVALID / SCHEMA_INVALID / VERSION_UNSUPPORTED
 */
export function parseConfigSharePayload(encoded: string): ConfigSharePayload {
  const trimmed = encoded.trim()
  if (!trimmed.startsWith(CONFIG_SHARE_MAGIC)) {
    throw new Error('MAGIC_MISMATCH')
  }
  const b64 = trimmed.slice(CONFIG_SHARE_MAGIC.length)
  let json: string
  try {
    json = decodeBase64(b64)
  } catch {
    throw new Error('BASE64_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('JSON_INVALID')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('SCHEMA_INVALID')
  }
  const payload = parsed as Partial<ConfigSharePayload>
  if (payload.version !== 1) {
    throw new Error('VERSION_UNSUPPORTED')
  }
  return payload as ConfigSharePayload
}

/** 导入计划所需的本端现状查询（各端注入：桌面 DAO / 扩展 store） */
export interface ConfigImportLookups {
  /** 按名查本端 provider（不存在返回 undefined） */
  findProvider: (name: string) => { isBuiltin: boolean } | undefined
  /** 按名查本端 mcp server（不存在返回 undefined） */
  findMcp: (name: string) => { isBuiltin: boolean } | undefined
}

function hasAnyValue(record: Record<string, string>): boolean {
  return Object.values(record).some((v) => v !== '')
}

/**
 * 预计算每一项将执行的动作（纯函数，语义见 ImportPlan 注释）。
 * 桌面与扩展共用此判定，保证两端「create/overwrite/mergeBuiltin/skipMissingBuiltin」一致。
 */
export function planConfigImport(
  payload: ConfigSharePayload,
  lookups: ConfigImportLookups
): ImportPlan {
  const providers: ImportPlan['providers'] = (payload.providers ?? []).map((p) => {
    const existing = lookups.findProvider(p.name)
    let action: 'create' | 'overwrite' | 'mergeBuiltin'
    if (!existing) {
      action = 'create'
    } else if (existing.isBuiltin) {
      action = 'mergeBuiltin'
    } else {
      action = 'overwrite'
    }
    return {
      name: p.name,
      action,
      modelIds: p.models.map((m) => m.modelId),
      missingApiKey: p.apiKey === null
    }
  })

  const mcpServers: ImportPlan['mcpServers'] = (payload.mcpServers ?? []).map((s) => {
    const existing = lookups.findMcp(s.name)
    let action: 'create' | 'overwrite' | 'mergeBuiltin' | 'skipMissingBuiltin'
    if (s.isBuiltin) {
      action = existing?.isBuiltin ? 'mergeBuiltin' : 'skipMissingBuiltin'
    } else if (existing?.isBuiltin) {
      action = 'mergeBuiltin'
    } else if (existing) {
      action = 'overwrite'
    } else {
      action = 'create'
    }
    return {
      name: s.name,
      action,
      missingSecrets:
        s.sensitiveStripped ||
        (s.env !== null && !hasAnyValue(s.env)) ||
        (s.headers !== null && !hasAnyValue(s.headers))
    }
  })

  return { providers, mcpServers }
}
