// Adapter de FORMATO — consome a Generic Registry API (registry.modelcontextprotocol.io,
// spec MCP oficial: GET /v0/servers?version=latest&cursor=...) e normaliza cada `server.json`
// para RawCandidate(s) type='mcp'. Molde do arquivo materializado (`mcp.json`) espelha
// installByType.mcpDefSchema no app Terminal — só dois formatos:
//   { transport: 'stdio', command, args?, env? }
//   { transport: 'http', url, headers? }
//
// Cap CONSERVADOR (design REGISTRY-INTEGRATION.md §5 aplicado a mcp): diferente das outras
// fontes (1 repo upstream conhecido, licença resolvida uma vez por fonte), aqui CADA servidor
// vem de um repo diferente e a Generic Registry API não carrega `license:` nenhuma. Por isso:
//   1. só entram servidores com um remoto http/sse (nada de processo local) OU um pacote npm
//      de transporte stdio SEM runtimeArguments/packageArguments (evita risco de injeção via
//      argumento de linha de comando — aviso explícito no server.schema.json oficial);
//   2. só entram servidores com `repository.url` apontando pra um repo do GitHub — sem repo
//      declarado não dá pra verificar licença, então pula (silencioso, não é "needsReview":
//      não é um erro de item, é o universo de fontes sem repo simplesmente não sendo elegível
//      aqui ainda);
//   3. a licença em si vem de `license.spdx_id` do repo via GitHub API (mesmo helper usado
//      pelas outras fontes) — sem isso, pula. resolveLicense() no aggregate.ts ainda roda por
//      cima do que devolvemos (licenseDeclared), então o gate central da allowlist continua
//      valendo mesmo com `spdx` resolvido aqui.
// Variáveis de ambiente declaradas pelo pacote (`environmentVariables`) viram placeholders
// `${NOME}` no `env` do stdio — o valor real (chave de API etc.) fica por conta do usuário
// definir na própria máquina; o Maestro nunca grava segredos que não conhece.

import { getRepoLicenseSpdx } from '../github.js'
import type { RawCandidate, SkillCli, SourceConfig } from '../types.js'

interface RegistryEnvVar { name?: string }
interface RegistryTransport { type?: string }
interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  transport?: RegistryTransport
  environmentVariables?: RegistryEnvVar[]
  runtimeArguments?: unknown[]
  packageArguments?: unknown[]
}
interface RegistryRemote { type?: string; url?: string }
interface RegistryRepository { url?: string; source?: string }
interface RegistryServer {
  name: string
  title?: string
  description?: string
  version?: string
  websiteUrl?: string
  repository?: RegistryRepository
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}
interface RegistryEntry { server: RegistryServer }
interface RegistryPage { servers: RegistryEntry[]; metadata?: { nextCursor?: string } }

const HTTP_TRANSPORTS = new Set(['streamable-http', 'sse', 'http'])
const MAX_PAGES = 20 // teto de segurança (limit do source já corta bem antes disso na prática)

async function fetchPage(apiUrl: string, cursor: string | undefined): Promise<RegistryPage> {
  const url = new URL('/v0/servers', apiUrl)
  url.searchParams.set('version', 'latest')
  url.searchParams.set('limit', '50')
  if (cursor) url.searchParams.set('cursor', cursor)
  const res = await fetch(url.toString(), { headers: { 'User-Agent': 'maestro-registry-aggregator' } })
  if (!res.ok) throw new Error(`GET ${url.toString()} → ${res.status}`)
  return (await res.json()) as RegistryPage
}

function repoFromGithubUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = /github\.com\/([^/\s]+\/[^/\s#?]+)/i.exec(url)
  return m ? m[1].replace(/\.git$/i, '') : null
}

function envPlaceholders(vars: RegistryEnvVar[] | undefined): Record<string, string> | undefined {
  if (!vars || vars.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const v of vars) {
    if (v?.name) out[v.name] = `\${${v.name}}`
  }
  return Object.keys(out).length > 0 ? out : undefined
}

type Installable =
  | { transport: 'http'; url: string }
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }

/** Escolhe o jeito mais conservador de instalar este servidor — ver cabeçalho do arquivo.
 *  null = nenhuma opção segura o bastante (sem remoto simples nem pacote npm stdio simples). */
function pickInstallable(srv: RegistryServer): Installable | null {
  const remote = (srv.remotes ?? []).find((r) => !!r.url && HTTP_TRANSPORTS.has((r.type ?? '').toLowerCase()))
  if (remote?.url) return { transport: 'http', url: remote.url }

  const pkg = (srv.packages ?? []).find((p) =>
    p.registryType === 'npm' &&
    !!p.identifier &&
    (p.transport?.type ?? 'stdio').toLowerCase() === 'stdio' &&
    (!p.runtimeArguments || p.runtimeArguments.length === 0) &&
    (!p.packageArguments || p.packageArguments.length === 0),
  )
  if (pkg?.identifier) {
    const spec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier
    return { transport: 'stdio', command: 'npx', args: ['-y', spec], env: envPlaceholders(pkg.environmentVariables) }
  }
  return null
}

function clisFor(installable: Installable): SkillCli[] {
  // codex (Terminal installByType.ts) só instala mcp stdio — remoto http recusa lá.
  return installable.transport === 'http' ? ['claude', 'gemini'] : ['claude', 'codex', 'gemini']
}

export async function discoverMcpCandidates(source: SourceConfig): Promise<RawCandidate[]> {
  const apiUrl = source.apiUrl ?? 'https://registry.modelcontextprotocol.io'
  const out: RawCandidate[] = []
  const licenseCache = new Map<string, string | null>()
  let cursor: string | undefined
  let pages = 0

  while (out.length < source.limit && pages < MAX_PAGES) {
    pages++
    let page: RegistryPage
    try {
      page = await fetchPage(apiUrl, cursor)
    } catch (e) {
      console.warn(`[mcpServer] falha ao buscar página da Generic Registry API (${String(e)}) — parando nesta página.`)
      break
    }

    for (const entry of page.servers) {
      if (out.length >= source.limit) break
      const srv = entry.server
      if (!srv) continue

      const installable = pickInstallable(srv)
      if (!installable) continue // sem remoto http/sse nem pacote npm stdio simples

      const repo = repoFromGithubUrl(srv.repository?.url)
      if (!repo) continue // sem repositório GitHub declarado — não dá pra verificar licença

      let spdx: string | null
      if (licenseCache.has(repo)) {
        spdx = licenseCache.get(repo) ?? null
      } else {
        spdx = await getRepoLicenseSpdx(repo)
        licenseCache.set(repo, spdx)
      }
      if (!spdx) continue // repo sem license.spdx_id — não arrisca

      const def = installable.transport === 'http'
        ? { transport: 'http' as const, url: installable.url }
        : {
            transport: 'stdio' as const,
            command: installable.command,
            args: installable.args,
            ...(installable.env ? { env: installable.env } : {}),
          }

      out.push({
        name: srv.title || srv.name,
        description: srv.description ?? '',
        version: srv.version,
        tags: source.tags ?? [],
        clis: clisFor(installable),
        type: 'mcp',
        files: [{ rel: 'mcp.json', content: Buffer.from(`${JSON.stringify(def, null, 2)}\n`, 'utf8') }],
        author: repo.split('/')[0],
        itemUrl: srv.websiteUrl ?? `https://github.com/${repo}`,
        licenseDeclared: spdx,
        licenseFileText: null,
        skipReason: null,
      })
    }

    if (!page.metadata?.nextCursor) break
    cursor = page.metadata.nextCursor
  }

  return out
}
