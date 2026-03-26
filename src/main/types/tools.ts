/**
 * 工具名称类型（向后兼容别名）
 * 内置工具列表已迁移至 src/main/tools/registry.ts 自注册表，
 * ALL_TOOL_NAMES / DEFAULT_TOOL_NAMES 不再维护，使用 getBuiltinToolEntries() 替代。
 */
export type ToolName = string
