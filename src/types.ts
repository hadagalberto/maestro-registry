// Espelho MANUAL do schema consumido pelo Maestro (Terminal/src/shared/skills.ts +
// schemas.ts:catalogItemSchema). Extensão aditiva (design §4): license/source/author são
// opcionais — um app antigo (F5, sem esses campos) continua lendo o índice sem quebrar.
// Sem libs externas (zod incluso) por instrução do build — validação é feita à mão em
// src/validate.ts.

export type SkillCli = 'claude' | 'codex' | 'gemini'
// F8 (MCP install, Terminal) — 'mcp' espelha CatalogItemType em shared/skills.ts do app;
// o instalador (installByType.ts) já sabe rotear type=mcp (merge no config MCP do CLI).
export type CatalogItemType = 'skill' | 'agent' | 'hook' | 'mcp'

export interface CatalogSource {
  registry: string // id da fonte (= sources/<id>.json), também prefixo do namespace do id
  repo?: string // 'owner/repo'
  url?: string // link canônico do item upstream (atribuição)
  ref?: string // branch/tag resolvido
  sha?: string // commit pinado (reprodutibilidade)
}

export interface CatalogItem {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  clis: SkillCli[]
  dir: string
  files: string[]
  sha256?: Record<string, string>
  type: CatalogItemType
  license?: string
  source?: CatalogSource
  author?: string
}

export interface CatalogIndex {
  version: 1
  updatedAt: string
  items: CatalogItem[]
}

/** Arquivo materializado em memória, antes de ser escrito em disco. */
export interface MaterializedFile {
  rel: string // relativo a item.dir
  content: Buffer
}

/** Candidato pré-gate — o que um adapter devolve para o pipeline do aggregate.ts antes do
 *  gate de licença e da montagem final do CatalogItem. */
export interface RawCandidate {
  name: string
  description: string
  version?: string
  tags?: string[]
  clis: SkillCli[]
  type: CatalogItemType
  files: MaterializedFile[]
  author?: string | null
  itemUrl?: string | null
  // insumos para o gate de licença (src/license.ts) — resolvidos pelo adapter, decididos
  // pelo pipeline central (mantém license.ts como única fonte da política).
  licenseDeclared?: string | null
  licenseFileText?: string | null
  /** motivo para NÃO materializar mesmo com licença ok (ex.: hook com script auxiliar
   *  não-resolvível fora de um plugin) — vai para report.needsReview em vez do índice. */
  skipReason?: string | null
}

export interface SourceConfig {
  id: string
  adapter: 'skillmd' | 'agentmd' | 'hookjson' | 'mcpServer'
  repo: string
  ref: string
  type: CatalogItemType
  paths?: string[]
  mode?: 'plugins' | 'files' // hookjson: como descobrir os manifestos
  files?: string[] // hookjson mode:'files' — caminhos diretos (ex.: settings.json parciais)
  clis: SkillCli[]
  license?: { expected?: string; mode?: 'repo' | 'per-item' }
  mixedLicense?: boolean
  materialize: boolean
  limit: number
  tags?: string[]
  include?: string[]
  exclude?: string[]
  // mcpServer — base da Generic Registry API (registry.modelcontextprotocol.io). `repo`/`ref`
  // continuam obrigatórios pelo shape acima mas não são usados por este adapter (não há UM
  // repo upstream — a fonte agrega servidores de repos diferentes); ver aggregate.ts main().
  apiUrl?: string
}
