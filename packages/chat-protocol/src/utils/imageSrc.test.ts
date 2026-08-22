import { describe, it, expect } from 'vitest'
import { imageSrc } from './imageSrc'

describe('imageSrc', () => {
  it('裸 base64 + mimeType 补成 data URL（投影回来的消息只有这一种形态）', () => {
    expect(imageSrc({ data: 'AAAA', mimeType: 'image/png' })).toBe('data:image/png;base64,AAAA')
    expect(imageSrc({ data: 'AAAA', mimeType: 'image/jpeg' })).toBe('data:image/jpeg;base64,AAAA')
  })

  it('preview 优先（发送当次的内存态本就是完整 data URL）', () => {
    expect(
      imageSrc({ data: 'AAAA', preview: 'data:image/webp;base64,BBBB', mimeType: 'image/png' })
    ).toBe('data:image/webp;base64,BBBB')
  })

  it('data 已是完整 data URL 时不再套一层前缀', () => {
    expect(imageSrc({ data: 'data:image/gif;base64,CCCC', mimeType: 'image/png' })).toBe(
      'data:image/gif;base64,CCCC'
    )
  })

  it('没有任何数据时给空串，而不是一个会碎掉的 src', () => {
    expect(imageSrc({ mimeType: 'image/png' })).toBe('')
  })

  it('mimeType 缺失时回落 image/png', () => {
    expect(imageSrc({ data: 'AAAA', mimeType: '' })).toBe('data:image/png;base64,AAAA')
  })
})
