/**
 * 内置子代理定义（硬编码，跨端共享）。
 *
 * 各端 registry 从这里 import 组装 builtin 列表（桌面 agentService / 扩展 subAgent），
 * 用户仍可用同名用户定义覆盖（合并逻辑在各端 registry 内）。
 */
export { COMPACT_AGENT } from './compactAgent'
export { EXPLORE_AGENT } from './exploreAgent'
export { RESEARCH_AGENT } from './researchAgent'
export { VISUALIZATION_AGENT } from './visualizationAgent'
export { buildWidgetAgent, type BuildWidgetAgentOptions } from './widgetAgent'
export { buildWikiAgent, WIKI_ENTRY_BANNER, type BuildWikiAgentOptions } from './wikiAgent'
