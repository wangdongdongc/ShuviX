/**
 * Full Compaction 共享内核 —— 宿主无关的压缩编排（runCompaction）+ 纯提示词/预处理工具。
 * 端通过 CompactionDeps 注入存储/模型/事件适配器。
 */
export { buildCompactionPrompt, formatCompactSummary, buildSummaryContent } from './prompts'
export { prepareMessagesForCompaction } from './prepare'
export { runCompaction, isCompacting, type CompactionDeps } from './runCompaction'
