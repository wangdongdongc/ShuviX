/**
 * 统一导入所有内置工具文件，触发其 registerBuiltinTool() 副作用。
 * agentToolBuilder、DefaultChatGateway、utils/tools 等消费方在使用注册表前
 * 必须 import 此文件，以保证注册顺序先于读取。
 */

// 通用工具
// 命令工具按平台二选一：bash（macOS / Linux）与 powershell（Windows），见注册项的 platforms
import './bash'
import './powershell'
import './read'
import './write'
import './edit'
import './ask'
// browser / database 不在这里：它们是按会话勾选的内置 MCP 能力服务器
// （services/builtinMcp/browserServer.ts / databaseServer.ts），ssh 同理
// git 工具（isomorphic-git 跨端实现）：不在内置 default 档案清单 —— 主 Agent 默认无、
// 用户可覆盖 default.md 加入；子代理按自己档案的白名单解析，不受默认集限制
import './git'
// artifact：会话 Artifacts 的创建/认领/列举（管存储与身份，不管画图；手艺在 builtin:drawing）
import './artifact'
// session：agent 读改自己所属会话的会话级能力（当前仅 set-title，内置 titler 的落笔工具）。
// 注：与已删除的同名旧工具无关 —— 压缩不再经「compact 子代理 + 工具调用」，
// 而是 harness 内建的自动压缩（见 HarnessSession.maybeAutoCompact）。
import './session'
// knowledge：OKF 知识库的结构化读写面（一期基础设施；不在内置基座档案清单，按名解析使用）
import './knowledge'
// doc_read / doc_edit / doc_insert：协作编辑（基座 coedit）—— 改编辑器里的活文档，不碰磁盘
import './doc'

// 高性能检索
import './ls'
import './grep'
import './glob'

// Skill 工具（元数据注册；实例化由 agentToolBuilder 负责）
// skill.ts 已迁至 services/skillTool.ts；这里仍然 import 触发其 registerBuiltinTool() 副作用
import '../services/skillTool'

// 统一 Agent 派发工具（替代原 subagent/* 多工具体系）
import '../agents/AgentTool'
