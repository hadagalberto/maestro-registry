// Adapter de FORMATO — normaliza arquivo `.md` com frontmatter `name`/`description`/
// `tools`/`model` (subagente Claude Code) para RawCandidate. Cobre tanto fontes "flat"
// (0xfurai: `agents/<nome>.md`) quanto "por categoria" (VoltAgent: `categories/<cat>/
// <nome>.md`) sem precisar de config extra — descobre a forma andando pela árvore (design
// §6 "Adapters = dados por formato, não por fonte").

import { listContents, getRawText, type ContentEntry } from '../github.js'
import { parseFrontmatter } from '../util.js'
import type { RawCandidate, SourceConfig } from '../types.js'

const DEFAULT_EXCLUDE = new Set(['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'LICENSE.md', 'CHANGELOG.md'])

interface MdTarget {
  path: string
  name: string // nome do arquivo sem extensão — fallback se frontmatter não tiver `name`
}

/** Enumera targets .md até `limit`, descendo em subpastas (1 nível) quando a entrada raiz
 *  for um diretório de categoria. Minimiza chamadas à Contents API (só lista subpastas até
 *  bater o limite — o resto das categorias nem é listado). */
async function discoverMdTargets(repo: string, basePath: string, sha: string, limit: number): Promise<MdTarget[]> {
  const rootEntries = await listContents(repo, basePath, sha)
  const out: MdTarget[] = []

  const files = rootEntries.filter((e) => e.type === 'file' && e.name.endsWith('.md') && !DEFAULT_EXCLUDE.has(e.name))
  for (const f of files) {
    if (out.length >= limit) return out
    out.push({ path: f.path, name: f.name.replace(/\.md$/, '') })
  }

  const dirs = rootEntries.filter((e) => e.type === 'dir')
  for (const dir of dirs) {
    if (out.length >= limit) break
    let sub: ContentEntry[]
    try {
      sub = await listContents(repo, dir.path, sha)
    } catch {
      continue // categoria inacessível (rate-limit/404) — segue com as demais
    }
    const subFiles = sub.filter((e) => e.type === 'file' && e.name.endsWith('.md') && !DEFAULT_EXCLUDE.has(e.name))
    for (const f of subFiles) {
      if (out.length >= limit) break
      out.push({ path: f.path, name: f.name.replace(/\.md$/, '') })
    }
  }
  return out
}

export async function discoverAgentCandidates(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  const basePath = source.paths?.[0] ?? 'agents'
  const targets = await discoverMdTargets(source.repo, basePath, sha, source.limit)

  const out: RawCandidate[] = []
  for (const t of targets) {
    const raw = await getRawText(source.repo, sha, t.path)
    if (!raw) continue
    const { data, body } = parseFrontmatter(raw)
    const name = data.name || t.name
    const description = data.description || ''
    if (!description || !body) continue // sem description/corpo não é um agente válido

    out.push({
      name,
      description,
      version: undefined,
      tags: source.tags ?? [],
      clis: source.clis,
      type: 'agent',
      files: [{ rel: 'agent.md', content: Buffer.from(raw, 'utf8') }],
      author: null,
      itemUrl: `https://github.com/${source.repo}/blob/${sha}/${t.path}`,
      licenseDeclared: data.license || null,
      licenseFileText: null,
      skipReason: null,
    })
  }
  return out
}
