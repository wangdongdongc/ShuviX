/**
 * 构建 json_set patch SQL 片段和绑定值
 * 布尔/数组/对象用 json() 包裹以保留原始 JSON 类型；字符串/数值直接绑定
 */
export function buildJsonPatch(patch: Record<string, unknown>): {
  setClauses: string
  values: unknown[]
} {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
  const setClauses = entries
    .map(([key, v]) => {
      const needsJson = typeof v === 'boolean' || (typeof v === 'object' && v !== null)
      return needsJson ? `'$.${key}', json(?)` : `'$.${key}', ?`
    })
    .join(', ')
  const values = entries.map(([, v]) => {
    if (typeof v === 'boolean') return JSON.stringify(v)
    if (typeof v === 'object' && v !== null) return JSON.stringify(v)
    return v
  })
  return { setClauses, values }
}
