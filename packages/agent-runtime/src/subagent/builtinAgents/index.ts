/**
 * 内置子代理定义（硬编码，跨端共享）。
 *
 * 各端 registry 从这里 import 组装 builtin 列表（桌面 agentService / 扩展 subAgent），
 * 用户仍可用同名用户定义覆盖（合并逻辑在各端 registry 内）。
 */
// 注：compact 子代理已移除 —— 压缩改由 harness 内建的 `compact()` 完成
// （滚动式部分压缩 + 独立 completeSimple 调用，不再需要一个持 session 工具的代理）。
export { EXPLORE_AGENT } from './exploreAgent'
export { RESEARCH_AGENT } from './researchAgent'
export { VISUALIZATION_AGENT } from './visualizationAgent'
export { buildWidgetAgent, type BuildWidgetAgentOptions } from './widgetAgent'
export { buildWikiAgent, WIKI_ENTRY_BANNER, type BuildWikiAgentOptions } from './wikiAgent'
