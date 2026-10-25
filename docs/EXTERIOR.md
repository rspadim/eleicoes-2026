# Voto no exterior

Camada separada do mapa do Brasil. Mostra o voto de brasileiros no exterior
(escopo oficial **`zz`** do TSE) com mapa-múndi de bolhas por país e painel
comparando exterior × eleitorado/comparecimento nacional.

Arquivos deste módulo:

| Arquivo | Papel |
| --- | --- |
| `src/server/exterior-poller.js` | coleta do escopo `zz` e dos postos consulares |
| `src/server/exterior.js` | router `GET /api/exterior`, `GET /api/exterior/history` |
| `scripts/build-world.mjs` | gera o mapa-múndi (Natural Earth → SVG simplificado) |
| `public/geo/world.json` | SVG por ISO-3166 alpha-2 + centroides (≈160 KB) |
| `public/exterior.html` | página própria (`/exterior.html`) |
| `src/web/exterior.js` | UI: mapa, comparativo, ranking, tabelas |
| `src/web/exterior.css` | estilos da página |

---

## 1. O que a API do TSE realmente oferece

Sondagem feita em 25/10/2026 contra `resultados.tse.jus.br/oficial/ele2026/6258`:

| URL | Resultado |
| --- | --- |
| `dados/zz/zz-c0001-e006258-u.json` | **200** — agregado do exterior; mesmos blocos do escopo UF (`carg`, `s`, `e`, `v`) |
| `dados/zz/zz-e006258-ab.json` | **200** — acompanhamento por **posto consular** (187 entradas: 186 postos + `zz`) |
| `dados/zz/zz<codigo>-c0001-e006258-u.json` | **200** — votos do posto, ex. `zz29971-...` (Londres), `zz30112-...` (Miami) |
| `dados/zz/zz-c0001-e006258-<pais>-u.json` | 404 |
| `dados/zz/zz-c0001-e006258-mun<codigo>-u.json` | 404 |
| `dados/zz/zz-c0001-e006258-ab.json` | 404 (o `ab` do exterior não leva o cargo) |
| `config/zz-e006258-cm.json`, `config/pais-...`, `dados/zz/zz-e006258-mun.json` | 404 |
| `dados/br/br-e006258-ab.json` | **200** — acompanhamento nacional, inclui a linha `zz` |

Conclusão: **não existe detalhamento por país**. O TSE modela o exterior como uma
UF sintética (`zz`) cujos "municípios" são **postos consulares** (186, vindos de
`config/mun-e006258-cm.json` → `abr[cd=zz].mu`). Não há endpoint por país, região
ou continente.

### Estratégia adotada

1. O agregado oficial continua sendo o bloco `zz` — é dele que saem votos,
   seções e eleitorado do exterior.
2. `zz-e006258-ab.json` diz **quais postos** já começaram a apurar (campo `s.sa`).
3. Só os postos com seção apurada são buscados individualmente.
4. Os votos são agregados **localmente por país** com a tabela `POSTS`
   (código do posto → ISO-3166 alpha-2, em `src/server/exterior-poller.js`).
5. A agregação por país é marcada como derivada em
   `state.limitations.countryBreakdown = 'posts'` e a limitação é exibida na UI
   (`#ext-limitation`).

Isso é degradação consciente: o mapa e o ranking por país só aparecem quando
houver voto de posto. Sem posto apurado o estado ainda publica o total do
exterior e o comparativo com o Brasil.

---

## 2. Formato do estado publicado

Snapshot com `payload.scope = 'zz'` (nunca se confunde com `br`/UF):

```jsonc
{
  "ts": "2026-10-25T20:00:00.000Z",
  "scope": "zz",
  "election": { "ele": "6258", "cargo": 1, "ano": "2026" },
  "exterior": {
    "pct": 9.0,                    // % de seções apuradas no exterior
    "countedSections": 121, "totalSections": 1351,
    "electorate": 916683,          // eleitorado apto no exterior
    "validVotes": 1800, "blank": 20, "nulls": 30, "abstention": 50,
    "turnoutPct": 79.8,
    "candidates": [{ "n": "13", "nmu": "LULA", "color": "#e0362c", "votes": 1700, "pct": 94.44 }]
  },
  "national": { "validVotes": 335743, "electorate": 158745502, "abstention": 0, "...": "..." },
  "comparison": {
    "validSharePct": 0.536,        // exterior / votos válidos nacionais
    "electorateSharePct": 0.578,   // exterior / eleitorado nacional
    "exteriorTurnoutPct": 79.8,
    "nationalTurnoutPct": 0.43,
    "abstentionDeltaPct": -79.4
  },
  "countries": [{ "iso2": "PT", "validVotes": 1800, "pct": 90, "leader": "13", "posts": 1, "...": "..." }],
  "posts": [{ "code": "29955", "name": "Lisboa", "iso2": "PT", "countedSections": 9, "valid": 1700 }],
  "limitations": { "countryBreakdown": "posts", "note": "..." },
  "totals": { "pct": 9.0, "countedSections": 121, "totalSections": 1351 }
}
```

Regras do coletor, iguais ao poller principal:

- intervalo de **60 s** (`EXTERIOR_INTERVAL_MS`);
- ETag/`If-None-Match`; 304 não regrava;
- backoff exponencial em 429/5xx respeitando `X-RateLimit-Reset`;
- snapshot só quando o hash muda, com heartbeat de 2 min;
- evento `exterior` no bus (o WS principal ainda não o repassa — a página usa
  polling de 60 s como garantia e escuta `type: 'exterior'` caso o WS passe a
  encaminhar);
- `start({db})` não fecha banco emprestado; `stop()` só fecha o que abriu.

## 3. API

- `GET /api/exterior` → `{ state, ts, series[] }` (série dos últimos 120 pontos)
- `GET /api/exterior/history?limit=N` → `{ items[], count, limit }`, `limit` máx. **500**

CORS liberado, `cache-control: no-store`, `OPTIONS` → 204, outros métodos → 405.
Rotas fora de `/api/exterior` devolvem `false` (o handler é encadeável).

## 4. Mapa-múndi

`scripts/build-world.mjs` baixa o `ne_50m_admin_0_countries` do repositório
Natural Earth (domínio público) — o 110m omite países com posto consular, como
Bahrein, Barbados, Hong Kong, Cabo Verde e Singapura. Cada anel é simplificado
com **Douglas-Peucker** (tolerância 0,55°), projetado em **Mercator**, cortado
em latitudes abaixo de **-60** e gravado como path por ISO-3166 alpha-2 com
centroide do polígono dominante. A Guiana Francesa, que o GeoJSON desenha dentro
do polígono da França, é separada por bbox (`DETACHED` no script) para ter bolha
própria, já que Caiena e Saint-Georges são postos distintos.

```bash
node scripts/build-world.mjs                     # baixa a fonte
node scripts/build-world.mjs --local fonte.geojson
```

Saída atual: 204 países, ≈160 KB, `viewBox 0 0 1000 708`. O centroide é
geográfico (Mercator), não rótulo oficial — países multi-polígono têm a bolha no
maior fragmento.

## 5. Limitações conhecidas

- **Sem bucket por país no TSE**: qualquer número por país é agregação local de
  postos; um posto com nome de cidade (ex. “Lisboa”) representa todo o consulado.
- **Cobertura de postos**: só postos que o `ab` marca como iniciados são
  buscados. Posto sem seção apurada não aparece.
- **Comparativo nacional**: votos válidos e eleitorado vêm do agregado `br`
  (`/dados/br/br-c0001-e006258-u.json` e `/dados/br/br-e006258-ab.json`) ou do
  último snapshot `br` do banco, o que existir por último. A abstenção nacional
  no `u.json` ainda vem zerada no início da apuração, então
  `nationalTurnoutPct` pode ficar artificialmente baixo.
- **`e.est`/`c`/`a`**: no bloco `zz` o TSE não popula `c`/`a` como no escopo UF;
  a UI não usa esses campos.
- **Aglomeração de bolhas**: postos próximos (Europa, EUA) geram bolhas
  sobrepostas; a tabela por posto é a leitura precisa.
- **Sem autoria de i18n global**: as chaves `ext.*` vivem no `src/web/exterior.js`
  (pt-BR/en/es). O i18n global é usado apenas para detectar e persistir o locale,
  porque `public/locales/*.json` é propriedade de outro módulo.

## 6. Como validar

```bash
node --check src/server/exterior.js
node --check src/server/exterior-poller.js
node --check src/web/exterior.js
node --check scripts/build-world.mjs
node scripts/build-world.mjs            # deve gerar public/geo/world.json < 400KB
```

Smoke do router com banco em memória (`node:sqlite`):

```js
import { openDb } from './src/server/db.js';
import { createExterior } from './src/server/exterior.js';
const db = openDb(':memory:');
const h = createExterior({ db });
// h({ method: 'GET', url: '/api/exterior' }, res) -> true, JSON com state/series
```

Conferência manual das fontes:

```bash
curl -sI "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/zz/zz-c0001-e006258-u.json"
curl -s  "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/zz/zz-e006258-ab.json" | head -c 300
curl -s  "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/zz/zz29971-c0001-e006258-u.json" | head -c 300
```

A página fica em `/exterior.html`; o link de volta para o mapa do Brasil está no
topo e no `href="/"`.
