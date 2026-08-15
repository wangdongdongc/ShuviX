/**
 * e2e 隔离实例引导（由 harness/launch.ts spawn；不要直接运行）。
 *
 * 把 userData 重定向到一次性目录后加载正式主进程产物 —— 与用户自己的运行实例
 * （真实 HOME / userData / cli.sock）完全隔离。产物路径相对本文件：apps/desktop/out/。
 */
const { app } = require('electron')
const userData = process.env.SHUVIX_VERIFY_USERDATA
if (userData) app.setPath('userData', userData)
require('../../out/main/index.js')
