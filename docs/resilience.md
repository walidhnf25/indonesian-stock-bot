# Ketahanan

## Mekanisme (sudah ada sejak awal; dirangkum di sini dengan lokasi dan ujinya)

| Mekanisme | Di mana | Uji |
|---|---|---|
| Retry + backoff eksponensial (hanya kesalahan transien) | `StockService.guarded` → `withRetry` | `stock-service.spec` "retries transient provider errors with backoff" |
| Circuit breaker penyedia | `CircuitBreaker` di `MarketDataGovernor` | `provider-governance.spec`, mutasi M3 |
| Timeout | penyedia `MARKET_DATA_TIMEOUT_MS`; AI `AI_TIMEOUT_MS` + backstop; embedding `EMBEDDING_TIMEOUT_MS`; Redis `REDIS_CONNECT_TIMEOUT_MS`; job BullMQ per antrean | `resilience.spec` (penyedia lambat, model macet), `queues.spec` |
| Pembatalan | `CHAT_REQUEST_DEADLINE_MS` → `AbortSignal` lewat `CallerContext`; panggilan penyedia yang masih antre dibatalkan | `provider-governance.spec` |
| Backpressure | `SenderGate` Telegram, antrean AI terbatas per pengguna/global, antrean penyedia adil dan terbatas | `security.spec`, `ai-input-and-fairness.spec`, `load` |
| Dead-letter | BullMQ: job gagal setelah retry tetap tersimpan (`failed`), terlihat di `/health` dan `queue_failed` | `queues.spec` |
| Idempotensi | portofolio (`idempotencyKey`), notifikasi (`jobId` dedup), alert (klaim atomik ACTIVE→TRIGGERED), ingest korpus (hash), berita (id + hash judul) | suite masing-masing |
| Graceful shutdown | `BackgroundTasks.flush`, `QueueService.onModuleDestroy`, Redis quit | `resilience.spec` "graceful shutdown", `queues.spec` |
| Graceful startup | ingest korpus di latar belakang; Redis fail-fast → fallback dalam proses; `/ready` baru 200 setelah migrasi diterapkan | `redis.spec`, `probes.spec` |
| Degraded mode | tanpa Ollama: observasi deterministik; tanpa penyedia: data tersimpan terakhir berlabel; tanpa Redis: kuota/antrean dalam proses; tanpa pgvector/korpus: glosarium | `resilience.spec` "degraded mode", `ai-safety.spec`, `redis.spec` |
| Failover | tidak ada penyedia kedua yang terkonfigurasi (abstraksi siap: `StockDataProvider`, `NewsProvider`, `EmbeddingProvider`); failover = data tersimpan terakhir | `stock-service.spec` |

## Injeksi kegagalan (`test/integration/resilience.spec.ts`)

| Kegagalan | Perilaku yang diuji |
|---|---|
| PostgreSQL (query ditolak) | pesan "layanan penyimpanan" tanpa detail internal; permintaan berikutnya normal tanpa restart |
| Model macet | dipotong `AI_TIMEOUT_MS`; jawaban deterministik + pemberitahuan; permintaan berikutnya normal |
| Penyedia data lambat | dipotong `MARKET_DATA_TIMEOUT_MS` (bukan oleh pengguna); jawaban jujur; setelah pulih normal |
| Semua opsional mati (model + penyedia + berita) | glosarium/korpus/portofolio tetap; harga = data tersimpan berlabel; analisis deterministik; berita "belum tersedia"; `/health` `degraded`, bukan `error` |
| Tulis latar belakang gagal (konteks) | tidak pernah sampai ke pengguna; permintaan berikutnya normal |
| Shutdown dengan pekerjaan latar belakang | `close()` menunggu tanpa error; snapshot tetap tersimpan |

Kegagalan Redis, antrean, pengiriman Telegram (429 panjang, 403 permanen), dan Yahoo (retry/stale) diuji di suite yang disebut pada tabel pertama.

## Yang sengaja tidak dibuat

- Chaos pada level infrastruktur (mematikan kontainer selama tes): tes memakai injeksi pada seam aplikasi agar deterministik; prosedur manual ada di `docs/operations.md`.
- Failover ke penyedia kedua: tidak ada penyedia kedua yang tersedia gratis dan andal; abstraksinya siap.
