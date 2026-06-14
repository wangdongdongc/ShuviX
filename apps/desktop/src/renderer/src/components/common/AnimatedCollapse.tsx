/**
 * 折叠/展开动画容器
 * 利用 CSS grid-template-rows 过渡实现高度动画，无需 JS 测量
 */
export function AnimatedCollapse({
  open,
  children,
  duration = 150
}: {
  open: boolean
  children: React.ReactNode
  duration?: number
}): React.JSX.Element {
  return (
    <div
      className="grid transition-[grid-template-rows] ease-out"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        transitionDuration: `${duration}ms`
      }}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
