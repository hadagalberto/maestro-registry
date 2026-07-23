// Adapter de FORMATO (não de fonte) — normaliza pasta `<nome>/SKILL.md` (+ LICENSE.txt
// opcional) no formato oficial Agent Skills (frontmatter YAML: name/description/license)
// para RawCandidate. Usado por anthropics-skills e obra-superpowers (design §6, §2.1/§3.1
// da pesquisa skills.md).

import { listContents, getRawText } from '../github.js'
import { parseFrontmatter } from '../util.js'
import type { RawCandidate, SourceConfig } from '../types.js'

const DEFAULT_EXCLUDE = new Set(['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'LICENSE.md'])

export async function discoverSkillCandidates(source: SourceConfig, sha: string): Promise<RawCandidate[]> {
  const basePath = source.paths?.[0] ?? 'skills'
  const entries = await listContents(source.repo, basePath, sha)
  const dirs = entries.filter((e) => e.type === 'dir').slice(0, source.limit)

  const out: RawCandidate[] = []
  for (const dir of dirs) {
    if (DEFAULT_EXCLUDE.has(dir.name)) continue
    const skillPath = `${dir.path}/SKILL.md`
    const raw = await getRawText(source.repo, sha, skillPath)
    if (!raw) continue // sem SKILL.md → não é um skill válido, ignora silenciosamente

    const { data, body } = parseFrontmatter(raw)
    const name = data.name || dir.name
    const description = data.description || ''
    if (!description) continue // sem description não atende ao spec — ignora

    // LICENSE.txt/LICENSE do próprio skill — precedência sobre a do repo quando a fonte é
    // mixedLicense (design §5.3); também usado como fallback de atribuição sempre que existir.
    const licenseFileText =
      (await getRawText(source.repo, sha, `${dir.path}/LICENSE.txt`)) ??
      (await getRawText(source.repo, sha, `${dir.path}/LICENSE`))

    const files = [{ rel: 'SKILL.md', content: Buffer.from(raw, 'utf8') }]
    if (licenseFileText) files.push({ rel: 'LICENSE.txt', content: Buffer.from(licenseFileText, 'utf8') })

    out.push({
      name,
      description,
      version: undefined, // sem `version` no frontmatter oficial — cai pro sha curto (aggregate.ts)
      tags: source.tags ?? [],
      clis: source.clis,
      type: 'skill',
      files,
      author: null, // skillmd não tem campo de autor no frontmatter — aggregate.ts usa o owner do repo
      itemUrl: `https://github.com/${source.repo}/tree/${sha}/${dir.path}`,
      licenseDeclared: data.license || null,
      licenseFileText,
      skipReason: body.length === 0 ? 'SKILL.md sem corpo (só frontmatter) — provavelmente inválido' : null,
    })
  }
  return out
}
