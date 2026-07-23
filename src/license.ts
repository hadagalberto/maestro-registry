// Gate de licença (design §5 REGISTRY-INTEGRATION.md). Só entram obras com licença
// permissiva e redistribuível; a licença é resolvida POR ITEM (nunca assumida do repo
// quando a fonte é `mixedLicense`); item sem licença clara = REJEITADO.

/** SPDX permissivos aceitos no índice (design §5.1). */
export const ALLOWLIST: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'Unlicense',
  'ISC',
  'CC-BY-4.0',
]

export function isAllowed(spdx: string | null | undefined): boolean {
  return !!spdx && ALLOWLIST.includes(spdx)
}

/**
 * Detecta um SPDX id a partir do TEXTO de um arquivo LICENSE/LICENSE.txt — usado quando o
 * item não declara `license:` explicitamente mas empacota o arquivo de licença completo
 * (caso comum em anthropics/skills, onde cada skill tem seu próprio LICENSE.txt e o repo
 * não tem uma licença única no nível do GitHub API).
 *
 * Heurística por palavra-chave (sem parser SPDX completo — suficiente para as fontes
 * mapeadas na pesquisa). Retorna null quando não reconhece o texto como uma licença
 * permissiva (inclui o caso proprietário do skill `pdf`/`docx`/`pptx`/`xlsx` da Anthropic:
 * "All rights reserved" + "governed by your agreement" → null, nunca permissivo).
 */
export function detectSpdxFromText(text: string): string | null {
  const t = text.slice(0, 4000) // primeiros ~4000 chars bastam para o cabeçalho da licença

  // Proprietário / restrito — checar ANTES das permissivas (evita falso positivo se a
  // licença proprietária mencionar termos genéricos).
  if (/all rights reserved/i.test(t) && /governed by your agreement|commercial terms/i.test(t)) {
    return null
  }
  if (/NOASSERTION/i.test(t)) return null

  if (/Apache License[\s,]*\r?\n\s*Version 2\.0/i.test(t)) return 'Apache-2.0'
  if (/MIT License/i.test(t) || /Permission is hereby granted, free of charge/i.test(t)) return 'MIT'
  if (/BSD 3-Clause/i.test(t) || (/Redistributions of source code/i.test(t) && /Neither the name/i.test(t))) {
    return 'BSD-3-Clause'
  }
  if (/BSD 2-Clause/i.test(t)) return 'BSD-2-Clause'
  if (/CC0[\s-]*1\.0|Creative Commons Zero|public domain dedication/i.test(t)) return 'CC0-1.0'
  if (/Unlicense/i.test(t)) return 'Unlicense'
  if (/ISC License/i.test(t) || (/Permission to use, copy, modify/i.test(t) && /ISC/i.test(t))) return 'ISC'
  if (/Attribution 4\.0 International|CC-BY-4\.0/i.test(t)) return 'CC-BY-4.0'

  return null
}

/** Normaliza um valor declarado (frontmatter `license:`, `plugin.json.license`, campo
 *  `license.spdx_id` da API do GitHub) para um SPDX da allowlist, ou null. */
export function normalizeDeclared(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  // valor já é um SPDX conhecido
  const exact = ALLOWLIST.find((id) => id.toLowerCase() === v.toLowerCase())
  if (exact) return exact
  // indireção comum: "Complete terms in LICENSE.txt" — não é o SPDX em si, quem chama deve
  // buscar o arquivo e usar detectSpdxFromText.
  return null
}

export interface LicenseResolutionInput {
  /** valor declarado no frontmatter/manifesto do item (`license:`), se houver. */
  itemDeclared?: string | null
  /** texto do arquivo LICENSE/LICENSE.txt do item, se materializável/encontrado. */
  licenseFileText?: string | null
  /** `license.spdx_id` do repo via GitHub API (null se repo não tem licença única). */
  repoSpdx?: string | null
  /** true quando a fonte tem licenças mistas conhecidas (ex.: anthropics/skills) — força
   *  resolução por item e IGNORA a licença do repo mesmo que exista. */
  mixedLicense: boolean
}

export interface LicenseResolution {
  license: string | null
  /** de onde veio a decisão — para ATTRIBUTION.md/report.json. */
  origin: 'item-declared' | 'license-file' | 'repo-spdx' | 'none'
  allowed: boolean
}

/** Resolução de licença por item — precedência: item.license → LICENSE(.txt) da pasta →
 *  license.spdx_id do repo (só quando !mixedLicense). Design §5.3. */
export function resolveLicense(input: LicenseResolutionInput): LicenseResolution {
  const declared = normalizeDeclared(input.itemDeclared)
  if (declared) return { license: declared, origin: 'item-declared', allowed: isAllowed(declared) }

  if (input.licenseFileText) {
    const fromFile = detectSpdxFromText(input.licenseFileText)
    if (fromFile) return { license: fromFile, origin: 'license-file', allowed: isAllowed(fromFile) }
    // texto de licença existe mas não foi reconhecido como permissivo — REJEITA (não cai
    // pro repo-level; um LICENSE.txt de item explícito e não-permissivo vence, mesmo com
    // !mixedLicense — ex.: skill "pdf" da Anthropic).
    return { license: null, origin: 'license-file', allowed: false }
  }

  if (!input.mixedLicense && input.repoSpdx) {
    const norm = normalizeDeclared(input.repoSpdx) ?? (ALLOWLIST.includes(input.repoSpdx) ? input.repoSpdx : null)
    if (norm) return { license: norm, origin: 'repo-spdx', allowed: isAllowed(norm) }
    return { license: input.repoSpdx, origin: 'repo-spdx', allowed: isAllowed(input.repoSpdx) }
  }

  return { license: null, origin: 'none', allowed: false }
}
