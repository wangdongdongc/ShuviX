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
// git 工具（isomorphic-git 跨端实现）：不在内置 default 档案清单 —— 主 Agent 默认无、
// 用户可覆盖 default.md 加入；子代理（如 wiki curator）经白名单解析不受默认集限制
import './git'
// preview 工具：不在内置 default 档案清单 —— 可视化子代理经白名单解析使用
import './preview'
// session：agent 读改自己所属会话的会话级能力（当前仅 set-title，内置 titler 的落笔工具）。
// 注：与已删除的同名旧工具无关 —— 压缩不再经「compact 子代理 + 工具调用」，
// 而是 harness 内建的自动压缩（见 HarnessSession.maybeAutoCompact）。
import './session'

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
