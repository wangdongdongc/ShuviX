# ShuviX 跨平台适配评估 (macOS / Windows / Linux × amd64 / arm64)

对当前代码库进行全面审查，识别发布三平台六架构桌面应用所需的适配工作。

---

## 🔴 必须修复（阻塞性问题）

### 1. 窗口标题栏适配

- **现状**：两个窗口均使用 `titleBarStyle: 'hiddenInset'` + `trafficLightPosition`，这是 macOS 专属配置
- **问题**：Windows/Linux 上 `hiddenInset` 会隐藏标题栏但不提供窗口控制按钮（最小化/最大化/关闭），用户无法操作窗口
- **方案**：
  - macOS 保持 `hiddenInset` + trafficLightPosition 不变
  - Windows/Linux 改用 `titleBarStyle: 'hidden'` + 自定义标题栏组件（含最小化/最大化/关闭按钮）
  - 或者 Windows/Linux 退回默认标题栏（最小改动方案）

### 2. CSS 布局顶部间距

- **现状**：`Sidebar.tsx`、`ChatView.tsx`、`SettingsPanel.tsx` 使用 `pt-10`（40px）为 macOS 交通灯按钮留空间
- **问题**：Windows/Linux 无交通灯，顶部会留出大量空白
- **方案**：根据平台动态调整顶部 padding（可通过 preload 暴露 `process.platform`，或 CSS 变量）

### 3. 原生模块构建 (better-sqlite3)

- **现状**：`electron-builder.yml` 中 `npmRebuild: false`，`postinstall` 仅处理开发环境的 rebuild
- **问题**：打包时不会为目标平台重新编译 `better-sqlite3`，导致安装包在非开发机架构上崩溃
- **方案**：
  - 将 `npmRebuild` 改为 `true`（或移除该行，默认为 true）
  - 确保 CI 环境安装了对应平台的编译工具链（Python、node-gyp、Visual Studio Build Tools 等）

### 4. electron-builder 多架构 target 配置

- **现状**：`mac` 段未指定 target；`win` 段未指定 target；`linux` 段有 target 但未声明 arch
- **方案**：
  ```yaml
  mac:
    target:
      - target: dmg
        arch: [x64, arm64]
      - target: zip
        arch: [x64, arm64]
  win:
    target:
      - target: nsis
        arch: [x64, arm64]
  linux:
    target:
      - target: AppImage
        arch: [x64, arm64]
      - target: deb
        arch: [x64, arm64]
  ```

---

## 🟡 建议修复（UX / 质量问题）

### 5. 字体栈缺少 Windows/Linux 系统字体

- **现状**：`main.css` body 使用 `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif`；monospace 使用 `'SF Mono', 'Fira Code', 'Cascadia Code', monospace`
- **方案**：扩展为跨平台字体栈
  - 正文：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Ubuntu', 'Cantarell', 'Noto Sans', sans-serif`
  - 代码：`'SF Mono', 'Cascadia Code', 'Consolas', 'Ubuntu Mono', 'Fira Code', monospace`

### 6. 应用 ID 和元信息

- **现状**：`appId: com.electron.app`（模板默认值）；`author: example.com`；`homepage` 指向 electron-vite.org
- **方案**：改为 `com.shuvix.app`、真实作者、`https://github.com/wangdongdongc/ShuviX`

### 7. 菜单标签硬编码中文

- **现状**：应用菜单中 "设置…" 是硬编码中文
- **方案**：菜单标签使用后端 i18n（`t('settings.title')` + `…`）

### 8. CI/CD 多平台构建流水线

- **现状**：无 `.github/workflows`，全靠本地手动构建
- **方案**：创建 GitHub Actions workflow，在 macOS/Windows/Linux runner 上分别构建，上传 Release artifacts
- 可后续实现，不阻塞首次发布

### 9. 自动更新

- **现状**：`publish.url` 为 `https://example.com/auto-updates` 占位符，无 `electron-updater` 依赖
- **方案**：集成 `electron-updater`，publish 改为 GitHub Releases
- 可后续实现

---

## 🟢 已适配（无需改动）

| 项目                           | 状态                                 |
| ------------------------------ | ------------------------------------ |
| Shell 工具 (bash.ts, shell.ts) | ✅ 已处理 Windows Git Bash 回退      |
| 进程树 kill                    | ✅ 跨平台 (taskkill / SIGKILL)       |
| Docker 管理                    | ✅ 直接调用 docker CLI，跨平台       |
| 数据存储路径                   | ✅ 使用 `app.getPath('userData')`    |
| 窗口关闭行为                   | ✅ macOS 不退出 / 其他平台退出       |
| 应用图标                       | ✅ 三种格式都有 (icns/ico/png)       |
| macOS entitlements             | ✅ 仅 macOS 使用                     |
| 路径工具 macOS 变体            | ✅ 无匹配时 fallback，不影响其他平台 |
| 应用菜单快捷键                 | ✅ 已支持全平台                      |

---

## 建议优先级

1. **先做 #3 + #4 + #6** — 修改 `electron-builder.yml`，确保能正确打包
2. **再做 #1 + #2** — 窗口标题栏适配（改动最大，涉及主进程 + 多个渲染组件）
3. **顺手做 #5 + #7** — 字体栈和菜单 i18n（小改动）
4. **后续做 #8 + #9** — CI/CD 和自动更新
