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
// move / delete：挪动改名、删文件或空目录 —— 与 write 同一道路径门、同一条变更回调（知识库管线看得见）；
// 不在任何内置基座档案清单里，档案按名列出才有
import './move'
import './delete'
import './ask'
// suggest：给用户留几条一键采纳的提议，不等回答（采纳 = 那条的话作为用户回复发进会话）
import './suggest'
// update_plan：任务列表（进度显示，钉在对话流末尾；只给会话的根 agent）
import './taskList'
// tool_search：查找并申请开启这条会话没选的 MCP 服务器
import './toolSearch'
// shuvix：agent 经设置 API 改 ShuviX 自己的设置（能调哪些通道见 services/agentChannels.ts 的注解）
import './shuvix'
// show_image：把本机的图片摆进对话给用户看（快照进会话目录；模型收不到图）
import './showImage'
// browser / database 不在这里：它们是按会话勾选的内置 MCP 能力服务器
// （services/builtinMcp/browserServer.ts / databaseServer.ts），ssh 同理
// git 工具（isomorphic-git 跨端实现）：不在内置 default 档案清单 —— 主 Agent 默认无、
// 用户可覆盖 default.md 加入；子代理按自己档案的白名单解析，不受默认集限制
import './git'
// artifact：会话 Artifacts 的创建/认领/列举（管存储与身份，不管画图；手艺在 builtin:drawing）
import './artifact'
// session：agent 读改自己所属会话的会话级能力（当前仅 set-title，内置 titler 的落笔工具）。
// 注：与已删除的同名旧工具无关 —— 压缩不再经「compact 子代理 + 工具调用」，
// 而是会话运行时内建的自动压缩（pi-durable 的 compaction）。
import './session'
// knowledge：OKF 知识库的结构化读写面（一期基础设施；不在内置基座档案清单，按名解析使用）
import './knowledge'
// 造组件（用组件经它的 MCP 服务器，见 services/builtinMcp/widgetMcpServer.ts）
import './widget'
// doc_read / doc_edit / doc_insert：协作编辑（基座 notebook）—— 改编辑器里的活文档，没有编辑器开着才改磁盘
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
