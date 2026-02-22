# 窗口闪烁问题修复

## 问题现象

打开主窗口和设置窗口时，会短暂出现一个黑色（或与主题不匹配的颜色）背景，然后才显示正常界面。设置窗口尤其明显。

## 根因分析

闪烁由三层原因叠加导致：

### 1. Electron 窗口背景色与主题不匹配

`BrowserWindow` 的 `backgroundColor` 写死为 `#0a0a0f`（深黑色）。当用户使用浅色主题时，窗口帧的背景色是黑色，而 UI 渲染后是白色，形成明显的黑→白闪烁。

**修复**：创建窗口前从数据库读取用户主题设置，动态返回对应背景色。

```ts
function getThemeBgColor(): string {
  const theme = settingsDao.findByKey('general.theme') || 'dark'
  if (theme === 'system') {
    const { nativeTheme } = require('electron')
    return nativeTheme.shouldUseDarkColors ? '#0a0a0f' : '#ffffff'
  }
  return theme === 'light' ? '#ffffff' : '#0a0a0f'
}
```

### 2. CSS 默认主题在 React 之前生效

CSS 中 `:root` 默认是 dark 主题，`data-theme` 属性由 React 的 `useEffect` 设置。在 React 挂载前，CSS 已经加载并应用了 dark 主题的深色背景变量，导致浅色主题用户看到深色一闪。

**修复**：在 `index.html` 的 `<head>` 中添加内联脚本，在 CSS 加载前从 `localStorage` 同步读取主题并设置 `data-theme`。

```html
<script>
  ;(function() {
    var t = localStorage.getItem('theme') || 'dark'
    if (t === 'system') {
      t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    document.documentElement.setAttribute('data-theme', t)
  })()
</script>
```

同时在修改主题和加载设置时同步写入 `localStorage`，确保下次打开窗口时能读到正确值。

### 3. 窗口在 UI 渲染完成前就显示

之前使用 `ready-to-show` 事件显示窗口，该事件在 HTML 首次绘制时就触发，此时 React 尚未挂载、数据尚未从数据库加载。设置窗口尤其明显，因为其面板内容完全依赖异步加载的数据。

**修复**：

- 窗口创建时设置 `show: false`
- 在 `App.tsx` 的初始化函数中，等所有数据（settings、providers、models、sessions）加载完成后，通过双层 `requestAnimationFrame` 确保浏览器完成绘制，再发送 IPC 信号通知主进程显示窗口

```tsx
// App.tsx — init 函数末尾
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.api.app.windowReady()
  })
})
```

```ts
// main/index.ts — 全局 IPC 监听
ipcMain.on('app:window-ready', (event) => {
  const sender = event.sender
  if (mainWindow && sender === mainWindow.webContents) {
    mainWindow.show()
  } else if (settingsWindow && !settingsWindow.isDestroyed() && sender === settingsWindow.webContents) {
    settingsWindow.show()
  }
})
```

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/index.ts` | `getThemeBgColor()`、`show: false`、`app:window-ready` IPC 处理 |
| `src/renderer/index.html` | `<head>` 内联脚本设置 `data-theme`、CSP 添加 `script-src 'unsafe-inline'` |
| `src/renderer/src/App.tsx` | 数据加载完成后发送 `windowReady()` |
| `src/renderer/src/stores/settingsStore.ts` | `loadSettings` 时同步主题到 `localStorage` |
| `src/renderer/src/components/settings/GeneralSettings.tsx` | 切换主题时同步写入 `localStorage` |
| `src/preload/index.ts` | 添加 `windowReady` IPC 方法 |
| `src/preload/index.d.ts` | 添加 `windowReady` 类型声明 |

## 关键要点

- **`ready-to-show` 不够用**：它只表示 HTML 首帧已绘制，不代表 React 和异步数据已就绪
- **双层 `requestAnimationFrame`**：第一层在绘制前执行，第二层确保前一帧已完成绘制
- **主题必须在 CSS 之前设置**：否则会先应用默认（dark）主题再切换，造成闪烁
- **`localStorage` 是同步的**：适合在 HTML 内联脚本中快速读取主题，避免异步延迟
