import type { Env } from '../env'
import { jsonResponse } from '../http/json'

export function announcementStore(env: Env) {
  return env.WEBSITE_CONTENT.getByName('announcements')
}
export function publicAnnouncements(env: Env) {
  return announcementStore(env).fetch('https://content.internal/')
}
export function validateAnnouncements(value: unknown): Record<string, unknown>[] | undefined {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items) || value.items.length > 50) return
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)
      || ids.has(item.id) || !['update', 'event', 'notice', 'guide'].includes(item.category)
      || (item.featured !== undefined && typeof item.featured !== 'boolean')) return
    ids.add(item.id)
    for (const [field, max] of Object.entries({ date: 40, tag: 80, title: 200, summary: 2000, ctaLabel: 80 })) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > max) return
    }
    if (!Array.isArray(item.details) || item.details.length > 100) return
    for (const section of item.details) {
      if (!section || typeof section !== 'object') return
      if (section.type === 'list') {
        if (!Array.isArray(section.items) || section.items.length > 100
          || !section.items.every((text: unknown) => typeof text === 'string' && text.length <= 10000)) return
      } else if (!['paragraph', 'heading'].includes(section.type) || typeof section.text !== 'string' || section.text.length > 10000) return
    }
  }
  if (JSON.stringify(value.items).length > 200000) return
  return value.items
}

export class WebsiteContent {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'PUT') {
      const input = await request.json()
      const items = validateAnnouncements(input)
      if (!items) return jsonResponse({ ok: false }, { status: 400 })
      await this.state.storage.put('announcements', items)
    }
    const items = await this.state.storage.get('announcements')
    return jsonResponse({ ok: true, data: { items: items ?? null } })
  }
}
