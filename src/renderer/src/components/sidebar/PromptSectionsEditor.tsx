import { v7 as uuidv7 } from 'uuid'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ProjectPromptSection } from '../../../../shared/types/promptSection'

interface PromptSectionsEditorProps {
  sections: ProjectPromptSection[]
  onChange: (sections: ProjectPromptSection[]) => void
}

/**
 * 项目提示词卡片编辑器
 *
 * - 每张卡片有可编辑的 title + content
 * - 拖拽手柄(GripVertical)位于卡片左上,只有它能触发拖拽,避免和文本输入冲突
 * - 末尾"添加卡片"按钮追加空白卡片
 */
export function PromptSectionsEditor({
  sections,
  onChange
}: PromptSectionsEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = sections.findIndex((s) => s.id === active.id)
    const newIndex = sections.findIndex((s) => s.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onChange(arrayMove(sections, oldIndex, newIndex))
  }

  const updateSection = (id: string, patch: Partial<ProjectPromptSection>): void => {
    onChange(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const removeSection = (id: string): void => {
    onChange(sections.filter((s) => s.id !== id))
  }

  const addSection = (): void => {
    onChange([...sections, { id: uuidv7(), title: '', content: '' }])
  }

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {sections.map((section) => (
            <SortableCard
              key={section.id}
              section={section}
              onChangeTitle={(title) => updateSection(section.id, { title })}
              onChangeContent={(content) => updateSection(section.id, { content })}
              onRemove={() => removeSection(section.id)}
            />
          ))}
        </SortableContext>
      </DndContext>

      <button
        onClick={addSection}
        className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 transition-colors px-2 py-1"
      >
        <Plus size={12} />
        {t('projectForm.addPromptSection')}
      </button>
    </div>
  )
}

interface SortableCardProps {
  section: ProjectPromptSection
  onChangeTitle: (title: string) => void
  onChangeContent: (content: string) => void
  onRemove: () => void
}

function SortableCard({
  section,
  onChangeTitle,
  onChangeContent,
  onRemove
}: SortableCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  // 内容 textarea 高度随文本自适应(min: 1 行)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [section.content])

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/card flex items-start gap-1 px-1.5 py-1 rounded border border-border-secondary bg-bg-primary/40 hover:border-border-primary transition-colors"
    >
      {/* 拖拽手柄 */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex-shrink-0 self-stretch flex items-center px-0.5 rounded text-text-tertiary/60 hover:text-text-secondary hover:bg-bg-hover/50 cursor-grab active:cursor-grabbing transition-colors"
        title={t('projectForm.dragToReorder')}
      >
        <GripVertical size={11} />
      </button>

      {/* 卡片主体 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <input
          value={section.title}
          onChange={(e) => onChangeTitle(e.target.value)}
          className="w-full px-1 py-0.5 rounded text-[11px] font-medium bg-transparent border border-transparent hover:border-border-secondary focus:border-accent/50 outline-none text-text-primary placeholder:text-text-tertiary/60 transition-colors"
          placeholder={t('projectForm.promptSectionTitlePlaceholder')}
        />
        <textarea
          ref={contentRef}
          value={section.content}
          onChange={(e) => onChangeContent(e.target.value)}
          rows={1}
          className="w-full px-1 py-0.5 rounded text-[10px] leading-snug bg-transparent border border-transparent hover:border-border-secondary focus:border-accent/50 outline-none text-text-secondary placeholder:text-text-tertiary/60 transition-colors resize-none overflow-hidden"
          placeholder={t('projectForm.promptSectionContentPlaceholder')}
        />
      </div>

      {/* 删除按钮 */}
      <button
        type="button"
        onClick={onRemove}
        className="flex-shrink-0 self-start p-0.5 rounded text-text-tertiary/60 opacity-0 group-hover/card:opacity-100 hover:text-error hover:bg-bg-hover/50 transition-all"
        title={t('projectForm.deletePromptSection')}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}
