import { describe, expect, it } from 'vitest'
import { WebsiteContent, validateAnnouncements } from '../src/routes/content'
const item = { id: 'test', category: 'notice', date: '2026-10-01', tag: '公告', title: '原文标题', summary: '原文摘要', ctaLabel: '查看详情', featured: true, details: [{ type: 'paragraph', text: '不受语言切换影响的正文' }] }
describe('website announcements', () => {
  it('persists content and allows an intentionally empty publication', async () => {
    const values = new Map()
    const state = { storage: { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key,value) } } } as unknown as DurableObjectState
    const store = new WebsiteContent(state)
    const initial = await store.fetch(new Request('https://internal/'))
    expect(await initial.json()).toMatchObject({ data: { items: null } })
    await store.fetch(new Request('https://internal/', { method: 'PUT', body: JSON.stringify({items:[item]}) }))
    expect(await (await store.fetch(new Request('https://internal/'))).json()).toMatchObject({data:{items:[item]}})
    await store.fetch(new Request('https://internal/', { method: 'PUT', body: JSON.stringify({items:[]}) }))
    expect(await (await store.fetch(new Request('https://internal/'))).json()).toMatchObject({data:{items:[]}})
  })
  it('rejects duplicate IDs, unsupported rich content and oversized content', () => {
    expect(validateAnnouncements({ items: [item,item] })).toBeUndefined()
    expect(validateAnnouncements({ items: [{...item, details:[{type:'html',text:'<script>'}]}] })).toBeUndefined()
    expect(validateAnnouncements({ items: [{...item, title:'a'.repeat(201)}] })).toBeUndefined()
    expect(validateAnnouncements({ items: [item] })).toEqual([item])
  })
})
