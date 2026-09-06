/**
 * 单行摘要截断 —— 超过 max 个字符就切到 max-3 再补 `...`，结果总长恰为 max。
 * 工具行摘要、合并行摘要、过程折叠头、后台通知摘要共用这一把尺：四处各写一遍
 * `length > 60 ? slice(0, 57) + '...'` 的时候，改上限会漏掉其中一处。
 */
export function clipLine(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text
}
