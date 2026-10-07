/**
 * 启动诊断的引导（副作用模块）：**必须是 main 入口 index.ts 的第一条 import**。
 *
 * rollup 按 import 顺序求值内部模块，排第一就意味着它在数据库、IPC、服务等一切应用模块之前运行
 * （外部依赖的 require 总被提升到 bundle 最前，那段由构建注入的 `__SHUVIX_MAIN_T0__` 计时）。
 * 看门狗在这里启动，ready 之前的卡顿也逃不掉。
 */
import { mark } from '../../perf'
import { recordAppModulesStart } from './launchTiming'
import { startStallWatchdog } from './watchdog'

recordAppModulesStart()
startStallWatchdog()
mark('main: app modules start')
