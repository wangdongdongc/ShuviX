import { PLACEHOLDER_PATTERN } from './redactionPlaceholders'

/**
 * 单行摘要截断 —— 超过 max 个字符就切到 max-3 再补 `...`，结果总长恰为 max。
 * 工具行摘要、合并行摘要、过程折叠头、后台通知摘要、子会话大纲共用这一把尺：几处各写一遍
 * `length > 60 ? slice(0, 57) + '...'` 的时候，改上限会漏掉其中一处。
 *
 * 切口落在自动脱敏的占位符中间时，退到占位符之前（结果短一些）：半个占位符界面认不出，会把那几个字符
 * 原样露出来。
 */
export function clipLine(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = max - 3
  if (text.includes('{{')) {
    const re = new RegExp(PLACEHOLDER_PATTERN, 'g')
    for (let m = re.exec(text); m && m.index < cut; m = re.exec(text)) {
      if (m.index + m[0].length > cut) {
        cut = m.index
        break
      }
    }
  }
  return text.slice(0, cut) + '...'
}
