# Arquitetura

```
TSE (oficial)  ──poll──>  poller ──> normalize ──> SQLite (snapshots + changes)
                            │                            │
capture-raw ──> data/raw/   └──> bus ──> ws ──> navegadores
                                          │
                                    api (REST) ──> front (mapa, barras, UF, mercados)
```

## Princípios

1. **Só dado oficial.** Nada de scraping de terceiros para votos. Fonte: `resultados.tse.jus.br/oficial`.
2. **O histórico é a verdade.** Todo ciclo grava snapshot imutável com hash; o front sempre pode pedir `?t=` e reconstruir qualquer instante.
3. **Nunca perder a janela de apuração.** `scripts/capture-raw.mjs` grava o JSON cru a cada 20 s em `data/raw/` (fora do git). Se o banco quebrar, `scripts/backfill.mjs` reconstrói tudo do cru.
4. **Sem estado no cliente.** O front é burro: recebe estado inteiro, desenha. Nenhum cálculo de apuração no browser.
5. **Rate limit do TSE é 5 req/s.** Concorrência do poller = 6 UFs por vez, intervalo padrão 30 s.

## Módulos

| Módulo | Papel |
| --- | --- |
| `src/shared/config.js` | Base do TSE, ids da eleição, UFs, cores, intervalos |
| `src/shared/rounds.js` | Rodadas (1º/2º turno), candidatos e cores oficiais |
| `src/server/poller.js` | Busca nacional + 27 UFs + exterior, ETag, backoff |
| `src/server/normalize.js` | Converte o JSON do TSE em estado estável (função pura + testes) |
| `src/server/db.js` | SQLite WAL: `snapshot`, `change`, `market` |
| `src/server/api.js` | REST: estado, timeline, histórico, snapshots |
| `src/server/ws.js` | WebSocket ao vivo + replay por cliente |
| `src/server/replay.js` | Relógio de replay comprimido |
| `src/server/markets.js` | Polymarket (Gamma) e Kalshi (trade-api) |
| `src/server/exterior.js` | Escopo `zz` (voto no exterior) |
| `src/web/*` | Front sem build, ES modules, SVG do mapa |

## Replay

`GET /api/timeline` devolve `{ts, pct}`; o scrubber manda `{type:'seek', t}` e o servidor passa a servir snapshots daquele ponto na cadência original multiplicada por `speed`. Cada cliente tem modo próprio; `{type:'live'}` volta ao ao-vivo.

## Limitações conhecidas

- A API do TSE não documenta o detalhamento por país do exterior; ver `docs/EXTERIOR.md`.
- Percentuais do TSE chegam com vírgula e 3 casas; normalizamos para 2 casas.
- `s.st` no escopo nacional inclui seções do exterior; o total de seções do Brasil é `s.st - e.est`.
