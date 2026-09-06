import { createContext, useContext } from 'react'

/**
 * 会话面板卡片的「右上角让位」。
 *
 * 卡片的收起按钮绝对定位在右上角（见 SessionPanel），**不占一行** —— 于是各工具要把
 * 自己首行的右内边距让出那一块，X 才会与首行既有的控件（Files 的搜索/刷新、子代理折叠头
 * 的动作钮…）落在同一条线上，而不是把它们压住。
 *
 * 为什么是「面板画按钮、工具让位」而不是「工具把按钮画进自己的头部」：收起按钮不能依赖
 * 内容渲染它 —— 扩展的 Files 在没拿到 FSA 授权时整块换成授权提示（没有那条头部），
 * 加载中更是一个空 div，槽位式的写法在这两态下会连关闭都没有。
 *
 * 让位宽度各处自算（首行所处的内缩不同：Files 的头部贴卡片边，子代理/后台任务的首行在
 * 内层卡片里），统一的只有「是否让位」这一个开关：面板挂在别处时（桌面右侧面板的
 * Files / Preview）读到 false，一切照旧。
 */
export const PanelCloseInsetContext = createContext(false)

export function usePanelCloseInset(): boolean {
  return useContext(PanelCloseInsetContext)
}
