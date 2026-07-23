// Adapter de FORMATO — normaliza um manifesto de hooks (`{ hooks: { <Event>: [ { matcher?,
// hooks: [{type,command,timeout?}] } ] } }`) para RawCandidate(s). Um manifesto pode
// declarar VÁRIOS eventos/grupos (ex.: um plugin com SessionStart+PostToolUse+SessionEnd);
// o CatalogItem/hookDefSchema do Maestro só aceita UM evento por item
// (`src/main/catalog/installByType.ts:hookDefSchema`), então este adapter EXPLODE cada
// grupo em um item próprio (design §6, passo NORMALIZE).
//
// Dois modos de descoberta (SourceConfig.mode):
//  - 'plugins': repo organizado como `plugins/<nome>/.claude-plugin/plugin.json` +
//    `plugins/<nome>/hooks/hooks.json` (karanb192/claude-code-hooks). Metadados do item
//    (nome/descrição/autor/versão/licença) vêm do plugin.json.
//  - 'files': arquivos avulsos que são um settings.json PARCIAL com `hooks:{...}` no topo
//    (dwarvesf/claude-guardrails — `lite/settings.json`, `full/settings.json`). Sem
//    metadados de plugin — o nome/descrição são derivados heuristicamente do próprio
//    comando (ver `deriveNameFromCommand`).
//
// Gate de "instalável de fato": o Maestro só materializa a ENTRADA JSON no settings.json
// do CLI (merge) — nunca copia scripts auxiliares (installHookItem só lê o .json, ver
// design REGISTRY-INTEGRATION.md §3.5 e installByType.ts:pickHookDefFile/installHookItem).
// Um comando que depende de `${CLAUDE_PLUGIN_ROOT}`/caminho relativo a um script externo
// SÓ funciona quando instalado como plugin nativo (`/plugin marketplace add`), não via
// merge simples — por isso é marcado com `skipReason` e cai em report.needsReview em vez
// de entrar (quebrado) no índice.

import { listContents, getRawText } from '../github.js'
import type { RawCandidate, SourceConfig } from '../types.js'

interface HookEntry { type: 'command'; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookEntry[] }
type HooksManifest = Record<string, HookGroup[]> // event -> grupos

interface PluginMeta {
  name: string
  description: string
  version?: string
  license?: string
  authorName?: string | null
}

const NON_RESOLVABLE_COMMAND = /\$\{CLAUDE_PLUGIN_ROOT\}|\$\{CLAUDE_PLUGIN_DATA\}|~\/\.claude\/hooks\//

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function parseHooksManifest(raw: unknown): HooksManifest {
  const root = isObj(raw) && isObj(raw.hooks) ? raw.hooks : {}
  const out: HooksManifest = {}
  for (const [event, groupsRaw] of Object.entries(root)) {
    if (!Array.isArray(groupsRaw)) continue
    const groups: HookGroup[] = []
    for (const g of groupsRaw) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue
      const hooks: HookEntry[] = []
      for (const h of g.hooks) {
        if (isObj(h) && h.type === 'command' && typeof h.command === 'string') {
          hooks.push({ type: 'command', command: h.command, timeout: typeof h.timeout === 'number' ? h.timeout : undefined })
        }
      }
      if (hooks.length > 0) groups.push({ matcher: typeof g.matcher === 'string' ? g.matcher : undefined, hooks })
    }
    if (groups.length > 0) out[event] = groups
  }
  return out
}

/** Extrai um nome/descrição legível do próprio comando quando não há metadados de plugin
 *  — muitos guard hooks (ex.: dwarvesf) fazem `echo "BLOCKED: <motivo>" >&2` antes do
 *  `exit 2`, o que dá uma descrição melhor que "PreToolUse grupo #2". */
function deriveFromCommand(command: string, event: string, matcher: string | undefined, index: number): { name: string; description: string } {
  const msg = /(?:BLOCKED|WARN(?:ING)?)[:\s]+([^"'\\]{6,120})/i.exec(command)
  if (msg) {
    const reason = msg[1].trim()
    return { name: reason.split(/[.:]/)[0].slice(0, 60), description: reason }
  }
  const label = matcher ? `${event} (${matcher})` : event
  return { name: `${label} #${index + 1}`, description: `Hook ${event}${matcher ? ` (matcher: ${matcher})` : ''} extraído do manifesto de origem.` }
}

function explode(
  manifest: HooksManifest,
  opts: {
    source: SourceConfig
    itemUrl: string
    plugin?: PluginMeta | null
    labelPrefix?: string
  },
): RawCandidate[] {
  const out: RawCandidate[] = []
  for (const [event, groups] of Object.entries(manifest)) {
    groups.forEach((group, index) => {
      const commandBlob = group.hooks.map((h) => h.command).join(' ; ')
      const nonResolvable = NON_RESOLVABLE_COMMAND.test(commandBlob)

      const derived = opts.plugin
        ? { name: `${opts.plugin.name} — ${event}`, description: opts.plugin.description }
        : deriveFromCommand(group.hooks[0]?.command ?? '', event, group.matcher, index)

      const name = opts.labelPrefix ? `${opts.labelPrefix} ${derived.name}` : derived.name
      const hookDef = { event, ...(group.matcher ? { matcher: group.matcher } : {}), hooks: group.hooks }

      out.push({
        name,
        description: derived.description,
        version: opts.plugin?.version,
        tags: opts.source.tags ?? [],
        clis: opts.source.clis,
        type: 'hook',
        files: [{ rel: 'hook.json', content: Buffer.from(`${JSON.stringify(hookDef, null, 2)}\n`, 'utf8') }],
        author: opts.plugin?.authorName ?? null,
        itemUrl: opts.itemUrl,
        licenseDeclared: opts.plugin?.license ?? null,
        licenseFileText: null,
        skipReason: nonResolvable
          ? 'comando depende de ${CLAUDE_PLUGIN_ROOT} ou script auxiliar fora do hook.json — ' +
            'o Maestro instala hook via merge simples no settings.json (não materializa scripts ' +
            'de plugin), então este item não funcionaria fora de um install nativo de plugin.'
          : null,
      })
    })
  }
  return out
}

async function discoverFromPlugins(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  const basePath = source.paths?.[0] ?? 'plugins'
  const entries = await listContents(source.repo, basePath, sha)
  const dirs = entries.filter((e) => e.type === 'dir').slice(0, source.limit)

  const out: RawCandidate[] = []
  for (const dir of dirs) {
    const pluginJsonRaw = await getRawText(source.repo, sha, `${dir.path}/.claude-plugin/plugin.json`)
    const hooksJsonRaw = await getRawText(source.repo, sha, `${dir.path}/hooks/hooks.json`)
    if (!hooksJsonRaw) continue // plugin sem hooks (ex.: só skills/commands) — não é desta fonte

    let manifest: HooksManifest
    try {
      manifest = parseHooksManifest(JSON.parse(hooksJsonRaw))
    } catch {
      continue
    }

    let plugin: PluginMeta | null = null
    if (pluginJsonRaw) {
      try {
        const pj: unknown = JSON.parse(pluginJsonRaw)
        if (isObj(pj)) {
          const author = isObj(pj.author) ? pj.author : null
          plugin = {
            name: typeof pj.name === 'string' ? pj.name : dir.name,
            description: typeof pj.description === 'string' ? pj.description : '',
            version: typeof pj.version === 'string' ? pj.version : undefined,
            license: typeof pj.license === 'string' ? pj.license : undefined,
            authorName: author && typeof author.name === 'string' ? author.name : null,
          }
        }
      } catch {
        /* plugin.json ilegível — segue sem metadados de plugin */
      }
    }

    out.push(...explode(manifest, { source, itemUrl: `https://github.com/${source.repo}/tree/${sha}/${dir.path}`, plugin }))
  }
  return out
}

async function discoverFromFiles(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  const out: RawCandidate[] = []
  for (const path of source.files ?? []) {
    const raw = await getRawText(source.repo, sha, path)
    if (!raw) continue
    let manifest: HooksManifest
    try {
      manifest = parseHooksManifest(JSON.parse(raw))
    } catch {
      continue
    }
    const labelPrefix = path.split('/')[0] // ex.: 'lite' | 'full'
    out.push(
      ...explode(manifest, {
        source,
        itemUrl: `https://github.com/${source.repo}/blob/${sha}/${path}`,
        plugin: null,
        labelPrefix,
      }),
    )
  }
  return out.slice(0, source.limit)
}

export async function discoverHookCandidates(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  return source.mode === 'files' ? discoverFromFiles(source, sha) : discoverFromPlugins(source, sha)
}
