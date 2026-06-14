/**
 * 共享主题类型 — 与 Tailwind CSS 调色板 + lucide-react 图标对齐
 *
 * 仅定义类型约束，确保编译期捕获拼写错误。
 * 各处直接使用字面量，无需导入常量。
 */

// ─── 图标名称类型（与前端 ICON_MAP 保持同步） ─────────────

/** 前端已注册的 lucide 图标名称 */
export type LucideIconName =
  | 'Bot'
  | 'BookOpen'
  | 'Code'
  | 'Container'
  | 'Database'
  | 'FilePen'
  | 'FileOutput'
  | 'FileSearch2'
  | 'FileText'
  | 'FolderTree'
  | 'Globe'
  | 'MessageCircleQuestion'
  | 'Monitor'
  | 'Palette'
  | 'Search'
  | 'SquareTerminal'
  | 'Terminal'
  | 'Wrench'

// ─── 颜色类型（Tailwind CSS 调色板子集） ─────────────────

/** 主题调色板颜色（Tailwind 色值字面量） */
export type ThemeColor =
  | '#34d399' // emerald-400
  | '#10b981' // emerald-500
  | '#22c55e' // green-500
  | '#38bdf8' // sky-400
  | '#60a5fa' // blue-400
  | '#3b82f6' // blue-500
  | '#f59e0b' // amber-500
  | '#eab308' // yellow-500
  | '#8b5cf6' // violet-500
  | '#f472b6' // pink-400
