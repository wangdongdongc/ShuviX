/**
 * 侧栏「智能体」分组「新建智能体」的初值 —— 一份最小但**合法**的 agent md
 * （YAML 注释与键序原样保留：文件才是事实源，逐字段表单会把它们悄悄抹掉）。
 *
 * 落盘走 `subAgent.createSource`（与「创建覆盖副本」同一个写入口，非法一律拒绝），
 * 建好之后打开的就是它自己的笔记本会话 —— 用户接着在那里改。
 */
export function newAgentTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    `description: ${t('tool.subAgentTemplateDesc')}`,
    'shuvix-tools: read, bash',
    'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
    'shuvix-project-awareness: true',
    '---',
    '',
    t('tool.subAgentTemplateBody'),
    ''
  ].join('\n')
}
