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
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'

interface PromptSectionsEditorProps {
  sections: ProjectPromptSection[]
  onChange: (sections: ProjectPromptSection[]) => void
}

/**
 * 项目提示词卡片编辑器
 *
 * 渲染为 SettingsSection 卡片内的扁平行：每行 = grip + title/content 输入 + 删除按钮，
 * divide-y 自然分隔（由父 SettingsSection 提供）。末尾追加一行"添加卡片"。
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
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {sections.map((section) => (
            <SortableRow
              key={section.id}
              section={section}
              onChangeTitle={(title) => updateSection(section.id, { title })}
              onChangeContent={(content) => updateSection(section.id, { content })}
              onRemove={() => removeSection(section.id)}
            />
          ))}
        </SortableContext>
      </DndContext>

      <div className="px-4 py-2.5">
        <button
          onClick={addSection}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
        >
          <Plus size={11} />
          {t('projectForm.addPromptSection')}
        </button>
      </div>
    </>
  )
}

interface SortableRowProps {
  section: ProjectPromptSection
  onChangeTitle: (title: string) => void
  onChangeContent: (content: string) => void
  onRemove: () => void
}

function SortableRow({
  section,
  onChangeTitle,
  onChangeContent,
  onRemove
}: SortableRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  // 内容 textarea 高度随文本自适应
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
      className="group/row flex items-start gap-2 px-4 py-3 hover:bg-bg-hover/40 transition-colors"
    >
      {/* 拖拽手柄 */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 self-stretch flex items-center px-0.5 rounded text-text-tertiary opacity-0 group-hover/row:opacity-100 hover:text-text-secondary cursor-grab active:cursor-grabbing transition-all"
        title={t('projectForm.dragToReorder')}
      >
        <GripVertical size={12} />
      </button>

      {/* 卡片主体 */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <input
          value={section.title}
          onChange={(e) => onChangeTitle(e.target.value)}
          className="w-full px-1.5 py-1 rounded-md text-[12px] font-medium bg-transparent border border-transparent hover:border-border-secondary/50 focus:border-accent/60 outline-none text-text-primary placeholder:text-text-tertiary transition-colors"
          placeholder={t('projectForm.promptSectionTitlePlaceholder')}
        />
        <textarea
          ref={contentRef}
          value={section.content}
          onChange={(e) => onChangeContent(e.target.value)}
          rows={1}
          className="w-full px-1.5 py-1 rounded-md text-[11px] leading-relaxed bg-transparent border border-transparent hover:border-border-secondary/50 focus:border-accent/60 outline-none text-text-secondary placeholder:text-text-tertiary transition-colors resize-none overflow-hidden"
          placeholder={t('projectForm.promptSectionContentPlaceholder')}
        />
      </div>

      {/* 删除按钮 */}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 self-start p-1 rounded text-text-tertiary opacity-0 group-hover/row:opacity-100 hover:text-error hover:bg-error/10 transition-all"
        title={t('projectForm.deletePromptSection')}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
