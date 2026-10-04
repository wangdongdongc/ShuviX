/**
 * 上下文注入的围栏标签（从 agentProfile/createAgent.ts 原样搬来，P1-01）。
 *
 * 注入内容直接 append 在档案正文之后，而指令文件动辄是档案正文的十几倍（一份大仓的
 * CLAUDE.md 就有几十 KB），且自带 `##` 标题层级 —— 与档案正文的标题同级。没有边界标记时，
 * 模型无从判断「agent 策略」在哪结束、「项目文档」从哪开始。围栏把这条边界显式化：
 * 标签名声明这段文本是什么，闭合标签给出它到哪为止。
 *
 * 不在围栏里写优先级规则 —— 指令文件本就是用户用来覆盖默认行为的入口，断言谁压谁
 * 会改变现有行为，而这里只负责划边界。
 *
 * 逐字节稳定是契约：`durable/__tests__/fixtures/system-prompts/` 的黄金系统提示词就是用它们
 * 拼出来的（P1-08 按这些 fixture 校验 durable 的提示词分段）。
 */

export const fenceInstructionFile = (filename: string, content: string): string =>
  `<project_instructions file="${filename}">\n${content}\n</project_instructions>`

export const fenceProjectPrompt = (text: string): string =>
  `<project_prompt>\n${text}\n</project_prompt>`

export const fenceProjectMemory = (text: string): string =>
  `<project_memory>\n${text}\n</project_memory>`

export const fenceKnowledgeBases = (text: string): string =>
  `<knowledge_bases>\n${text}\n</knowledge_bases>`
