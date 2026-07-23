import { createHash } from 'node:crypto'

const COMBINING_DIACRITICS = /[̀-ͯ]/g

/** slug determinístico — mesma regra do id do catalogItemSchema do Maestro
 *  (`^[a-z0-9][a-z0-9-]*$`). */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(COMBINING_DIACRITICS, '') // remove acentos (diacríticos combinantes pós-NFD)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 80) || 'item'
  )
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Parser mínimo de frontmatter YAML — suficiente para os formatos observados nas fontes
 * (SKILL.md / agent.md): chave: valor de 1 nível, com ou sem aspas. NÃO suporta
 * listas/objetos aninhados (`tools:`, `metadata:` são lidos como string bruta quando
 * presentes — suficiente porque os adapters só precisam de name/description/license/
 * tools/model).
 */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const [, fm, body] = m
  const data: Record<string, string> = {}
  const lines = fm.split(/\r?\n/)
  for (const line of lines) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rawValue] = kv
    let value = rawValue.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: body.trim() }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
