# Observabilitas

## Endpoint

| Endpoint | Fungsi | Kode |
|---|---|---|
| `GET /live` | proses hidup: uptime, p99 jeda event loop (ms), RSS — tidak menyentuh dependensi | selalu 200 |
| `GET /ready` | siap menerima lalu lintas: PostgreSQL menjawab, **semua folder migrasi di disk sudah diterapkan** (`pendingMigrations` menyebut yang belum), Redis dan antrean bekerja bila dikonfigurasi (`disabled` bila `REDIS_URL` kosong — itu desain, bukan kegagalan) | 200 / 503; di-cache 5 s |
| `GET /health` | ringkasan dependensi untuk manusia/monitor: DB, Telegram, penyedia data, AI, Redis, antrean | 503 hanya bila PostgreSQL mati; di-cache 15 s |
| `GET /metrics` | format teks Prometheus | 200 |

Semua endpoint ini hanya untuk jaringan lokal/operator; tidak ada yang memuat rahasia, URL koneksi, atau id pengguna.

## Metrik

Registry dalam proses (`src/common/metrics.service.ts`): counter, gauge, dan histogram dengan bucket tetap (5 ms … 120 s). Label hanya dari himpunan kecil yang tetap (nama intent, hasil, alasan, nama penyedia/antrean) — **tidak pernah** id pengguna, id chat, atau teks pesan.

| Metrik | Jenis | Label | Arti |
|---|---|---|---|
| `chat_requests_total` | counter | `intent`, `status` (ok/error/rate_limited/input_too_long/…) | setiap pesan yang diproses |
| `chat_latency_ms` | histogram | `intent` | latensi ujung ke ujung per pesan |
| `provider_requests_total` / `provider_throttled_total` / `provider_queue_depth` / `provider_active` | counter/gauge | `provider`, `outcome`, `reason` | panggilan penyedia data, penolakan kuota/breaker, antrean adil |
| `market_data_cache_total` | counter | `kind` (quote/history/fund/news/…), `result` (hit/miss/negative) | cache |
| `market_data_existence_gate_total` | counter | | ticker tak dikenal ditolak sebelum penyedia |
| `queue_waiting` / `queue_active` / `queue_failed` | gauge | `queue` | kedalaman antrean BullMQ |
| `queue_jobs_total` / `queue_job_ms` | counter/histogram | `queue`, `outcome` | sukses/gagal job dan latensinya |
| `ai_calls_total` / `ai_latency_ms` | counter/histogram | `outcome` (ok/timeout/error) | panggilan model (token tidak tersedia dari Ollama → tidak dilaporkan) |
| `rag_search_total` / `rag_search_ms` / `rag_results_total` | counter/histogram/counter | `scope`, `quality` (both/lexical/vector/none) | retrieval dan kualitas hit (kanal mana yang sepakat pada hasil teratas) |
| `rag_embedding_failures_total` | counter | `stage` | penyedia embedding gagal |
| `alert_evaluations_total` | counter | `outcome` (checked/triggered/skippedStale/skippedAnomaly/errors/…) | hasil tiap putaran pengecekan |
| `alert_deliveries_total` | counter | `outcome` (sent/permanent/transient) | pengiriman alert |
| `telegram_errors_total` | counter | `kind` (send/flood/notify/polling/start) | kegagalan Telegram |
| `db_ping_ms` / `redis_ping_ms` | gauge | | latensi ping terakhir (dari `/health`) |
| `redis_connected` / `redis_errors_total` / `redis_fallback_total` | gauge/counter | | status Redis dan jatuh ke mode dalam proses |
| `fundamentals_reports_total` / `news_reports_total` | counter | `origin` | asal data (provider/snapshot/arsip/none) |

## Log terstruktur

Satu baris JSON per pesan (`evt: "chat"`) dengan `reqId` acak 8 karakter untuk korelasi, `telegramId` (dibutuhkan operator untuk menangani laporan penyalahgunaan; tidak pernah masuk metrik), intent, sumber intent, waktu per tahap (`intentMs`, `latencyMs`), penyedia, kesegaran data, hasil AI, dan penanda fitur (`defaultSymbol`, `rag`, `news`, `fundamentals`). Kesalahan ditulis setelah `safeErrorMessage` (tanpa rahasia, tanpa URL koneksi). `LOG_LEVEL` mengatur verbositas; `silent` di tes.

## Yang sengaja tidak ada

- Tracing terdistribusi (OpenTelemetry): proses tunggal/berperan; `reqId` + log terstruktur cukup; dapat ditambah tanpa mengubah kode bisnis karena metrik sudah lewat satu seam.
- Dasbor: metrik Prometheus siap di-scrape; dasbor Grafana adalah urusan deployment.
- Penggunaan token AI: Ollama tidak melaporkannya secara andal; tidak dipalsukan.

## Pengujian

`src/common/metrics.service.spec.ts` (bucket kumulatif, sum/count, format exposisi, sanitasi label, `time()`), `test/e2e/probes.spec.ts` (`/live`, `/ready` 200 + `migrations: ok` tanpa URL koneksi, `/metrics` memuat histogram chat tanpa id pengguna).
