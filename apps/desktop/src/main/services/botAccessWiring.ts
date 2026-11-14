/**
 * bot 定时运行权限核对的桌面接线（botAccessCheck.ts 是纯逻辑）：bot 注册表、项目、策略、审查 hook 的状态与试算上下文。
 * 主入口建一份交给写入回执（botAccessHint.setBotAccessChecker）和 `shuvix policy check --bot`（policyCheckWiring）——
 * 回执挂在 file 工具上，直接 import 这些服务会把数据库拖进 file 工具的依赖图。
 */
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, parse, sep } from 'path'
import i18next from 'i18next'
import { buildBuiltinPolicies } from '@shuvix/agent-runtime'
import { botService } from './botService'
import { createBotAccessChecker, type BotAccessChecker } from './botAccessCheck'
import { hookService } from './hookService'
import { botBundleId, bundleDir, projectBundleId } from './knowledge'
import { policyService } from './policyService'
import { projectService } from './projectService'
import { settingDirForAcl } from './sandbox'
import { getDesktopBotRunTrial } from './toolContext'
import { getTempWorkspaceBase } from '../utils/paths'

export function desktopBotAccessChecker(): BotAccessChecker {
  const home = homedir()
  return createBotAccessChecker({
    home,
    root: parse(home).root || sep,
    sep,
    policiesDirLabel: '~/.shuvix/policies/',
    bots: () => botService.listAll(),
    identityForFile: (file, basePath) => botService.identityForFile(file, basePath),
    projectsNamed: (name) =>
      projectService.projectsNamed(name).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    projectKnowledgeDir: (projectId) => bundleDir(projectBundleId(projectId)),
    botKnowledgeDir: (file, basePath) => {
      const key = botService.knowledgeKeyForFile(file, basePath)
      return key ? bundleDir(botBundleId(key)) : null
    },
    // 临时运行的工作目录是 temp_workspace/<新会话 id>：试算只要一个那里的路径
    temporaryWorkspace: () => join(getTempWorkspaceBase(), 'shuvix-access-check'),
    aclDir: (dir) => settingDirForAcl(dir),
    userPolicies: () => {
      // 刚写下的文件可能还没被定时器认下：现扫一次（与设置页列表同一份缓存）
      policyService.refresh()
      return policyService.getUserPolicies()
    },
    builtinPolicies: () =>
      buildBuiltinPolicies({
        language: i18next.language,
        readMd: (fileName) => policyService.readBuiltinPolicyMd(fileName)
      }),
    isDisabled: (policy) => policyService.isDisabled(policy),
    reviewActive: () => hookService.agentsBoundTo('permission.request').size > 0,
    isDirectory: (p) => {
      try {
        return existsSync(p) && statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    trial: (run, trial) => getDesktopBotRunTrial(run, trial)
  })
}
