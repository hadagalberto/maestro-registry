// Helpers de fetch para GitHub REST API + raw.githubusercontent.com. SEM libs de HTTP —
// só o `fetch` nativo do Node. Trata 403/429 (rate-limit) com backoff e propaga erros de
// outros status para quem chama decidir se segue em frente (design §6 "rate-limit aware").

const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const headers: Record<string, string> = {
    'User-Agent': 'maestro-registry-aggregator',
    Accept: 'application/vnd.github+json',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** GET com retry/backoff em 403 (rate-limit) e 429. Até `maxRetries` tentativas; entre
 *  tentativas, espera o que vier em `Retry-After`/`X-RateLimit-Reset`, senão backoff
 *  exponencial (1s, 2s, 4s...). Outros status (404, 5xx) propagam imediatamente — quem
 *  chama decide se é fatal para a fonte ou só para o item. */
async function fetchWithBackoff(url: string, headers: Record<string, string>, maxRetries = 3): Promise<Response> {
  let attempt = 0
  for (;;) {
    const res = await fetch(url, { headers })
    if (res.status !== 403 && res.status !== 429) return res
    attempt++
    if (attempt > maxRetries) return res
    const retryAfter = res.headers.get('retry-after')
    const resetHeader = res.headers.get('x-ratelimit-reset')
    let waitMs = 2 ** attempt * 1000
    if (retryAfter) waitMs = Math.max(waitMs, Number(retryAfter) * 1000)
    else if (resetHeader) {
      const resetMs = Number(resetHeader) * 1000 - Date.now()
      if (resetMs > 0 && resetMs < 60_000) waitMs = Math.max(waitMs, resetMs)
    }
    console.warn(`[github] ${res.status} em ${url} — tentativa ${attempt}/${maxRetries}, aguardando ${waitMs}ms`)
    await sleep(waitMs)
  }
}

export class GitHubError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetchWithBackoff(`${GITHUB_API}${path}`, authHeaders())
  if (!res.ok) throw new GitHubError(`GET ${path} → ${res.status}`, res.status)
  return (await res.json()) as T
}

export interface ContentEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  download_url: string | null
  sha: string
}

/** GET /repos/{repo}/contents/{path}?ref=... — lista de arquivos/dirs de um diretório. */
export async function listContents(repo: string, path: string, ref: string): Promise<ContentEntry[]> {
  const data = await getJson<ContentEntry[] | ContentEntry>(
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  )
  return Array.isArray(data) ? data : [data]
}

/** Resolve `ref` (branch/tag) para o sha do commit atual — pin de reprodutibilidade
 *  (design §3.3). */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  const data = await getJson<{ commit: { sha: string } }>(`/repos/${repo}/branches/${encodeURIComponent(ref)}`)
  return data.commit.sha
}

/** `license.spdx_id` do repo via API (null quando o repo não declara licença única —
 *  típico de repos com licenças mistas por subpasta). */
export async function getRepoLicenseSpdx(repo: string): Promise<string | null> {
  try {
    const data = await getJson<{ license: { spdx_id: string } | null }>(`/repos/${repo}`)
    return data.license?.spdx_id ?? null
  } catch {
    return null
  }
}

/** Baixa um arquivo via raw.githubusercontent.com (não conta no rate-limit da API REST). */
export async function getRawText(repo: string, sha: string, path: string): Promise<string | null> {
  const res = await fetchWithBackoff(`${GITHUB_RAW}/${repo}/${sha}/${path}`, authHeaders())
  if (!res.ok) return null
  return await res.text()
}

export async function getRawBuffer(repo: string, sha: string, path: string): Promise<Buffer | null> {
  const res = await fetchWithBackoff(`${GITHUB_RAW}/${repo}/${sha}/${path}`, authHeaders())
  if (!res.ok) return null
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}
