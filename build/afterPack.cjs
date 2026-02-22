/**
 * electron-builder afterPack 钩子
 * 在 macOS 上对整个 .app 包进行统一的 ad-hoc 签名，
 * 避免主进程与 Electron Framework 的 Team ID 不一致导致启动崩溃。
 */
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  console.log(`[afterPack] Ad-hoc re-signing: ${appPath}`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: 'inherit'
  })
}
