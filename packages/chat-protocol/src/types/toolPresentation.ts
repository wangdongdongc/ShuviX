/**
 * 工具调用渲染配置 — 声明式描述前端如何展示工具调用
 *
 * 内置工具和插件工具均使用同一套类型，通过 IPC `tools:presentations` 下发给渲染层。
 * 未提供时 renderer 使用通用的 JSON 参数 + 文本结果渲染。
 */

import type { LucideIconName, ThemeColor } from '../theme'

/** 表单项渲染器 — 指定单个参数字段的展示样式 */
export type ToolFormItemRenderer =
  | { type: 'code'; language?: string; wrap?: boolean; lineNumbers?: boolean }
  | { type: 'text' }

/** 表单项 — 描述一个 args 字段在展开态中的展示方式 */
export interface ToolFormItem {
  /** args 中的字段名 */
  field: string
  /** 显示标签（默认使用 field 名） */
  label?: string
  /** 渲染器（默认 { type: 'text' }） */
  renderer?: ToolFormItemRenderer
}

/** 工具渲染提示 */
export interface ToolPresentation {
  /** 工具显示名称（如 "Bash Execute Command"） */
  label?: string
  /** 折叠态图标（前端已注册的 lucide 图标名） */
  icon?: LucideIconName
  /** 图标颜色（主题调色板颜色） */
  iconColor?: ThemeColor
  /**
   * 展开态表单项列表
   *
   * - 未定义时：以 JSON 块展示全部 args（默认行为）
   * - 已定义时：按声明顺序渲染各表单项，未列出的 args 字段以 text 形式追加在末尾
   */
  formItems?: ToolFormItem[]
  /** 是否在表单项末尾追加未声明的 args 字段（默认 true） */
  showUndeclaredFields?: boolean
  /**
   * 展开态整体形态（不声明则走 formItems + 独立「结果」块的通用表单形态）
   *
   * - `terminal`：命令与输出融成一段终端会话（提示符 + cwd + 命令，输出直接跟在下面）。
   *   适用于 shell 类工具（bash / ssh），它们的「参数」和「结果」本来就是一次交互的两半，
   *   拆成两个带标签的块反而比终端里看着更难读。
   */
  detailView?: 'terminal'
}
