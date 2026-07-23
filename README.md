# maestro-registry

Backend do marketplace do [Maestro](https://github.com/hadagalberto/Terminal) — um `index.json`
gerado automaticamente a partir de fontes upstream **permissivas** (skills/agents/hooks), que o
app consome via `RegistryClient` (`raw.githubusercontent.com/hadagalberto/maestro-registry/main`).

Este repositório **não hospeda conteúdo escrito à mão** (exceto `sources/*.json`) — tudo o resto
é gerado por `src/aggregate.ts` e sobrescrito a cada run. Design completo:
`Terminal/.maestro-research/REGISTRY-INTEGRATION.md`.

## Modelo: sources → aggregate → index.json

```
sources/*.json  ──▶  src/aggregate.ts  ──▶  [ resolve ref/sha → discover → license gate →
(config de fonte,       (Node/tsx)            dedup → materialize → sha256 ]
editado à mão)                                          │
                                                          ▼
                              index.json + skills/<id>/ + agents/<id>/ + hooks/<id>/
                              + ATTRIBUTION.md + report.json  (tudo GERADO — não editar)
```

- **`sources/*.json`** — a única entrada humana. Um arquivo por fonte upstream: qual repo, qual
  adapter de formato usar, licença esperada, cap de itens, etc. (ver `src/types.ts:SourceConfig`).
- **`src/aggregate.ts`** — varre cada fonte (GitHub Contents API + `raw.githubusercontent.com`),
  normaliza cada item pelo adapter (`src/adapters/*.ts`), aplica o **gate de licença**
  (`src/license.ts`), deduplica, materializa os arquivos em `<type>s/<id>/`, calcula sha256 por
  arquivo e escreve `index.json` (mais `ATTRIBUTION.md` e `report.json`).
- **`src/validate.ts`** — reexecuta o gate de licença + confere schema/ids únicos/arquivos no
  disco/sha256, sem tocar em nada. Roda no PR (`validate.yml`) e localmente antes de confiar num
  `aggregate` novo.
- **`.github/workflows/aggregate.yml`** — cron diário: `aggregate` → `validate` → só commita se
  validate passou (índice quebrado nunca chega a ser publicado).
- **`.github/workflows/validate.yml`** — em PR: só `validate`, nunca agrega/commita.

## Como o Maestro consome

O app já sabe ler um índice remoto (`Terminal/src/main/catalog/registryClient.ts`): busca
`index.json`, faz merge com o índice bundled (`resources/registry/index.json`) — remoto vence por
`id` —, cacheia por 15min com fallback stale, e baixa os arquivos de cada item com cap de
512KB/arquivo e 2MB/item, verificando `sha256` quando presente. **Nenhum código do Maestro precisa
mudar** para consumir este repositório — ele já aponta pra aqui via `DEFAULT_REGISTRY_URL`.

O schema (`Terminal/src/shared/schemas.ts:catalogItemSchema`) é retrocompatível: os campos novos
deste registry (`license`, `author`, `source`) são opcionais — um app mais antigo continua lendo
o índice ignorando-os.

## Adapters (formato, não fonte)

| Adapter | Formato upstream | Fontes atuais |
|---|---|---|
| `skillmd` | pasta `<nome>/SKILL.md` (frontmatter YAML: `name`/`description`/`license?`) | `anthropics-skills`, `obra-superpowers` |
| `agentmd` | arquivo `.md` com frontmatter `name`/`description`/`tools`/`model` (flat ou por categoria) | `voltagent-subagents`, `0xfurai-subagents` |
| `hookjson` | manifesto `{ hooks: { <Event>: [{matcher?, hooks:[{type,command,timeout?}]}] } }` — de um `hooks/hooks.json` de plugin OU de um `settings.json` parcial | `karanb192-hooks`, `dwarvesf-guardrails` |

Adicionar uma fonte do MESMO formato = só um `sources/<novo>.json`, zero código. Um formato novo
exige um adapter novo em `src/adapters/`.

## Política de licença (gate)

Só entram obras com licença **permissiva e redistribuível**. Allowlist (`src/license.ts`): `MIT`,
`Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `Unlicense`, `ISC`, `CC-BY-4.0`.

A licença é resolvida **por item**, nunca assumida do repo quando a fonte é `mixedLicense: true`
— precedência: `license:` declarado no item → `LICENSE`/`LICENSE.txt` da própria pasta →
`license.spdx_id` do repo (só quando a fonte NÃO é mista). Item sem licença clara é **rejeitado**
e cai em `report.needsReview`, nunca no índice.

Exemplo real (fonte `anthropics-skills`, `mixedLicense: true`): skills como `frontend-design` e
`mcp-builder` têm `LICENSE.txt` = Apache License 2.0 → entram. Skills de documento (`docx`, `pdf`,
`pptx`, `xlsx`) têm `LICENSE.txt` = "© Anthropic, All rights reserved... governed by your
agreement" → **rejeitados**, mesmo estando no mesmo repo.

Cada item materializado carrega `license`, `author`, `source.{registry,repo,url,ref,sha}` — a
prova de atribuição exigida por MIT/BSD ("retain copyright notice") e Apache-2.0 (NOTICE). A
tabela completa fica em `ATTRIBUTION.md` (gerada a cada run).

## Limitação conhecida: hooks com script auxiliar

O Maestro instala um item `hook` fazendo **merge da entrada JSON** no `settings.json` do CLI
(`Terminal/src/main/catalog/installByType.ts:installHookItem`) — ele **não copia** scripts
auxiliares para lugar nenhum. Um `command` upstream que depende de `${CLAUDE_PLUGIN_ROOT}/<script>`
(típico de plugins do Claude Code, ex. `karanb192/claude-code-hooks`) ou de um caminho relativo
tipo `~/.claude/hooks/<script>` (ex. `dwarvesf/claude-guardrails`, hook `scan-commit`) **só
funciona instalado como plugin nativo** — não via merge simples. O adapter `hookjson`
(`src/adapters/hookjson.ts:NON_RESOLVABLE_COMMAND`) detecta isso e manda o item pra
`report.needsReview` em vez de materializá-lo quebrado no índice. Os comandos **autocontidos**
(`bash -c '...'` sem dependência externa) passam normalmente — é o caso da maior parte de
`dwarvesf-guardrails`.

Isso é reavaliado quando o Maestro ganhar instalação de plugin completo (fora do escopo deste
repo — mudança no app, `Terminal` repo).

## Rodando localmente

```bash
npm install
GITHUB_TOKEN=$(gh auth token) npm run aggregate   # sem token: 60 req/h (API REST) contra o
                                                    # limite anônimo do GitHub — dá pra rodar 1-2
                                                    # fontes pequenas, mas estoura rápido com 6
                                                    # fontes. Com token: 5000/h.
npm run validate
```

`--only <sourceId>` roda uma fonte só (ex. `npm run aggregate -- --only obra-superpowers`) — útil
pra testar um adapter/fonte nova sem gastar a cota das demais.

Cap conservador de `limit: 15` itens por fonte em cada `sources/*.json` — evita estourar o limite
não-autenticado e mantém o primeiro índice pequeno o suficiente pra revisar item a item. Suba o
`limit` depois que a fonte estiver validada.

## Adicionando uma fonte nova

1. Confirme a licença (permissiva? mista por item?) e o formato (bate com `skillmd`/`agentmd`/
   `hookjson`, ou precisa de adapter novo?).
2. Crie `sources/<id>.json` (ver os 6 exemplos existentes — `id` do arquivo = `id` dentro do JSON
   = prefixo de namespace dos itens gerados).
3. Adicione `<id>` em `SOURCE_ORDER` (`src/aggregate.ts`) — a posição define prioridade em caso de
   dedup entre fontes.
4. `npm run aggregate -- --only <id>` e revise `report.json` (`needsReview`/`duplicates`) antes de
   confiar no run completo.
5. `npm run validate` tem que passar. Abra PR — `validate.yml` roda a mesma checagem.

## Estrutura

```
sources/*.json          entrada humana — 1 fonte por arquivo
src/aggregate.ts        pipeline principal (roda no cron)
src/validate.ts         checagem read-only (roda no PR)
src/license.ts          gate de licença (allowlist + heurística de detecção por texto)
src/github.ts           fetch nativo + backoff em 403/429, sem libs de HTTP
src/adapters/*.ts       1 normalizador por FORMATO upstream
src/types.ts            espelho manual do CatalogItem/CatalogIndex do Maestro
index.json              ARTEFATO gerado — não editar à mão
skills/ agents/ hooks/  arquivos materializados por item
ATTRIBUTION.md          tabela item → autor → licença → fonte → sha (gerada)
report.json             needsReview/duplicates/counts do último run (gerado)
```
