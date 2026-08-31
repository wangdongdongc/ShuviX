/**
 * bot 的视觉身份（UI 形态裁决②）：displayName 首字 + 按 bot 名派生的定色色块。
 *
 * 纯函数，供所有渲染面共用（chat-ui 卡头、app-shell 侧栏/创建对话框、桌面设置页），
 * 保证同一个 bot 在每一处颜色一致。**以 `name` 而非 displayName 取色** —— name 是
 * bot 的身份键（文件名、决策记录、侧车署名都用它），displayName 只是展示文案，
 * 改个显示名不该让头像换色。
 *
 * 色板挑的是深浅两主题下都能承载深色文字的亮色（GitHub-dark 强调色系），
 * 数量刻意为 8：更多的相近色反而降低成员间的区分度。
 */
export const BOT_COLOR_PALETTE = [
  '#79c0ff', // 蓝
  '#d2a8ff', // 紫
  '#ffa657', // 橙
  '#7ee787', // 绿
  '#ff7b72', // 红
  '#f2cc60', // 黄
  '#76e3ea', // 青
  '#f778ba' // 粉
] as const

/** name → 色板定色（同名恒同色；空串也落在色板内，不特判） */
export function botColorFor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return BOT_COLOR_PALETTE[h % BOT_COLOR_PALETTE.length]
}

/**
 * 头像字：displayName 的首个可见字符（spread 按码点切，避免把代理对劈成乱码）。
 * 拉丁字母大写化；空白/空串回落 '?'。
 */
export function botInitial(displayName: string): string {
  const first = [...displayName.trim()][0]
  return first ? first.toUpperCase() : '?'
}
