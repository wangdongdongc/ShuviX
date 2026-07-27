/** 内置 Wiki 隐藏项目的固定 ID(projects.id 为 TEXT 主键,非 uuid 亦可)。
 *  该项目由桌面端 wikiService 按需创建,path = wiki 根目录(~/.shuvix/wikis),
 *  对项目列表不可见,仅承载侧栏 Wiki 视图的笔记本会话。 */
export const WIKI_PROJECT_ID = '__wiki__'
