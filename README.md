# Eleições 2026 — apuração em tempo real

Acompanhamento da apuração oficial do TSE para Presidente (2º turno, 25/10/2026): mapa por UF e por país, barras por candidato, histórico completo com **replay** e cotações de mercados de previsão (Polymarket e Kalshi).

Sem chat, sem enxame de widgets: dados oficiais, mapa, apuração, histórico.

## Rodar

```bash
npm install
npm run geo        # baixa e gera os mapas (uma vez)
npm start          # http://localhost:8787
```

Captura contínua do JSON cru (recomendado no dia da eleição, em outro terminal):

```bash
node scripts/capture-raw.mjs
```

Depois, para reconstruir o banco a partir do cru:

```bash
node scripts/backfill.mjs --round 2t
```

## Variáveis

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `8787` | Porta HTTP |
| `TSE_ROUND` | `2t` | Rodada exposta na API/UI (`1t`, `2t`) |
| `POLL_INTERVAL_MS` | `30000` | Intervalo de coleta nacional+UFs |
| `MARKET_INTERVAL_MS` | `60000` | Intervalo de coleta dos mercados |
| `DB_PATH` | `data/apuracao.db` | Banco SQLite |
| `TSE_BASE` | API oficial | Troque só para testes/espelho |

Copie `.env.example` se preferir.

## API

REST: `GET /api/health`, `/api/state`, `/api/ufs`, `/api/candidates`, `/api/history`, `/api/timeline`, `/api/snapshot/:ts`, `/api/replay/:ts`, `/api/markets`, `/api/exterior`, `/api/movement`, `/api/evolution`.

WebSocket `/ws`:

```jsonc
// servidor -> cliente
{ "type": "hello", "state": {…}, "markets": {…}, "mode": "live" }
{ "type": "snapshot", "state": {…}, "changes": [ … ], "ts": 1792000000000 }
{ "type": "markets", "markets": {…} }
{ "type": "replayState", "replay": { "current": 0, "playing": true, "speed": 20 } }

// cliente -> servidor
{ "type": "seek", "t": 1792000000000 }
{ "type": "speed", "x": 30 }
{ "type": "live" }
```

## Camadas do mapa

O mapa tem cinco leituras, trocáveis na própria tela:

| Camada | O que mostra |
| --- | --- |
| Líder | Cor do candidato à frente; intensidade = % dele no estado |
| Vantagem | Intensidade = margem sobre o 2º colocado (p.p.) |
| Mudança | Verde/vermelho = % do líder subiu/caiu nos últimos 10 min |
| Abstenção | Rampa 0–40% do eleitorado apto |
| Apuração | % de seções apuradas (0–100%) |

Abaixo do mapa: **quem subiu, quem caiu** (top 10 por variação na janela de 10 min) e **evolução no tempo** (seções apuradas + % de cada candidato, leitura a leitura).

## Páginas

- `/` — apuração Brasil (mapa, UFs, mercados, replay)
- `/exterior.html` — voto no exterior

Idiomas: pt-BR, en, es (canto superior direito). Tema claro/escuro/auto.

## Dados

Fonte: `resultados.tse.jus.br/oficial` (arquivos `*-u.json` por escopo). Limite oficial de 5 req/s — o coletor usa 6 requisições concorrentes a cada 30 s.

- `snapshot` guarda o estado normalizado + hash (imutável);
- `change` guarda o delta por UF/candidato, usado nos destaques;
- `market` guarda o histórico de probabilidades (Polymarket/Kalshi), separado do TSE.

Replay reproduz snapshots na cadência original comprimida; cada cliente tem seu próprio relógio.

## Testes

```bash
npm test
```

## Avisos

- Projeto independente, sem vínculo com o TSE.
- Probabilidade de mercado é implícita e não substitui pesquisa.
- Números parciais aparecem marcados como parciais sempre que `pct < 100`.

## Deploy

Imagem única (Node 24 + SQLite), serve API, WebSocket e o front:

```bash
docker compose up -d --build     # http://localhost:10000
```

O volume `./data` guarda o SQLite e, se você rodar `node scripts/capture-raw.mjs`, os JSON crus.
Em produção, mantenha o `capture-raw` ativo num segundo container/processo para nunca perder a
janela de apuração.

## Estrutura de dados

| Tabela | Conteúdo |
| --- | --- |
| `snapshot` | estado normalizado + hash (imutável) por instante |
| `change` | delta de votos por UF/candidato |
| `market` | série de probabilidades Polymarket/Kalshi |

`GET /api/evolution` devolve a série leve para o gráfico; `GET /api/movement?window=600000`
devolve o ranking de quem subiu/caiu no período.
