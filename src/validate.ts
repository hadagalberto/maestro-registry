// Valida index.json (design §3.4/validate.yml): schema estrutural, ids únicos, arquivos
// existem no disco, sha256 bate, licença presente e permissiva, sem path traversal em
// `files`. Roda tanto localmente (`npm run validate`) quanto no CI de PR — falha (exit 1)
// sem tocar em nada; nunca corrige/escreve.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowed } from './license.js'
import { sha256Hex } from './util.js'
import type { CatalogIndex, CatalogItem } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const INDEX_PATH = join(ROOT, 'index.json')

const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const VALID_TYPES = new Set(['skill', 'agent', 'hook', 'mcp'])
const VALID_CLIS = new Set(['claude', 'codex', 'gemini'])

function isSafeRel(rel: string): boolean {
  if (rel.length === 0) return false
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  if (/(^|[/\\])\.\.($|[/\\])/.test(rel)) return false
  if (/^[A-Za-z]:/.test(rel)) return false // caminho absoluto Windows (C:\...)
  return true
}

interface Problem { itemId: string; message: string }

function validateItem(item: CatalogItem, allIds: Map<string, number>): Problem[] {
  const problems: Problem[] = []
  const tag = item.id || '(sem id)'

  if (typeof item.id !== 'string' || !ID_RE.test(item.id)) {
    problems.push({ itemId: tag, message: `id inválido: "${item.id}" (regex ${ID_RE})` })
  } else if ((allIds.get(item.id) ?? 0) > 1) {
    problems.push({ itemId: tag, message: 'id duplicado no índice' })
  }

  if (!item.name || typeof item.name !== 'string') problems.push({ itemId: tag, message: 'name ausente/vazio' })
  if (typeof item.description !== 'string') problems.push({ itemId: tag, message: 'description ausente' })
  if (!item.version || typeof item.version !== 'string') problems.push({ itemId: tag, message: 'version ausente/vazia' })

  const type = item.type ?? 'skill'
  if (!VALID_TYPES.has(type)) problems.push({ itemId: tag, message: `type desconhecido: "${type}"` })

  if (!Array.isArray(item.clis) || item.clis.length === 0) {
    problems.push({ itemId: tag, message: 'clis vazio/ausente' })
  } else {
    for (const cli of item.clis) {
      if (!VALID_CLIS.has(cli)) problems.push({ itemId: tag, message: `cli desconhecido: "${cli}"` })
    }
  }

  if (!item.dir || typeof item.dir !== 'string') {
    problems.push({ itemId: tag, message: 'dir ausente/vazio' })
    return problems // sem dir não dá pra checar arquivos
  }

  if (!Array.isArray(item.files) || item.files.length === 0 || item.files.length > 20) {
    problems.push({ itemId: tag, message: `files inválido (len=${Array.isArray(item.files) ? item.files.length : 'n/a'}, esperado 1..20)` })
  } else {
    for (const rel of item.files) {
      if (typeof rel !== 'string' || !isSafeRel(rel)) {
        problems.push({ itemId: tag, message: `caminho de arquivo inseguro/inválido: "${rel}"` })
        continue
      }
      const abs = join(ROOT, item.dir, rel)
      if (!existsSync(abs)) {
        problems.push({ itemId: tag, message: `arquivo materializado não existe: ${item.dir}/${rel}` })
        continue
      }
      const expected = item.sha256?.[rel]
      if (expected) {
        const actual = sha256Hex(readFileSync(abs))
        if (actual !== expected) {
          problems.push({ itemId: tag, message: `sha256 não confere para ${rel} (esperado ${expected.slice(0, 12)}…, atual ${actual.slice(0, 12)}…)` })
        }
      }
    }
  }

  // license gate (design §3.4 item 4: "license gate re-executado")
  if (!item.license || !isAllowed(item.license)) {
    problems.push({ itemId: tag, message: `licença ausente ou não-permissiva: "${item.license ?? 'nenhuma'}"` })
  }

  if (item.source && (!item.source.registry || typeof item.source.registry !== 'string')) {
    problems.push({ itemId: tag, message: 'source.registry ausente' })
  }

  return problems
}

/** Diretórios materializados no disco que NÃO pertencem a nenhum item do índice —
 *  indício de sujeira deixada por um run anterior/adapter com bug (não é fatal, só aviso). */
function findOrphanDirs(index: CatalogIndex): string[] {
  const known = new Set(index.items.map((it) => it.dir))
  const orphans: string[] = []
  for (const typeDir of ['skills', 'agents', 'hooks', 'mcps']) {
    const abs = join(ROOT, typeDir)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = `${typeDir}/${entry.name}`
      if (!known.has(rel)) orphans.push(rel)
    }
  }
  return orphans
}

function main(): void {
  if (!existsSync(INDEX_PATH)) {
    console.error('[validate] index.json não encontrado — rode `npm run aggregate` primeiro.')
    process.exitCode = 1
    return
  }
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as CatalogIndex

  if (index.version !== 1) {
    console.error(`[validate] index.version inesperado: ${index.version} (esperado 1)`)
    process.exitCode = 1
    return
  }
  if (!Array.isArray(index.items)) {
    console.error('[validate] index.items não é um array')
    process.exitCode = 1
    return
  }

  const idCounts = new Map<string, number>()
  for (const it of index.items) idCounts.set(it.id, (idCounts.get(it.id) ?? 0) + 1)

  const problems: Problem[] = []
  for (const item of index.items) problems.push(...validateItem(item, idCounts))

  const orphans = findOrphanDirs(index)

  console.log(`[validate] ${index.items.length} itens no índice.`)
  const byType = new Map<string, number>()
  for (const it of index.items) byType.set(it.type ?? 'skill', (byType.get(it.type ?? 'skill') ?? 0) + 1)
  for (const [type, count] of byType) console.log(`  - ${type}: ${count}`)

  if (orphans.length > 0) {
    console.warn(`[validate] AVISO: ${orphans.length} diretório(s) materializados sem item correspondente no índice:`)
    for (const o of orphans) console.warn(`  - ${o}`)
  }

  if (problems.length > 0) {
    console.error(`\n[validate] FALHOU — ${problems.length} problema(s):`)
    for (const p of problems) console.error(`  - [${p.itemId}] ${p.message}`)
    process.exitCode = 1
    return
  }

  console.log('\n[validate] OK — index.json válido, ids únicos, arquivos presentes, sha256 conferido, licenças permissivas.')
}

main()
