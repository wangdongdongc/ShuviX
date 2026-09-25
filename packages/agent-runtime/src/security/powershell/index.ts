/**
 * PowerShell 命令解析层 —— 模块导览：
 *   types.ts     纯数据类型（PowerShellFacts / PowerShellCommand；只有宽松轨）
 *   commands.ts  命令名规范化（路径 / 扩展名 / 默认别名）与 wrapper（`sudo`）解包
 *   cmd.ts       `cmd /c` 载荷的最小切分
 *   analyze.ts   扫描器与嵌套载荷展开（`powershell -Command` / `-EncodedCommand` /
 *                `cmd /c` / `Invoke-Expression` / `bash -c`）
 *
 * 红线：产出只能用于拦截或询问，不能用于放行 —— 没有严格轨。理由见 analyze.ts 文件头。
 */
export type {
  PowerShellAnalyzeOptions,
  PowerShellCommand,
  PowerShellCommandShell,
  PowerShellFacts,
  PowerShellRedirect,
  PowerShellUnparsedReason
} from './types'
export {
  analyzePowerShellCommand,
  decodeBase64Utf16le,
  MAX_POWERSHELL_SOURCE_LENGTH,
  MAX_POWERSHELL_PAYLOAD_DEPTH
} from './analyze'
export {
  POWERSHELL_ALIASES,
  commandLeaf,
  powerShellCommandBase,
  stripPowerShellWrappers
} from './commands'
export { splitCmdLine, type CmdSplit, type CmdToken, type CmdRedirect } from './cmd'
