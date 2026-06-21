// 资源模块声明（独立 tsc 时也能解析图片导入；宿主侧已有 vite/client 提供同等声明）
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.png' {
  const src: string
  export default src
}
