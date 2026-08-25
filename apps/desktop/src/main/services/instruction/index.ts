/**
 * Instruction 模块入口
 *
 * 负责项目指令文件的解析：按 agent 档案 `shuvix-instruction-files` 给出的清单，
 * 在会话工作目录里取第一个存在且非空的读出来，交由统一创建管线 append 进系统提示词。
 * 候选名不在本模块 —— 档案说了算（见 injector 头注释）。
 */

export { resolveInstructionContent, type ResolvedInstruction } from './instructionInjector'
