/**
 * Instruction 模块入口
 *
 * 负责项目指令文件（AGENTS.md / CLAUDE.md）的扫描与注入：
 * - scanner: 扫描工作目录顶层候选
 * - injector: 在新会话创建 / 会话压缩完成时把候选写入消息流
 */

export { scanInstructionFiles } from './instructionFileScanner'
export { injectInstructionMessages, buildInstructionMessages } from './instructionInjector'
