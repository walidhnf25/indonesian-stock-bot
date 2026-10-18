# Indonesian Stock Bot — Telegram AI Bot

An AI-assisted Telegram bot for Indonesian stocks listed on the **Indonesia Stock Exchange (IDX / BEI)**.
Users talk to it in natural Indonesian — no slash commands needed:

> `BBCA` · `analisis BBCA` · `kenapa BBCA naik?` · `bandingkan BBCA BBRI` · `tambahkan BBCA ke watchlist` · `ingatkan saya kalau BBCA di atas 8500`

It is a **data-driven analysis assistant**, not a trading signal service. Market data and every indicator
are fetched/calculated deterministically in TypeScript; the LLM only *explains* the supplied numbers.

- Runs **entirely on your Windows PC**: NestJS + PostgreSQL (Docker) + Ollama (local AI) + Telegram long polling.
- No public IP, domain, HTTPS, webhook, VPS, ngrok or paid service required.

> Status, evidence and limitations are in the [project report](docs/project-report.md); the threat model and controls are in [docs/security.md](docs/security.md). Security checks on this project were automated and done by the builder; they are **not** a substitute for a security review by a human or a third party.

---

## Contents

1. [Features](#features) · 2. [Architecture](#architecture) · 3. [Requirements](#requirements) · 4. [Quick start](#quick-start)
5. [Telegram bot setup](#telegram-bot-setup) · 6. **[Security and access control](#security-and-access-control)** · 7. [PostgreSQL](#postgresql-setup) · 8. [Ollama](#ollama-setup)
9. [AI safety, limits and timeouts](#ai-safety-limits-and-timeouts) · 10. [Stock data provider](#stock-data-provider) · 11. [Data freshness and plausibility](#data-freshness-and-plausibility)
12. [Environment variables](#environment-variables) · 13. [Usage](#telegram-usage) · 14. [REST API](#rest-api) · 15. [Technical analysis rules](#technical-analysis-rules)
16. [Testing](#testing) · 17. [Troubleshooting](#troubleshooting) · 18. [Known limitations](#known-limitations) · 19. [Future deployment](#future-deployment) · 20. [License](#license)

---

## Features

| Area | What it does |
|---|---|
| Access control | **Allowlist of Telegram user IDs, fail closed.** Strangers are rejected at the first middleware, before intent detection, AI, the stock API or the database. |
| Natural language | Deterministic Indonesian intent parser with ticker extraction, alias names (`telkom`→TLKM), Indonesian number formats (`8.500`, `4,5rb`), and conversation context (`bagaimana supportnya?` after `analisis BBCA`). Greetings/thanks are answered **without** the LLM. AI classification is used **only** for unrecognised messages and has its own per-user budget. |
| Quotes | Price, change, OHLC, volume, **real provider timestamp**, source, and a **LIVE / DELAYED / STALE / UNKNOWN** freshness label. |
| Historical questions | `harga BBCA kemarin`, `… tanggal 1 Oktober 2026`, `… minggu lalu` are answered from daily candles for **that** date. Today's price is never substituted; weekends, too-old dates and future dates are stated explicitly. |
| Technical analysis | SMA 5/20/50/100/200, EMA 12/26, RSI 14 (Wilder), MACD, Bollinger, ATR, volume SMA/ratio, swing-pivot support/resistance, trend/momentum classification. |
| AI analysis | The model only explains numbers the application computed. Output is validated by **category** (advice, certainty, targets/predictions, invented numbers, claims about data the app does not have); one stricter regeneration, then a deterministic fallback. Unsafe model text is never shown. |
| Buy/sell, target price, prediction | Answered by fixed policy text plus neutral technical data. The LLM never sees these questions, so it cannot be talked into giving advice. |
| Multiple tickers | Every ticker you name is handled; up to `MAX_SYMBOLS_PER_REQUEST` (5). More is refused with an explicit message, never silently truncated. |
| Comparison | Table of facts for 2–6 stocks + optional AI notes. Never ranks or names a “winner”. |
| Screening | Natural language → deterministic criteria (change %, volume ratio, RSI, price vs MA, momentum). A vague “saham apa yang bagus?” gets guidance on what can be filtered, not a ranking. |
| Watchlist | Per-user, natural language add/remove/list with prices and a STALE marker. |
| Alerts | Price above/below, RSI above/below, volume multiplier. One-shot, state machine (`ACTIVE→TRIGGERED/DISABLED`), atomic claim so a notification is **never sent twice**. Never fire on stale, undated or implausible prices; skipped alerts stay active. |
| Market status | Asia/Jakarta hours, lunch break, Friday schedule, weekends, configurable holidays. |
| Resilience | Cache + in-flight de-duplication + throttling + exponential backoff; last-known data (clearly marked STALE) if the provider fails; AI queue is bounded, AI calls time out with a clear message; AI/Telegram/provider outages never take the app down. |
| Safety | Educational disclaimer, no certainty/trade instructions, prompt-injection defence (delimited untrusted blocks), secrets scrubbed from logs, safe user-facing errors, rate limits per user/AI/IP. |

## Architecture

```
Telegram (long polling)                       Terminal (npm run chat)      REST (/health, /stocks…)
   │ allowlist middleware (first)                      │ (trusted, local only)       │
        └──────────────► ChatService ◄─────────────────┘                          │
                           │  ALLOWLIST → rate limit → user → context → intent     │
                           ▼                                                       │
   IntentService (rules → context → quota-gated AI fallback → validate)            │
                           │                                                       │
        ┌──────────────────┼───────────────────────────────┐                       │
        ▼                  ▼                               ▼                       ▼
  StockHandler      PortfolioHandler                GeneralHandler        AnalysisService / StockService
  (quote/tech/AI/   (watchlist, alerts)             (help, concepts)
   compare/screen)
        │
        ▼
 StockService ── cache / dedupe / throttle / retry / DB fallback ── StockDataProvider (Yahoo | …)
        │
        ▼
 AnalysisService ── pure TypeScript indicators ──► technical report
        │
        ▼
 AIService ── bounded queue + timeouts ── AIProvider (Ollama | Gemini | OpenAI)
        │      └─ policy validator + numeric grounding → one retry → deterministic fallback
        ▼
 telegram-response.ts (HTML formatting, timestamps, disclaimers) ──► Telegram

 Scheduler (every N s, market hours) ─► AlertService ─► NotifierService ─► Telegram
 PostgreSQL (Prisma): users, stocks, quote snapshots, daily candles, watchlists, alerts, AI analyses, context, fetch log
```

The business logic never calls a vendor SDK directly: market data goes through `StockDataProvider`, AI through `AIProvider`.

<details><summary>Project structure</summary>

```
prisma/                 schema.prisma + migrations
src/
  main.ts, app.module.ts
  config/               zod env validation, typed AppConfig
  access/               AccessService: Telegram allowlist (fail closed)
  common/               utils (format, ticker, cache, retry, rate-limit, semaphore, scrub), exception filter, guards
  database/             PrismaService
  user/ conversation/   Telegram users, short-term context (30 min, last tickers only)
  market/               IDX trading hours (Asia/Jakarta), data-quality (freshness + price plausibility)
  stock/                provider interface, Yahoo provider + normalizer, StockService (cache/fallback)
  analysis/             indicators/, support-resistance/, classification, AnalysisService
  ai/                   AIProvider interface, ollama|gemini|openai, prompts, context builder, output validation,
                        policy/ (safety categories + numeric grounding), per-user AI quota
  intent/               parsers/ (tickers, numbers, alerts, screening, temporal, conversational), intent-parser, validator, IntentService
  chat/                 ChatService + handlers (stock, portfolio, general)
  watchlist/ alert/ screener/ scheduler/ notifier/
  telegram/             grammY service + response formatters
  api/ health/          REST controllers
  cli/chat.ts           terminal chat (no Telegram needed)
  testing/              synthetic fixtures (excluded from build)
test/                   integration + e2e (real PostgreSQL test DB)
scripts/                live provider contract check
```
</details>

## Requirements

- Windows 10/11 (also works on macOS/Linux), **Node.js ≥ 20** (developed on 24), npm
- **Docker Desktop** (for PostgreSQL)
- **Ollama** (optional but recommended, for AI explanations)
- A Telegram account (to create a bot)

## Quick start

```powershell
git clone <repository>
cd indonesian-stock-bot
npm install
copy .env.example .env          # then edit .env: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS
docker compose up -d
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

Then open Telegram, find your bot and send: **`BBCA`**. If the bot answers *“Maaf, bot ini saat ini hanya dapat
digunakan oleh pengguna yang diizinkan.”* your Telegram ID is not in `TELEGRAM_ALLOWED_USER_IDS`
(see [Security and access control](#security-and-access-control)).

No Telegram token yet? Everything except Telegram works without one:

```powershell
npm run chat                    # interactive terminal chat using the same pipeline
npm run chat -- "analisis BBCA" # one-shot
```

## Telegram bot setup

1. In Telegram open **@BotFather** → `/newbot` → choose a name and a username ending in `bot`.
2. Copy the token it gives you (looks like `123456789:AAH…`).
3. Put it in `.env`: `TELEGRAM_BOT_TOKEN=123456789:AAH…` — **never commit it**; `.env` is git-ignored.
4. Put your numeric Telegram user ID in `TELEGRAM_ALLOWED_USER_IDS` (ask **@userinfobot**; several IDs are comma separated).
5. `npm run start:dev`. The log shows `Telegram long polling started as @yourbot`.

Long polling only needs outbound internet. The bot deletes any old webhook on start. Run **one** instance per token
(two pollers get `409 Conflict`). In groups the bot only reacts to commands and `@mentions`, and only for allowed users.

## Security and access control

The threat model, the controls and the tests that cover them, the known risks, and how to report a vulnerability are in [docs/security.md](docs/security.md).

**Who can use the bot.** Controlled by `TELEGRAM_ACCESS_MODE`:

| Mode | Who | Notes |
|---|---|---|
| `allowlist` (default) | Only the Telegram user IDs in `TELEGRAM_ALLOWED_USER_IDS` | Safest. Everybody else gets the fixed rejection message |
| `public` | **Every** Telegram user | Must be chosen explicitly (an empty allowlist never means public). The list is ignored. A warning is logged at startup |

**Public mode, what to expect.** Anyone who finds the bot can use it and spends *your* machine's CPU and local model. What still protects
you: the per-user message limit (`USER_RATE_LIMIT_PER_MINUTE`), per-user AI budgets, a bounded AI queue (1 generation at a time,
`AI_MAX_QUEUE_DEPTH` waiting; extra requests get the technical data without AI), a **per-user** AI budget (one running + one waiting
request per user, least-recently-served first, so one user cannot starve the others), `MAX_INPUT_LENGTH`, and the provider throttle.
What it does **not** give you: priority for the owner, a cap on the number of users, watchlists/alerts
that grow with the number of users (each user: max 20 alerts, bounded watchlist; all are checked every
`ALERT_CHECK_INTERVAL_SECONDS`), or protection of Yahoo's unofficial endpoint from heavy total traffic. Each user's Telegram ID, username
and name are stored in your database. Go back to `allowlist` at any time by changing the variable and restarting.

The rest of this section describes the default `allowlist` mode.

- **Fail closed:** in `allowlist` mode an empty or missing list means *nobody* is allowed. A warning is logged at startup. A malformed list
  (letters, negative numbers, …) stops the app at startup with a message that never echoes the raw value.
- **Earliest boundary:** the check is the first Telegram middleware and is repeated in `ChatService` as defence in depth.
  An unauthorized message never reaches intent detection, the AI, the stock API or the database (no user row, no
  conversation context). Tests assert this by counting provider calls, AI calls and DB rows.
- **Reply:** *“Maaf, bot ini saat ini hanya dapat digunakan oleh pengguna yang diizinkan.”* The list is never revealed. The
  reply is throttled per sender (a flood does not turn the bot into a spam source), and the bot stays silent for strangers
  in group chats.
- **Alerts** of a user who is removed from the list are not evaluated or delivered.
- The local terminal chat (`npm run chat`) is the only caller that bypasses the check (it is not reachable from Telegram).
- The allowlist is read at startup: change `.env` and restart to add or remove users.

**Token hygiene — rotate an exposed token.** If the bot token was ever pasted in a chat, ticket, screenshot, log or commit,
treat it as compromised:

1. In Telegram open **@BotFather** → `/mybots` → your bot → *API Token* → **Revoke current token**.
2. Put the **new** token only in your local `.env` (`TELEGRAM_BOT_TOKEN=`). Do not paste it into source files, issues or chats.
3. Restart the bot. The old token stops working immediately.

The application never logs the token or other secrets (logs are scrubbed), `.env` is git-ignored, and `.env.example`
contains no real values. Do not reuse an exposed token.

## PostgreSQL setup

```powershell
docker compose build postgres # postgres:16-alpine + pgvector, from docker/postgres/Dockerfile (needed for docs/rag.md)
docker compose up -d          # starts containers "ai-stock-postgres" and "ai-stock-redis"
docker compose ps             # should show "healthy"
npm run prisma:migrate        # applies prisma/migrations
npm run prisma:studio         # optional DB browser
```

The container is published on **`127.0.0.1:5436`** (not 5432) so it doesn't clash with other local PostgreSQL
instances. If you prefer 5432 set `POSTGRES_PORT=5432` before `docker compose up` and update `DATABASE_URL`.
Data lives in the Docker volume `ai-stock-indonesia_postgres_data`. Schema changes always go through migrations
(`prisma migrate`), never auto-sync.

**Renaming or moving the project folder is safe.** `docker-compose.yml` pins the compose project name
(`name: ai-stock-indonesia`), so a different folder name no longer creates a second project, and `docker compose up -d`
adopts the existing container and volume instead of failing with *“container name already in use”*. The container name
`ai-stock-postgres` is fixed on purpose, so only one stack can use it per machine. Stop it with `docker compose down`
(this keeps the data; `docker compose down -v` would delete it).

## Ollama setup

1. Install Ollama from <https://ollama.com/download> (Windows installer).
2. Pull a model. The app **does not assume any model exists**; pick one that fits your machine, e.g.
   ```powershell
   ollama pull qwen3:4b-instruct
   ```
3. Configure it in `.env`:
   ```
   AI_PROVIDER=ollama
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=qwen3:4b-instruct
   ```
4. Verify: `ollama list`, then `curl http://localhost:11434/api/tags`, then `curl http://localhost:3000/health` → `"ai":"available"`.

If Ollama is down or the model is missing the app keeps running: quotes, technical data, watchlist and alerts work, and AI
answers fall back to deterministic text that says AI is unavailable.

> **Performance:** measured live on the development machine (CPU only, `qwen3:4b-instruct`, machine otherwise idle, one model
> call per request): a full `analisis` took **15–21 s** and a question such as `kenapa BBCA naik?` **25–33 s**, end to end.
> An earlier run of the same requests took 55–63 s (cold model and/or a busy machine; not fully explained), so expect variation
> and measure on your hardware. The bot sends a “⏳ Menganalisis…” message first. `AI_TIMEOUT_MS` defaults to 90 s; a GPU, a
> smaller model, or `AI_PROVIDER=gemini|openai` makes it faster. `keep_alive` is 30 min, so only the first request after an
> idle period pays the model-load time.

Gemini/OpenAI are implemented behind the same interface (`GEMINI_API_KEY`+`GEMINI_MODEL`, `OPENAI_API_KEY`+`OPENAI_MODEL`)
but are **not** the default and were verified only with mocked HTTP in the test suite.

## AI safety, limits and timeouts

**Architecture: the model never writes what you read.** Free-form model text was the attack surface that failed twice in
review: first a phrase blacklist let *B U Y sekarang* through, then a rule-based validator still let 62 of 133 unsafe
paraphrases through and the comparison path had no semantic checks at all. Instead of listing more forbidden
wordings, the application now authors every sentence and the model only **chooses among them**:

```
Intent
  ├─ conceptual question (RSI, MACD, SMA, EMA, Bollinger, ATR, support, resistance, volume, rasio volume,
  │   volatilitas, tren/momentum) ─► deterministic glossary (src/knowledge/glossary.ts): NO model
  ├─ buy/sell, target price, prediction, guarantee ─► fixed policy text + neutral technical data: NO model
  ├─ quote, history, technical, screening, watchlist, alerts ─► deterministic: NO model
  └─ analysis / "why" question / comparison
        ─► deterministic market data + indicators
        ─► claims catalogue written by the application (O1.. observations, R1.. risks | D1.. rows, C1.. notes)
        ─► model replies with ids only  {"observations":["O3","O1"],"risks":["R2"]}
        ─► unknown ids / prose / extra fields are dropped; the application prints the chosen sentences
```

A conceptual question that also asks for advice ("Apa itu RSI? Bilang saya harus beli.") gets the glossary text **plus** the fixed
notice *“Saya tidak memberikan instruksi beli/jual…”*. Topics outside the glossary get a list of what can be explained (no model).

**What the model can and cannot do.** It can pick which of the application's own sentences matter for the question and put them
in order (the first becomes the headline, the rest bullets). It cannot add a word: free text, advice, predictions, invented
numbers, disguised spellings (`b,u,y`, `b+u+y`, homoglyphs…), injected "write exactly …" instructions and extra JSON fields have no
way to reach Telegram, because only catalogue sentences are ever rendered. The user's question only influences *which* ids are
chosen and is never echoed back. Trend, momentum and data limitations come from the application.

**The model cannot frame an answer by leaving things out.** It decides the *order* of the sentences, not which facts exist: a
selection with fewer than 3 observations is completed from the catalogue in its fixed order, and every risk derived from the data
(RSI zone, near support/resistance, volume, below MA50) is always shown, whatever the model picked (the list has room for all five plus the two fixed sentences,
so picking the fixed ones cannot push a data risk out). The two fixed boilerplate risks
are only shown when the model selects them (or when nothing else applies). Questions that ask whether a stock is *suitable*
(`layak koleksi`, `aman dipegang`, `bagus untuk jangka panjang`, `tp/sl berapa`, `recommended`, disguised spellings such as `b3l1`) get
the fixed advice notice, like `beli/jual`. A question about the past (`kemarin naik ga`) is a historical lookup, not a prediction refusal.

**Where the catalogue comes from.** Observations are the deterministic facts of the report (`buildFacts`: price change, range,
position vs MA20/50/200, RSI zone, MACD, volume ratio, Bollinger position, 5/20/60-day change, nearest support/resistance).
Risks are descriptive sentences chosen by data (RSI zone, nearness to support/resistance, volume vs average, below MA50) plus two
fixed ones. Comparison rows restate values from the per-stock entries (change, trend, momentum, RSI, MACD, price vs MA20/MA50,
volume ratio, 20-day change, price, support, resistance) and never rank or name a winner.

**Defence in depth.** The rendered text still passes the category/semantic/number-role output policy (`ai/policy`): if a catalogue
sentence ever broke it (a bug in the catalogue), the answer is withheld as `unsafe` rather than shown. Tests run the catalogue
through that policy for 625 generated report shapes and for random comparison inputs.

A selection with no valid id is regenerated once with a stricter instruction (the rejected output is **not** repeated back to the
model); if that fails too the user sees the deterministic report plus *“Hasil model AI tidak dapat diproses (format tidak valid)…”*
(or *“…tidak memenuhi validasi keamanan…”* for the defence-in-depth case). Quotes judged `invalid` (zero/negative/non-finite price,
impossible range) are not interpreted by the model at all.

**Prompt injection.** Prompts separate SYSTEM rules from delimited untrusted blocks (`USER_REQUEST`, `APPLICATION_DATA`); user
text never enters the system prompt and only the first `AI_QUESTION_MAX_CHARS` (300) characters of a question reach the model.
A fooled model can at worst choose a different set of true sentences, so injection cannot change what is said, only which
facts are listed.

**Trade-off.** A catalogue-selecting model is far less expressive than free prose: answers read like a short fact sheet, and
"why did it rise?" is answered with the price/volume facts plus the standing note that news and fundamentals are unavailable. If
you later add prose generation, it must go through the same kind of closed vocabulary or be treated as untrusted again.

**Cost and resource controls** (process-local, no Redis needed):

| Control | Setting (default) | When exceeded |
|---|---|---|
| Message length | `MAX_INPUT_LENGTH` (1000 characters) | “Pesanmu terlalu panjang…” before any parsing, database or AI work |
| Analysis requests per user per minute | `AI_ANALYSIS_MAX_REQUESTS_PER_USER_PER_MINUTE` (5) | Deterministic data + “Batas penggunaan AI per menit tercapai” |
| AI intent classification per user per minute | `AI_INTENT_MAX_REQUESTS_PER_USER_PER_MINUTE` (10) | The help text; no LLM call |
| Simultaneous generations (all users) | `AI_MAX_CONCURRENT_REQUESTS` (1) | Request waits in the queue |
| Per user: running / waiting | `AI_MAX_CONCURRENT_PER_USER` (1) / `AI_MAX_QUEUE_PER_USER` (1) | “Permintaan AI sebelumnya darimu masih diproses…” immediately; other users keep their turn |
| Queue length / wait (all users) | `AI_MAX_QUEUE_DEPTH` (3) / `AI_QUEUE_WAIT_TIMEOUT_MS` (60 s) | “AI sedang sibuk…” + deterministic data, immediately |
| One generation | `AI_TIMEOUT_MS` (90 s) | “Analisis AI sedang membutuhkan waktu terlalu lama…” + deterministic data |
| One intent classification | `AI_INTENT_TIMEOUT_MS` (10 s) | Help text |

**Fairness.** The AI gate serves waiting users least-recently-served first, so one user with several queued requests does not
delay another user's single request, and one account spread over many chats cannot fill the queue. Every release path (success,
exception, timeout, malformed output, Ollama down) frees the slot; a timeout does not switch AI off for everybody (only a real
outage does, and only for 5 seconds before it is probed again).

Intent classification never waits in the queue: while the model is busy, an unrecognised message is answered with the help text
immediately. Greetings, thanks, conceptual questions and advice-style questions never call the model. Where an AI notice is
shown the technical data is still shown, so the user always gets something useful.

**Honest limit:** these controls reduce risk; they do not make a 4B model correct. Because the model only selects
from application-written sentences it cannot say something false in its own words, but it can still pick a *less useful* set
of true facts. Keep reading the deterministic section.

## Stock data provider

**Default: Yahoo Finance** through the community library `yahoo-finance2` (free, no API key, IDX tickers use the `.JK` suffix).
It was inspected and verified live against current responses (`npm run test:live`).

| Data | Status |
|---|---|
| Quote, OHLC, volume, previous close, 52-week range | ✅ (IDX data is delayed ~10 min; the bot says so) |
| Daily history (used for all indicators) | ✅ |
| Fundamentals (market cap, PER, PBV, ROE, EPS, dividend yield, revenue, net income) | ✅ only fields Yahoo returns |
| Company profile, search, IHSG index | ✅ |
| **Foreign flow** | ❌ not offered → *“Data foreign flow tidak tersedia dari provider saat ini.”* |
| **Broker summary** | ❌ not offered → *“Data broker summary tidak tersedia dari provider saat ini.”* |

Yahoo is an **unofficial** source: endpoints can change or throttle without notice. The app retries with backoff, caches,
and serves last-known data clearly marked as stale. To add a provider implement `StockDataProvider`
(`src/stock/stock-data-provider.interface.ts`) and register it in `stock.module.ts`.

The screener works on a configurable **ticker universe** (≈90 liquid IDX codes in `src/intent/parsers/idx-universe.ts`
plus `SCREENER_EXTRA_SYMBOLS`) — responses state that it is *not* the entire exchange.

## Data freshness and plausibility

Every quote, watchlist, screening result and AI context carries a freshness state:

| State | Meaning |
|---|---|
| 🟢 **LIVE** | Provider declares no delay and the timestamp is within ~5 minutes (or, market closed, the close of the last session). |
| 🟡 **DELAYED** | Fresh enough, but the feed is delayed. This is the normal state for Yahoo/IDX (~10 min). |
| 🔴 **STALE** | Market open: older than `MARKET_DATA_STALE_AFTER_MINUTES` (30) **plus** the provider's declared delay. Market closed: dated before the last trading session. Also any copy served from our database because the provider failed. |
| ⚪ **UNKNOWN** | Timestamp missing, unparsable or in the future. |

The rule is market-aware: outside trading hours an old timestamp is normal (weekend, lunch break, evening), so the test is
“not older than the last trading session”, not “younger than N minutes”. STALE data is never shown as current: the message
says *“Data terakhir tersedia: …”* and the reason. Illiquid stocks that really have not traded for a long time during a
session are also reported STALE, which is the cautious choice.

**Quote trust (`trusted` / `suspect` / `invalid`).** "Numerically valid" is not "trusted enough to fire an alert". There is no
fixed price floor (low-priced stocks exist); each quote is compared with itself and with an independent reference (the
previous-session close in the stored daily candles):

| Quality | When | Effect |
|---|---|---|
| `invalid` | price not a finite positive number; open/high/low not finite positive; high < low; price outside the day's range | Warning shown, **no alert, no AI interpretation** |
| `suspect` | move beyond `PRICE_ANOMALY_MAX_CHANGE_PERCENT` (50 %) vs the previous close **even if all fields agree** (a corrupt quote can agree with itself); open outside the day's range; provider change % that contradicts the price; no previous close and no stored reference; previous close differing from the stored daily close by more than `PRICE_REFERENCE_TOLERANCE_PERCENT` (5 %) | Warning shown, **no alert** |
| `trusted` | none of the above | Normal |

Alerts run: fetched → freshness → quote quality → evaluate → claim → notify. An alert is **skipped (and stays active)** on
STALE/UNKNOWN, `suspect` or `invalid` data. Real ARA/ARB days (about ±35 %) stay trusted. **Limitation:** a real move beyond the
threshold, a stock split or another corporate action is `suspect` by design (a threshold set before it is meaningless anyway), so
alerts on such a stock are suppressed until the data normalises; raise the threshold if you prefer the other trade-off.

Limits: classification relies on the provider's timestamp, which Yahoo does not always set correctly, and with a single provider the
checks can only detect inconsistency, not prove a price right.

## Environment variables

Validated at startup (zod); bad values stop the app with a readable message that never echoes secrets.
Switches (`TELEGRAM_ENABLED`, `ALERT_CHECK_WHEN_CLOSED`, `REST_ALLOW_REMOTE`) accept `true/false`, `1/0`, `yes/no`, `on/off`; anything
else is an error (so `TELEGRAM_ENABLED=0` really disables Telegram). Numbers are range-checked on both sides (for example
`ALERT_CHECK_INTERVAL_SECONDS` 10-3600, `RETENTION_INTERVAL_HOURS` 1-168, because a longer timer would overflow Node's 32-bit delay).
`TZ` must be a valid IANA zone. `AI_PROVIDER=gemini` / `openai` requires its API key at startup, not at the first request.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL URL, e.g. `postgresql://postgres:postgres@localhost:5436/ai_stock` |
| `REDIS_URL` | empty | Optional. `redis://127.0.0.1:6380/0` with the compose Redis. Shares user/AI/provider quotas across processes; empty keeps them in-process. See `docs/redis.md` |
| `REDIS_CONNECT_TIMEOUT_MS` / `REDIS_KEY_PREFIX` | `2000` / `stockbot:` | Connection timeout; prefix of every key |
| `BOT_ROLE` | `all` | `all` = one process; `gateway` = Telegram + REST without queue workers (requires `REDIS_URL`); `worker` = BullMQ workers + local REST, never Telegram. See `docs/bullmq.md` |
| `TELEGRAM_BOT_TOKEN` | empty | BotFather token. Empty = Telegram disabled (REST + CLI still work) |
| `TELEGRAM_ACCESS_MODE` | `allowlist` | `allowlist` or `public` (everyone can use the bot; see [Security](#security-and-access-control)). Other values stop startup |
| `TELEGRAM_ALLOWED_USER_IDS` | empty | Comma separated numeric Telegram user IDs (used in `allowlist` mode). **Empty = nobody allowed** (fail closed); invalid entries stop startup |
| `STOCK_DATA_PROVIDER` | `yahoo` | Market data provider |
| `STOCK_API_KEY` | empty | For future keyed providers (unused by Yahoo) |
| `SCREENER_EXTRA_SYMBOLS` | empty | Extra tickers for screening, comma separated |
| `AI_PROVIDER` | `ollama` | `ollama` \| `gemini` \| `openai` |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / empty | Ollama endpoint and the model you pulled |
| `AI_TIMEOUT_MS` / `AI_INTENT_TIMEOUT_MS` | `90000` / `10000` | Timeout of one generation / one intent classification |
| `AI_MAX_CONCURRENT_REQUESTS` | `1` | Simultaneous generations (keep 1 for a local CPU model) |
| `AI_MAX_QUEUE_DEPTH` / `AI_QUEUE_WAIT_TIMEOUT_MS` | `3` / `60000` | Waiting requests allowed / longest wait before “busy” |
| `AI_MAX_CONCURRENT_PER_USER` / `AI_MAX_QUEUE_PER_USER` | `1` / `1` | One user's running / waiting AI requests; more get an immediate “busy” notice |
| `AI_QUESTION_MAX_CHARS` | `300` | Characters of a question that reach the model |
| `MAX_INPUT_LENGTH` | `1000` | Longest message processed; longer is refused before parsing/DB/AI |
| `AI_ANALYSIS_MAX_REQUESTS_PER_USER_PER_MINUTE` | `5` | Per-user analysis/answer budget |
| `AI_INTENT_MAX_REQUESTS_PER_USER_PER_MINUTE` | `10` | Per-user AI intent-classification budget |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | empty | Optional cloud providers |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | REST API port (1-65535) and bind address. A non-loopback `HOST` stops startup unless `REST_ALLOW_REMOTE=true` |
| `REST_ALLOW_REMOTE` | `false` | Explicit opt-in to serve the unauthenticated REST API on a non-loopback address (only behind a firewall or an authenticating proxy). Also switches off the Host/Origin check |
| `LOG_LEVEL` | `info` | `fatal…trace`, `silent` |
| `TZ` | `Asia/Jakarta` | Process timezone (market logic always uses Asia/Jakarta) |
| `ALERT_CHECK_INTERVAL_SECONDS` | `120` | Alert scheduler period |
| `ALERT_CHECK_WHEN_CLOSED` | `false` | Also check alerts outside market hours |
| `ALERT_TTL_DAYS` | `90` | Untriggered alerts expire after this many days (owner notified once). See `docs/alerts.md` |
| `CONTEXT_TTL_MINUTES` | `30` | How long the per-chat conversation context (last tickers and lookups, never message text) is kept. See `docs/context-memory.md` |
| `RAG_ENABLED` | `true` | Retrieval over the built-in knowledge corpus and personal notes (needs pgvector). See `docs/rag.md` |
| `EMBEDDING_PROVIDER` | `hashing` | `hashing` (deterministic, no model) or `ollama` (`/api/embed` with `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_TIMEOUT_MS`) |
| `RAG_MIN_SIMILARITY` | `30` | Percent similarity a vector-only hit needs to be shown |
| `FUNDAMENTALS_STALE_DAYS` | `7` | Fundamentals served from a stored snapshot older than this are marked stale. See `docs/fundamentals.md` |
| `FUNDAMENTAL_SNAPSHOT_RETENTION_DAYS` | `400` | Daily fundamentals snapshots older than this are deleted |
| `NEWS_PROVIDER` | `yahoo` | `yahoo` (headlines from the Yahoo search endpoint) or `none`. See `docs/news.md` |
| `NEWS_MAX_AGE_DAYS` / `NEWS_CACHE_TTL_SECONDS` / `NEWS_RETENTION_DAYS` | `14` / `900` / `90` | Headline freshness window, provider cache, archive retention |
| `MARKET_HOLIDAYS` | empty | `YYYY-MM-DD,…` exchange holidays (they change every year; set them yourself) |
| `USER_RATE_LIMIT_PER_MINUTE` | `20` | Messages per Telegram user per minute |
| `MAX_SYMBOLS_PER_REQUEST` | `5` | Tickers per message; more is refused explicitly |
| `MARKET_DATA_STALE_AFTER_MINUTES` | `30` | In-session age (plus provider delay) after which a quote is STALE |
| `PRICE_ANOMALY_MAX_CHANGE_PERCENT` | `50` | Move vs previous close above which a quote is `suspect` (warning, no alerts) |
| `PRICE_REFERENCE_TOLERANCE_PERCENT` | `5` | Allowed gap between the quote's previous close and the stored daily close |
| `FETCH_LOG_RETENTION_DAYS` / `AI_ANALYSIS_RETENTION_DAYS` / `ALERT_HISTORY_RETENTION_DAYS` | `7` / `30` / `30` | Rows strictly older are deleted; active alerts never |
| `RETENTION_INTERVAL_HOURS` | `6` | How often the retention job runs |
| `TELEGRAM_ENABLED` | `true` | `false` = Telegram transport off even with a token. Tests always run with it off |
| `QUOTE_CACHE_TTL_SECONDS` / `HISTORY_CACHE_TTL_SECONDS` | `60` / `900` | In-memory cache TTLs |
| `STOCK_API_MAX_CONCURRENCY` / `STOCK_API_MIN_INTERVAL_MS` | `3` / `150` | Provider concurrency and the minimum gap between call starts |
| `PORTFOLIO_MAX_HOLDINGS` / `PORTFOLIO_MAX_TRANSACTIONS_PER_DAY` | `50` / `100` | Portfolio bookkeeping limits per user. See `docs/portfolio.md` |
| `CHAT_REQUEST_DEADLINE_MS` | `240000` | After this, provider calls still queued/running for one chat request are cancelled |
| `MARKET_DATA_USER_UNCACHED_PER_MINUTE` | `30` | Uncached provider calls one user may cause per minute (retries count). Beyond it: stored data or a short message, never a provider call |
| `MARKET_DATA_USER_UNCACHED_PER_HOUR` | `300` | Uncached provider calls one user may cause per hour |
| `MARKET_DATA_GLOBAL_PER_HOUR` | `10000` | Provider calls per hour in TOTAL (users + background jobs); the pool users share is this minus the reserve below. When the user pool is spent the bot serves cache/stored data (degraded mode) |
| `MARKET_DATA_SYSTEM_RESERVE_PER_HOUR` | `2000` | Part of the total only system jobs (alert evaluation) may spend, so ordinary accounts cannot silence alerts (must be smaller than the total; 0 = one shared pool) |
| `MARKET_DATA_QUEUE_PER_USER` / `MARKET_DATA_QUEUE_GLOBAL` | `5` / `200` | Provider calls that may wait for a slot; more are refused at once |
| `MARKET_DATA_QUEUE_SYSTEM` | `100` | Extra waiting slots only system jobs may take; system jobs are served first |
| `MARKET_DATA_MAX_RESPONSE_BYTES` / `AI_MAX_RESPONSE_BYTES` / `EMBEDDING_MAX_RESPONSE_BYTES` | `4194304` / `1048576` / `8388608` | Largest HTTP response read from the market-data provider / model / embedding model; the read is cancelled as soon as it is exceeded |
| `REDIS_ALLOW_UNAUTHENTICATED` | `false` | A `REDIS_URL` on a non-loopback host without a password is refused at startup unless this is `true` |
| `MARKET_DATA_QUEUE_WAIT_MS` / `MARKET_DATA_TIMEOUT_MS` | `15000` / `20000` | Longest wait for a slot / longest run of one provider call |
| `MARKET_DATA_BREAKER_FAILURES` / `MARKET_DATA_BREAKER_COOLDOWN_SECONDS` | `5` / `30` | Circuit breaker for a failing provider |
| `TICKER_EXISTS_TTL_SECONDS` / `TICKER_MISSING_TTL_SECONDS` | `86400` / `120` | How long "ticker exists" / "no such ticker" is remembered |

## Telegram usage

```
BBCA                                  → quote
harga BBCA / BBCA sekarang            → quote
analisis BBCA                         → technical + AI analysis
kenapa BBCA naik hari ini?            → data-grounded explanation (causes/news are said to be unavailable)
BBCA bagus?                           → treated as a question/analysis, answered from current data
analisis BBCA dan BBRI                → each ticker analysed (max 5 per message)
harga BBCA kemarin · BBCA tanggal 1 Oktober 2026 · harga BBCA minggu lalu
                                      → that day's end-of-day candle (never today's price)
apakah BBCA layak dibeli? · target harga BBCA? · BBCA akan naik besok?
                                      → no buy/sell, target or prediction; neutral technical data instead
bandingkan BBCA BBRI BMRI             → comparison table (+ AI notes, no ranking)
berapa RSI BBCA? / kondisi teknikal BBCA / support BBCA
foreign flow BBCA / broker summary BBCA / PER BBCA / dividen BBRI
saham apa yang naik hari ini?         → screening (also: volume tinggi, RSI di bawah 30, harga di atas MA50, momentum positif)
saham dengan RSI di bawah 30 dan volume di atas 2x rata-rata → combined criteria
saham apa yang bagus?                 → no ranking; explains which criteria can be screened
tambahkan BBCA ke watchlist · hapus BBCA dari watchlist · lihat watchlist saya
ingatkan saya kalau BBCA di atas 8500 · kasih tahu kalau BBCA turun di bawah 7800
alert BBCA kalau RSI di atas 70 · beri tahu kalau volume BBCA lebih dari 2x rata-rata
lihat alert saya · hapus alert BBCA · hapus alert nomor 2 · hapus semua alert
jam berapa market buka? · ihsg
apa itu RSI? · apa itu MACD / SMA / Bollinger / ATR / support / volume
                                      → fixed educational text from the glossary (no AI involved)
harga BBCA tanggal 4 Oktober 2026     → weekend/holiday: says so and shows the nearest PRIOR session
```

**Dates.** Explicit (`1 Oktober 2026`, `2026-10-01`, `01/10/2026`) and relative (`kemarin`, `minggu lalu`, `Jumat lalu`)
dates are resolved in Asia/Jakarta. A weekend/holiday names the date and the session actually shown; a future date, an
invalid date (`31 Februari`), a time of day or a period (`bulan lalu`) gets an explicit message, never today's price.

**Groups.** In a group the bot answers commands and `@mentions`. Alerts are tied to the chat where they were created:
created in a group → delivered and listed **only in that group**; created in private → private only. `lihat alert saya` in
a group shows that group's alerts. The watchlist is private-only. Anonymous-admin / channel-identity messages
are ignored (the real user is unknown); a forwarded message is attributed to the person who forwarded it.

System commands: `/start`, `/help`. Optional compatibility commands (`/stock BBCA`, `/analyze BBCA`, `/technical BBCA`,
`/compare BBCA BBRI`, `/watchlist`) map to the same natural-language path but are never required.

## REST API

Minimal, localhost-bound, rate-limited (60 req/min/IP). There is **no authentication**, so it is hardened to stay local:

- `HOST` must be a loopback address, otherwise startup fails (unless `REST_ALLOW_REMOTE=true`, see above).
- Requests whose `Host` header is not loopback (DNS rebinding) or whose browser `Origin` is not loopback (a web page you visit
  firing requests at your machine) get `403` before any work or AI quota is spent. `curl`/scripts without an `Origin` are unaffected.
- Request bodies are limited to 10 kB (`413`), malformed JSON gives `400`, and `X-Powered-By` is not sent.
- `POST /analysis/:symbol` spends the same per-minute AI budget as a Telegram user, tracked per caller address (`429` beyond it).
- `/health` answers `503` when PostgreSQL is down, and reports `degraded` when the bot should be connected to Telegram (token set,
  `TELEGRAM_ENABLED=true`) but is not. Provider errors in `details` never include URLs or credentials.

| Endpoint | Purpose |
|---|---|
| `GET /metrics` | Prometheus text: chat requests and latency histograms per intent, provider calls/throttling, cache hit/miss, queue depth and job latency, AI calls and latency, RAG latency and hit quality, alert evaluation/delivery, Telegram errors, DB/Redis ping latency; local only, no user ids (`docs/observability.md`) |
| `GET /live` | liveness: process up, p99 event-loop delay, RSS; never touches a dependency |
| `GET /ready` | readiness: PostgreSQL answers, every migration on disk is applied, Redis/queues work when configured; 503 otherwise |
| `GET /health` | `{status, database, telegram, stockProvider, ai, redis, details, timestamp}` — `error` only if PostgreSQL is down; otherwise `ok`/`degraded` (`redis` is `disabled` when not configured, which is fine; `unavailable` degrades) |
| `GET /stocks/:symbol` | normalized quote |
| `GET /stocks/:symbol/technical` | indicators, classification, support/resistance |
| `GET /stocks/:symbol/history?range=1mo\|3mo\|6mo\|1y\|2y` | daily candles |
| `POST /analysis/:symbol` | technical + validated AI output |

## Alerts

Price, RSI, volume and MA20/MA50 crossover alerts (`ingatkan saya kalau BBCA golden cross`), one-shot, evaluated only on trusted data.
Lifecycle: `jeda alert 1` / `lanjutkan alert BBCA` (paused alerts keep their slot and identity), expiry after `ALERT_TTL_DAYS`,
delivery tracking (`deliveredAt`, `deliveryError`). Details: `docs/alerts.md`.

## Advanced AI (what the model may combine)

The model still only picks ids from an application-written catalogue; the catalogue also covers verified sources and
nothing else: fundamentals with provenance (never stale ones), news as source-grounded event counts (never headline text),
the asking user's own position and watchlist (private chat only), and a portfolio summary (`ringkas portofolio saya`).
Risks from every source are always shown. `jawab ringkas` / `jawab lengkap` sets the presentation. Details: `docs/advanced-ai.md`.

## Fundamentals

`fundamental BBCA` shows valuation, profitability, debt and growth figures, each with its provenance: reported by the provider, an analyst
estimate (`estimasi`), derived by Indonesian Stock Bot from reported inputs (`turunan`: P/E = price/EPS, P/BV, dividend yield, net margin, D/E, ROE), or
served from the last stored daily snapshot when the provider is down (dated; `basi` once older than `FUNDAMENTALS_STALE_DAYS`). What is
missing is listed, never invented. `bandingkan fundamental BBCA BBRI` puts them side by side. Details: `docs/fundamentals.md`.

## News

`berita BBCA` lists recent headlines as data: title, source, age and link, tagged with the corporate-action events the title literally
names (dividend, RUPS, right issue, suspension, …). Articles are stored once (provider id and normalised title) and the archive answers,
flagged, when the provider is down. A "why" question gets a separate "Berita terkait" block that is explicitly not a causal explanation.
The language model never sees news text, so it cannot invent or echo news; there is deliberately no sentiment. Details: `docs/news.md`.

## Knowledge base and personal notes

Conceptual questions (`apa itu ARA?`, `satu lot berapa lembar?`) are answered from an application-authored corpus plus the glossary through
hybrid retrieval (PostgreSQL full text + pgvector, reciprocal rank fusion) — never by the language model. In a private chat you can keep short
notes (`catat: BBCA cum date 20 Mei`, `catatan saya`, `cari catatan BBCA`, `hapus catatan 1`); they are the only user-written text Indonesian Stock Bot stores,
visible to you alone (authorization is applied before ranking), and erased by `hapus data saya`. Details: `docs/rag.md`.

## Memory, preferences and your data

Per chat, Indonesian Stock Bot remembers only the last tickers and the kind of request (max 10, `CONTEXT_TTL_MINUTES`), never message text; `apa yang tadi saya tanya?`
shows it and `lupakan konteks` erases it. One preference exists, the default ticker (`saham default saya BBCA`), used for a stock question without a ticker
when the chat has no context. `hapus data saya` + `konfirmasi hapus data saya` (within 5 minutes) deletes everything about you in one transaction.
All of this works in the private chat only. Details: `docs/context-memory.md`.

## Portfolio bookkeeping

In a **private chat** Indonesian Stock Bot keeps a ledger you type yourself: `beli 10 lot BBCA di 9000`, `jual 3 lot TLKM di 3100 fee 10rb`, `setor 10 juta`,
`dividen BBCA 150000`, then `portofolio saya` / `berapa untung saya?` / `riwayat transaksi` / `batalkan transaksi terakhir`. Average-cost accounting
in Decimal, an append-only ledger with exact reversals, idempotent by Telegram message id, valued only with trusted quotes (otherwise at cost and
flagged). Group chats refuse portfolio commands; the AI classifier can never record or undo. No broker connection and no trading: it is a notebook.
Details and limits: `docs/portfolio.md`.

## Technical analysis rules

All values are computed in TypeScript (`src/analysis`); the AI never calculates anything.

- **Trend** — votes of price>SMA20, price>SMA50, SMA20>SMA50, SMA50>SMA200 (if ≥200 candles), MACD histogram sign.
  `score = (bullish − bearish) / available`; `≥ +0.5` BULLISH, `≤ −0.5` BEARISH, else NEUTRAL.
- **Momentum** — strength from `|RSI−50|` (≥15 STRONG, ≥7 MODERATE, else WEAK); bias POSITIVE/NEGATIVE only when RSI side and MACD histogram agree.
- **RSI zone** — ≥70 overbought, ≤30 oversold. **Volume ratio** — last bar ÷ average of the previous 20 bars (partial intraday volume lowers it early in the session).
- **Support/resistance** — swing pivots (±3 bars, last 180 days) clustered within 1.5 %; strength = number of touches (1 weak, 2 medium, ≥3 strong); rounded to whole rupiah.

Wording is intentionally cautious (“Kondisi teknikal: Bullish”), never “pasti naik”.

## Testing

```powershell
npm run lint
npm run build
npm test                    # unit tests (pure logic, no services needed)
npm run test:integration    # real PostgreSQL (separate DB ai_stock_test) + fake provider/AI
npm run test:e2e            # HTTP e2e via supertest
npm run test:live           # optional: live Yahoo contract check (internet)
```

**Tests are hermetic.** Jest never starts Telegram polling, never uses a real token and never calls Telegram or Yahoo:
the unit config loads `test/setup/env.ts` (token emptied, `TELEGRAM_ENABLED=false`), `TelegramService` refuses to start
in a test runtime (`TELEGRAM_DISABLED_IN_TEST`, logged as a warning), and regression tests assert it. If you write a script
that imports the app modules outside Jest, set `TELEGRAM_BOT_TOKEN=` and `TELEGRAM_ENABLED=false` first.

**Existing databases.** After pulling this version run `npx prisma migrate deploy`. The `activeKey` migration (`20261004120000_alert_active_key_and_context_scope`):
adds the unique `Alert.activeKey` (set only while an alert is ACTIVE; any pre-existing duplicate ACTIVE alerts are disabled, keeping the
oldest), scopes the conversation context per chat (`ConversationContext(userId, chatId)`, existing rows are assigned to the owner's
private chat) and adds an index on `AIAnalysis.createdAt`. Alert creation, and putting a claimed alert back after a failed delivery,
are serialised per user with a PostgreSQL advisory lock, so the "max 20 alerts" and "no duplicate alert" rules hold under concurrent
requests. The follow-up migrations `20261004140000_alert_active_key_canonical` and `20261004160000_alert_threshold_quantize` re-key ACTIVE alerts with a canonical threshold text (at most
6 decimals, no exponent) so the database and the application build identical keys; thresholds are stored with at most 6 decimals and
must be positive and at most 1 000 000 000; the threshold-quantising migration quantises older thresholds the same way and disables ACTIVE alerts whose threshold is no longer usable (zero at 6 decimals, or above 1 000 000 000). Nothing is deleted. It needs PostgreSQL 13+ (`trim_scale`); the project pins 16. Data migrations are covered by
`test/integration/migrations.spec.ts`, which seeds duplicates into a throw-away database and applies each migration.

Load test (not part of the gate): `npm run test:load` (`docs/load-tests.md`). Operations runbook: `docs/operations.md` (`npm run db:backup`,
`npm run db:restore-rehearsal -- backups/<dump>.sql.gpg`). Backups are GnuPG-encrypted (passphrase prompt); `npm run db:encrypt-existing` encrypts the older plaintext dumps without deleting them.

Integration/e2e tests need `docker compose up -d`; they create and migrate **`ai_stock_test`** automatically. They refuse to run
(and to `TRUNCATE`) unless the database host is local **and** the name is a test name (`test` as a whole word between `_`, e.g.
`ai_stock_test`; `latest_prod` or `contest` are refused). Set `TEST_DATABASE_URL` to use a private test database. Test data is synthetic and clearly labelled (`src/testing/fixtures.ts`);
no fake data is ever shown as market data.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Bind for 0.0.0.0:5432 failed` | Another PostgreSQL uses the port. This project already uses **5436**; change `POSTGRES_PORT`/`DATABASE_URL` if needed. |
| `/health` → `database: unavailable` | `docker compose up -d`, check `DATABASE_URL`, run `npm run prisma:migrate`. |
| Telegram `401 Unauthorized` / `telegram: error` | Wrong/revoked token. Re-copy from @BotFather. |
| Telegram `409 Conflict` | Another process (or old instance) is polling the same token. |
| `ai: unavailable` | Start Ollama, `ollama pull <model>`, set `OLLAMA_MODEL` to that exact name. |
| Bot answers “hanya dapat digunakan oleh pengguna yang diizinkan” | Your Telegram ID is not in `TELEGRAM_ALLOWED_USER_IDS` (or the list is empty: fail closed). Add the ID and restart. |
| App stops at startup with `TELEGRAM_ALLOWED_USER_IDS … invalid entry` | Use positive integers separated by commas, e.g. `123456789,987654321`. |
| “Analisis AI sedang membutuhkan waktu terlalu lama” | The model exceeded `AI_TIMEOUT_MS`. The technical data is still shown. Retry, use a smaller model/GPU, or raise the timeout. |
| “AI sedang sibuk melayani permintaan lain” | The bounded queue is full (`AI_MAX_QUEUE_DEPTH`). Retry shortly. |
| “Hasil model AI tidak dapat diproses (format tidak valid)” | The model answered twice without a usable list of ids (prose, unknown ids or broken JSON); nothing it wrote is shown, on purpose. The deterministic report is the answer. |
| “Analisis AI tidak dapat ditampilkan…validasi keamanan” | Defence in depth: an application-written catalogue sentence failed the output policy (a bug to report). The deterministic report is the answer. |
| `🔴 STALE` on a quote | Provider data is older than the last session / limit, or a stored copy is shown because Yahoo failed. See [Data freshness](#data-freshness-and-plausibility). |
| “Harga terlihat tidak wajar” | The quote failed the sanity check; do not rely on that price. Alerts on it are skipped. |
| `container name "/ai-stock-postgres" is already in use` after renaming the folder | Fixed by the pinned compose project name; pull the current `docker-compose.yml` and run `docker compose up -d`. If you still have an old container from another stack: `docker rm -f ai-stock-postgres` **only if you know it is this project's** (data stays in the volume). |
| `analisis` takes > 1 min | CPU-only inference. Use a smaller model, a GPU, or a cloud provider. |
| “Data saham sedang tidak dapat diambil” | Yahoo throttled/unreachable and nothing stored yet. Retry later; cached/stored data is used automatically afterwards. |
| `No set-cookie header present` in logs | Yahoo crumb handshake hiccup (regional/consent). Retries/fallback handle it; if persistent, try later or from another network. |
| Prices look old | Check the `🕐 Data:` line: IDX is delayed ~10 min and frozen outside trading hours. |
| Alerts never fire at night | By design they are checked only while the IDX is open (`ALERT_CHECK_WHEN_CLOSED=true` to override). Add `MARKET_HOLIDAYS`. |

## Known limitations

- Yahoo Finance is unofficial and ~10 min delayed; no foreign-flow / broker data. News is headlines only (dated, sourced, tagged with corporate-action events, archived when the provider is down): there is no sentiment analysis and a headline is never offered as the cause of a price move. The bot says so when a source is unavailable.
- Screening covers the configured universe, not every IDX ticker.
- AI analysis and comparison notes are selections of application-written sentences (no model prose), so they read like a short fact sheet; the model only chooses which facts matter. Always read the deterministic section too.
- Market holidays are configuration (`MARKET_HOLIDAYS`), not auto-detected; while the list is empty a holiday is treated as a trading day. Trading hours follow the regular IDX schedule and may change.
- Gemini/OpenAI providers are covered by mocked tests only. The Telegram transport is tested with a stubbed Bot API, not with a live session.
- Redis is optional. Without `REDIS_URL` everything runs in one process (caches, AI queue and per-user limits reset on restart). With Redis, quotas and the BullMQ queues (`alerts`, `maintenance`, `notifications`) are shared and `BOT_ROLE` can split the gateway from the workers, but some state stays per process on purpose: the Telegram sender gate and group message budgets (they belong to the one polling connection), the AI fairness gate (it protects one local model) and the in-memory caches. Only one process may poll Telegram. Multi-process operation has not been measured with two real processes.
- One data provider (Yahoo, unofficial). If it is down the app serves stored data marked STALE; there is no second source to cross-check prices.
- The output policy (`ai/policy`) is rule-based and cannot be proven complete, but it only guards application-written text, not model prose; the model cannot add words of its own.
- The access mode and allowlist are read at startup (restart to change them). The per-user limits trust the Telegram user ID.
- In `public` mode there is no cap on the number of users, and fairness is per Telegram user ID. Provider calls are bounded: each user may cause 30 uncached calls a minute and 300 an hour, all users share one hourly pool, and a separate reserve is kept for alert evaluation. About 27 accounts at their hourly cap can still exhaust the users' pool (other users then get stored data marked STALE or an honest "data is limited" message, but alerts keep being evaluated), and many accounts can still keep the single local model busy (other users then get data without AI).
- Alerts are stored in PostgreSQL and survive restarts. The AI gate, the sender gate and the not-found ticker cache are in-process and reset on restart; per-user message and provider quotas are in-process too unless Redis is configured. If Redis itself restarts without persistence its quota windows are forgotten; a process-local floor keeps one process within the documented limits, but several processes may briefly spend more.
- A real price move larger than `PRICE_ANOMALY_MAX_CHANGE_PERCENT`, a split or another corporate action makes the quote `suspect` and suppresses alerts until data normalises (deliberate trade-off).
- The conceptual glossary covers the listed indicators only; other topics get a “topik yang bisa saya jelaskan” list.
- Time references in questions are interpreted in Asia/Jakarta. Intraday history (`jam 10:00`) is not supported and says so; relative
  periods such as `kemarin`, `minggu lalu`, `bulan lalu` are resolved to a concrete date shown in the answer label (so "Minggu lalu"
  can be read either way, check the date). A date without a year (`31 desember`) means its most recent *past* occurrence; `tanggal 1`
  without a month, a lone year (`BBCA 2025`), a month alone (`harga BBCA mei`), vague past wording (`waktu itu`, `sebelum pandemi`,
  `pas lebaran`) and impossible dates (`9999 tahun lalu`) are answered with a clarification, never with today's price (a bare `dulu`
  is not treated as a period: `cek BBCA dulu` means "first"). A date within the next 7 days is the future, not last year; 29 February
  means the last real leap day. Months must be written in full or as an exact abbreviation (`5 marketing` is not 5 March). A number after words such
  as `tembus`, `di atas`, `target` is a price, not a year.
- Groups: the bot only answers messages that mention it by exact username. Messages are processed in order *per sender in a chat*,
  so one member's slow AI request does not delay other members; AI capacity stays fair per user (1 running + 1 waiting each). At most
  3 updates per sender are in flight at once: a flood from one account is dropped (a private chat gets one "masih diproses" notice per
  15 s, a group stays silent), because an update waiting behind a slow request would otherwise hold one of the runner's 500 slots. When
  more than 300 updates are in flight overall, a sender who already has one queued is not queued further. Each group chat may receive
  about 15 bot messages a minute before cosmetic ones (progress, "terlalu banyak pesan") are dropped; one member alone may use at most
  half of that (further answers to that member are dropped with one notice a minute, other members are unaffected), and a real answer
  that hits a Telegram `429` waits for the requested time (up to 65 s) and is sent once more instead of being lost. The owner of a group alert is shown only as a well-formed `@username`, otherwise "anggota grup".
- The AI intent classifier is read-only: a vague message that the model reads as adding/removing a watchlist item or creating/deleting
  an alert is refused with a hint to write the command explicitly; only the deterministic rules change a user's data.
- A ticker is remembered as "not found" (2 minutes) only after two consecutive misses and never when it is on the built-in IDX list or
  was served before, so one provider hiccup cannot hide a real ticker.
- Log lines contain the numeric Telegram ID of the sender (needed to correlate a problem report) but no message text, username or name;
  logs and `/health` are scrubbed of tokens, passwords and keys. The default Docker database password is `postgres` and the port is
  bound to 127.0.0.1 only: change `POSTGRES_PASSWORD` (and `DATABASE_URL`) before exposing the database on any other interface.
- Output/quote guards have deliberate limits: leet-style spellings such as `be!i` are not normalised by the policy, and a consistent +49 %
  jump passes by design (`PRICE_ANOMALY_MAX_CHANGE_PERCENT` is configurable).
- Dependencies: `npm audit` reports no critical advisory. Three high ones remain (`deepmerge-ts` → `@prisma/config` → `prisma`) in the Prisma CLI, which only runs migrations and is not part of the running bot; the only offered fix is a major downgrade/upgrade of Prisma (`npm audit fix --force`), which was not applied. The moderate advisories are in development tooling. Run `npm audit` for the current state.
- `npm run start:prod` does not set `NODE_ENV` for you (the pretty log transport is only used if
  `pino-pretty`, a dev dependency, is installed).
- Alert delivery is **at-most-once**: an alert is claimed (`TRIGGERED`) before the message is sent so it can never be sent twice; if the process crashes between those two steps that one notification is lost. Failed sends (Telegram down) are put back and retried.
- The REST API has **no authentication** (it binds to `127.0.0.1` by default). Do not set `HOST` to a public address without adding authentication: `POST /analysis/:symbol` triggers LLM work and `/health` names the provider/model.
- Historical answers come from Yahoo daily candles (adjusted-price handling follows the provider) and cover roughly the last 2 years.

## Future deployment

The app is a modular monolith with a `Dockerfile` and `app` / `migrate` services in `docker-compose.yml` for a single VPS
(`docker compose --profile app up -d --build`, see `docs/operations.md`, "Deploy ke VPS"; tested in a Linux container, not yet on a real server). For more
than that, point `DATABASE_URL` at a managed
PostgreSQL, keep long polling (or add a webhook module), and move caches/rate-limits to Redis and the alert checker to BullMQ
for multi-instance setups. Extension points already exist for new data providers, AI providers, portfolio tracking, news/sentiment
and a web dashboard.

> **Disclaimer:** Informasi ini bersifat edukasi dan analisis berbasis data, bukan rekomendasi investasi.

## License

Released under the [MIT License](LICENSE).
