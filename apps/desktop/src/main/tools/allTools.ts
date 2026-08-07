/**
 * 统一导入所有内置工具文件，触发其 registerBuiltinTool() 副作用。
 * agentToolBuilder、DefaultChatGateway、utils/tools 等消费方在使用注册表前
 * 必须 import 此文件，以保证注册顺序先于读取。
 */

// 通用工具
import './bash'
import './read'
import './write'
import './edit'
import './ask'
import './browser'
// git 工具（isomorphic-git 跨端实现）：注册 defaultEnabled: false —— 主 Agent 默认无、
// 可在工具选择器按会话开启；子代理（如 wiki curator）经白名单解析不受默认集限制
import './git'
// preview 工具：defaultEnabled: false —— 可视化子代理经白名单解析使用
import './preview'
// 注：session 工具已删除 —— 压缩不再经「compact 子代理 + 工具调用」，
// 而是 harness 内建的 compact()（见 AgentSession.compact / ChatGateway.compact）。

// 高性能检索
import './ls'
import './grep'
import './glob'

// 远程访问
import './ssh'
import './database'

// Skill 工具（元数据注册；实例化由 agentToolBuilder 负责）
// skill.ts 已迁至 services/skillTool.ts；这里仍然 import 触发其 registerBuiltinTool() 副作用
import '../services/skillTool'

// 统一 Agent 派发工具（替代原 subagent/* 多工具体系）
import '../agents/AgentTool'
