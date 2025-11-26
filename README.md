# PowerSol Bot Documentation

## Overview
PowerSol is an async Python + Electron (renderer) hybrid bot for discovering, evaluating, and trading newly deployed Solana tokens with rate-limited market data, position monitoring, dynamic pricing refresh, and robust risk management.

## Architecture
- Python core (`powersol1.py`): scanning, price sourcing, trade execution, fees, risk logic.
- Electron main (`src/main.js`): spawns Python process, streams JSONL events to renderer.
- Preload bridge (`src/preload.js`): secure IPC surface (snipe, sell, config, etc.).
- Renderer (`src/renderer.js`): UI, tables, buttons, real‑time updates.
- Persistence: `trade_history.jsonl` line‑delimited open/close events.

Events are emitted as single-line JSON to stdout and parsed by the Electron main process, then forwarded to the renderer.

## Event Catalogue (Key)
- `token_found` – New token discovery.
- `position_opened` / `position_update` / `position_closed`
- `sell_result` – Lifecycle states: EXECUTING, ONCHAIN_QUOTE, QUOTE_FAILED, BROADCASTED, TX_FAILED, ERROR, DONE.
- `snipe_result` – Manual snipe states: LOOKUP_OK, LOOKUP_FAIL, SUBMITTED, EXECUTING, DONE, ERROR.
- `wallet_balance` – Wallet SOL balance (initial + on demand).
- `price_refresh` – Debug price fetch (forced refresh / anomaly).
- `trade_history_entry` – Open or close appended persistently.
- `config_snapshot` – Structured grouped settings for UI.
- `config_update` – Result of runtime mutation of a mutable setting.

### PnL Fields (Gross vs Net)
`position_update` now includes both gross and net PnL metrics when cost basis (including fees) is known:
```
{
  "type": "position_update",
  "symbol": "ABC",
  "currentPrice": 0.000123,
  "pnlPercent": 6.2,              // Gross % (legacy key)
  "pnlUsd": 1.84,                 // Gross USD (legacy key)
  "pnlPercentNet": 4.9,           // Net % after entry fees
  "pnlUsdNet": 1.45,              // Net USD after entry fees
  "pnlPercentGross": 6.2,         // Explicit gross mirror for clarity
  "feesPaidBuySol": 0.00021,      // Total SOL fees paid at entry (bot fee + tx where tracked)
  "entryCostBasisSol": 0.05021,   // Entry amount SOL + fees
  "entryCostBasisUsd": 8.12       // Cost basis USD using entry SOL price
}
```
Frontend prefers the `*Net` values when present. A divergence toast (PNL NET/GROSS) is emitted if:
- Sign differs between gross and net (fee flip scenario), or
- Absolute difference >= 2.5 percentage points.

At position close, realized metrics (`realizedPnlUsd`, `realizedPnlPercent`) override live values to avoid mismatch.

## Snipe Workflow (Manual Discovery Snipe)
### End-to-End Flow
1. Discovery loop finds a token meeting filters → emits `token_found` with metadata.
2. Token object stored in an internal `recent_tokens` deque (max ~150) for manual lookup.
3. User clicks sniper button in UI (renderer) or triggers `window.api.snipeToken({ symbol, amount })`.
4. Preload sends IPC to main → main writes a JSON line to Python stdin: `{ "cmd": "snipe", "symbol": "XYZ", "amount": 0.05 }`.
5. Python `_stdin_command_loop` routes to `_handle_manual_snipe`:
   - Resolves token by symbol / address against `recent_tokens`.
   - Emits `snipe_result` with `LOOKUP_OK` or `LOOKUP_FAIL`.
  - If OK: computes fee preview (`fee_manager.get_fee_info`), validates trade amount against fixed minimum 0.1 SOL.
   - Schedules actual async execution (buy path) via `_schedule_coro`.
6. Trade execution pipeline (simplified):
   - Price / safety validations.
   - Build / quote / send transaction (if `ENABLE_REAL_TRADES=true`).
   - Position object created; `position_opened` emitted.
   - Periodic monitor loop updates PnL via `position_update` events.
7. On later sell (auto or manual): `position_closed`, realized PnL fields emitted, `trade_history_entry` appended.

### Important Status Meanings (`snipe_result`)
- `LOOKUP_OK`: Token resolved for manual snipe.
- `LOOKUP_FAIL`: Symbol or address not found in recent tokens.
- `SUBMITTED` (optional/rare after dedupe): Request accepted.
- `EXECUTING`: Buy path started.
- `DONE`: Position opened successfully (expect a `position_opened` event separately).
- `ERROR`: Failure (will include `error`).

### Fee Handling During Snipe
Internal fee accounting (where enabled) is managed inside the backend and no longer exposed via `.env` or UI. In test mode (`ENABLE_REAL_TRADES=false`) any transfers are simulated; in real mode they follow internal threshold logic.

## Settings Organization
Settings grouped and emitted through `Config.META` allowing runtime safe mutation of selected keys.

### Getting a Snapshot
Send stdin line: `{"cmd":"config","action":"get"}` → emits `config_snapshot` with groups:
```
{
  "groups": {
  "trading": { "settings": [ {"key":"TRADE_AMOUNT_SOL","value":0.10,...}, ... ] },
    ...
  }
}
```
Secrets (`PRIVATE_KEY`, API keys, fee wallet) are masked.

### Updating A Setting (Runtime Mutable Only)
Example: change stop loss to 18%:
`{"cmd":"config","action":"set","key":"STOP_LOSS_PERCENT","value":18}`
→ Emits `config_update` `{ ok: true, key: "STOP_LOSS_PERCENT", value: 18 }` or an error state.

### Mutable vs Immutable
- Mutable groups: trading, filters, risk, rate_limit, slippage, flags, logging.
- Immutable (require restart / environment change): api_keys, rpc endpoints, fee wallet, private key.

### Risk Parameters Live Effect
- Updated values applied on next monitor loop iteration (stop loss / trailing stop recalculations). Can be extended to re-broadcast immediately if desired.

## Price Refresh & Anomaly Protection
- Normal refresh uses cached multi-source strategy.
- Forced refresh every N monitor cycles or via `reprice` command.
- Large negative jumps require confirmation from second API source before updating PnL.

## Trade History
- Stored in `trade_history.jsonl` with two record types: `open`, `close`.
- On startup snapshot loader emits recent closes then incremental events for continuity.

## Test Mode vs Real Mode
| Behavior | ENABLE_REAL_TRADES=false | ENABLE_REAL_TRADES=true |
|----------|--------------------------|--------------------------|
| Buy/Sell Tx | Simulated/path may short-circuit | On-chain transactions built & sent |
| Fee Transfer | Simulated (pending reset) | Real transfer when threshold met |
| PnL Calc | Uses simulated fills | Uses actual fills/quotes |

## Manual Commands (stdin)
- Sell position: `{ "cmd":"sell", "symbol":"XYZ", "reason":"MANUAL" }`
- Force price refresh: `{ "cmd":"reprice", "symbol":"XYZ" }`
- Wallet balance: `{ "cmd":"balance" }`
- Config snapshot: `{ "cmd":"config","action":"get" }`
- Update config: `{ "cmd":"config","action":"set","key":"STOP_LOSS_PERCENT","value":20 }`
- Manual snipe: `{ "cmd":"snipe","symbol":"XYZ","amount":0.05 }`

## Extending The System
1. Add new setting: define attribute on `Config`, add metadata in `Config.META`.
2. Emit a new event: call `emit_event(name, payload)` (must be JSON‑serializable).
3. Add new IPC action: extend preload + main process + stdin loop.

## Known Safe Points To Modify
- Strategy adjustments: scanning filters, risk thresholds.
- Monitoring intervals: tune `MONITOR_INTERVAL` and `SCAN_INTERVAL_SECONDS`.
- Fee logic: modify `FeeManager.min_fee_transfer` or estimation heuristics.

## Adaptive Pricing Subsystem (Realtime Efficient Layer)
Sistema introdotto per rendere frontend e backend molto reattivi senza saturare le API esterne.

### Obiettivi
1. Refresh rapido per posizioni aperte (alta priorità).
2. Aggiornamento batch ciclico per token scoperti (watchlist).
3. Filtro rumore: ignora micro variazioni sotto soglia (basis points).
4. Controllo richieste al minuto (RPM) + backoff adattivo + jitter.
5. Aggregazione eventi multipli in un solo `batched_price_update` → meno overhead IPC/DOM.

### Backend Flow
```
_adaptive_price_scheduler()
  ├─ Loop posizioni: TTL breve (PRICE_POSITION_INTERVAL_MS)
  ├─ Loop watchlist: round-robin batch (PRICE_MAX_BATCH)
  ├─ Delta threshold (PRICE_MIN_CHANGE_BPS) prima di accodare
  ├─ Accumula in pending_emits
  ├─ Emit ogni PRICE_EMIT_AGGREGATION_MS → batched_price_update
  └─ Gestione RPM: se >90% limite → backoff *= PRICE_BACKOFF_FACTOR
```

### Frontend Flow
```
on batched_price_update → PriceUpdateManager.ingestBatch()
  ├─ Unifica aggiornamenti
  ├─ requestAnimationFrame flush
  ├─ Filtro locale micro (<2 bps) per evitare repaint inutile
  ├─ Aggiorna openPositions + discovery cache
  └─ scheduleDiscoveryRefresh + updatePositionsTable
```

### Nuove Chiavi Config
| Key | Default | Descrizione |
|-----|---------|-------------|
| PRICE_BASE_INTERVAL_MS | 2500 | Intervallo base batch watchlist |
| PRICE_POSITION_INTERVAL_MS | 800 | Intervallo target posizioni aperte |
| PRICE_MIN_CHANGE_BPS | 3 | Delta minimo backend (0.03%) |
| PRICE_MAX_BATCH | 12 | Token processati per batch ciclo |
| PRICE_JITTER_MS | 400 | Jitter random aggiuntivo |
| PRICE_MAX_RPM | 120 | Limite richieste prezzo al minuto |
| PRICE_BACKOFF_FACTOR | 1.6 | Fattore crescita backoff |
| PRICE_PRIORITY_BOOST_FACTOR | 0.5 | Riduce sleep con posizioni attive |
| PRICE_EMIT_AGGREGATION_MS | 350 | Finestra aggregazione emissione |

### Ottimizzazione Rapida
| Scopo | Azione |
|-------|--------|
| Più reattività posizioni | Abbassa PRICE_POSITION_INTERVAL_MS (>=200 consigliato) |
| Meno traffico globale | Aumenta PRICE_BASE_INTERVAL_MS o PRICE_MIN_CHANGE_BPS |
| Ridurre flicker UI | Alza filtro bps frontend (modifica MIN_BPS in renderer) |
| Superare rate limits | Riduci PRICE_MAX_RPM + aumenta backoff |

### Evento Emesso
```
{
  "type":"batched_price_update",
  "updates":[ {"symbol":"ABC","currentPrice":0.0001234,"tokenAddress":"...","ts":1695400000.123}, ...]
}
```

### Sicurezza & Failover
- Backoff massimo 8× per evitare freeze definitivo.
- Flush finale pendings su terminazione scheduler.
- Se fetch fallisce token singolo → prosegue senza bloccare l'intero batch.

### Idee Future
- Adaptive threshold dinamico basato su volatilità recente.
- UI metrics: RPM live, % update scartati per rumore.
- Micro chart inline per ogni posizione (sparkline ultimi N prezzi).

---

## Troubleshooting Quick Table
| Symptom | Likely Cause | Action |
|---------|--------------|--------|
| No `token_found` events | Filters too strict | Lower `MIN_VOLUME_24H`, `MIN_LIQUIDITY`, or safety thresholds |
| PnL spike negative then revert | Anomaly detection engaged | Check `price_refresh` debug events |

## Security Notes
- Private key never emitted in events (masked in snapshots).
- Secrets loaded from environment at process start; rotations require restart.

## License / Usage
Internal project – ensure compliance with Solana network rules and local regulations.

---
Generated documentation reflecting current implementation state (September 2025).

## Discovery View Enhancements
The Discovery tab includes per‑token quick actions:
- Crosshair Snipe button (usa il simbolo / address già rilevato)
- Link diretto DexScreener (icona esterna) con apertura in nuova finestra

Entrambi hanno `aria-label` per accessibilità, stile coerente con gli altri pulsanti (classe `btn-icon`).

## Latest Tokens (Ultimi Token) Improvements
La sezione "Ultimi Token" ora:
 - Mostra prezzo con `formatAdaptivePrice` (precisione dinamica su micro-cap / frazioni).
 - Evidenzia variazioni immediate con flash verde/rosso (classi `flash-up` / `flash-down`).
 - Aggiornamento reattivo collegato sia a `position_update` sia a `batched_price_update` (scheduler adattivo backend).
 - Debounce via `requestAnimationFrame` (`scheduleTokensTableRefresh()`) per evitare repaint eccessivi.
 - Cache locale dei prezzi precedenti (`__prevTokenRowPrices`) per determinare direzione cambio.

Se vuoi aggiungere anche percentuali variazione (5m / 15m) in futuro, puoi riutilizzare l'history già usata per la discovery table reimpiegando `computeDeltaMinutes` sui token più recenti.
