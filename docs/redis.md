# Redis

Redis adalah **status sementara bersama**, bukan sumber kebenaran. PostgreSQL tetap memegang semua data bisnis (pengguna, watchlist, alert,
portofolio, konteks, dokumen). Redis menyimpan hal yang boleh hilang: kuota, kunci, antrean, cache.

## Prinsip

- **Opsional.** `REDIS_URL` kosong → semua implementasi berjalan di dalam proses (sama seperti sebelum Redis ditambahkan). Tidak ada fitur yang hilang; batasnya berlaku per proses.
- **Gagal cepat, bukan menggantung.** Klien ioredis dibuat dengan `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, batas waktu koneksi `REDIS_CONNECT_TIMEOUT_MS`. Redis yang mati tidak boleh membuat permintaan chat menunggu.
- **Fallback terhitung.** Bila Redis dikonfigurasi tetapi tidak tersambung, kuota dihitung di dalam proses dan setiap fallback dicatat di `redis_fallback_total{what}`; `/health` melaporkan `redis: unavailable` dan status `degraded`. Kontrol keamanan tidak pernah dimatikan diam-diam.
- **Setiap kunci kuota/cache berawalan `REDIS_KEY_PREFIX`** (bawaan `stockbot:`) dan **punya TTL**. Kunci antrean BullMQ **tidak** ber-TTL, sehingga compose memakai `noeviction` (bukan `allkeys-lru`: itu bisa membuang status antrean). Bila memori penuh, penulisan gagal terang-terangan dan Indonesian Stock Bot beralih ke kuota dalam proses / pengiriman langsung.
- **Keamanan:** hanya `127.0.0.1` yang dipublikasikan; `REDIS_PASSWORD` (compose) mewajibkan sandi, dan `REDIS_URL` non-loopback tanpa sandi ditolak saat start kecuali `REDIS_ALLOW_UNAUTHENTICATED=true`.
- Nilai disimpan sebagai string/angka sederhana; tidak ada objek bisnis yang diserialisasi ke Redis.

## Yang dipakai sekarang

| Pemakai | Kunci | TTL | Catatan |
|---|---|---|---|
| Kuota panggilan penyedia per pengguna (`MarketDataGovernor`) | `stockbot:quota:user:<caller>` | jendela 60 dtk | sorted set; satu anggota per unit |
| Anggaran global per penyedia | `stockbot:quota:global:<provider>` | 1 jam | |
| Batas pesan chat per pengguna (`ChatService`) | `stockbot:quota:chat:<telegramId>` | 60 dtk | menggantikan `SlidingWindowLimiter` lokal |
| Kuota AI per pengguna (`AiQuotaService`) | `stockbot:quota:ai:analysis:<user>`, `stockbot:quota:ai:intent:<user>` | 60 dtk | |

Semua lewat satu antarmuka `QuotaStore` (`src/stock/governance/quota-store.ts`) yang diimplementasikan oleh `RedisQuotaStore` (skrip Lua atomik: buang anggota kedaluwarsa → hitung → tolak atau tambah → `PEXPIRE`) dengan `InMemoryQuotaStore` sebagai cadangan.

Yang **masih** per proses (disengaja, akan dipindah bila perlu): `SenderGate` dan anggaran pesan grup Telegram (terkait satu koneksi polling), gerbang adil AI (`FairGate`, terikat model lokal satu proses), penjadwal penyedia (`ProviderScheduler`; konkurensi ke Yahoo per proses, anggaran globalnya sudah bersama).

## Konfigurasi

| Variabel | Bawaan | Arti |
|---|---|---|
| `REDIS_URL` | kosong | `redis://127.0.0.1:6380/0` untuk compose lokal; `rediss://` didukung |
| `REDIS_CONNECT_TIMEOUT_MS` | 2000 | batas waktu koneksi |
| `REDIS_KEY_PREFIX` | `stockbot:` | awalan semua kunci |

Compose: layanan `redis` (`redis:7-alpine`, kontainer `ai-stock-redis`, port **127.0.0.1:6380** agar tidak bentrok dengan Redis proyek lain di 6379, `maxmemory 256mb noeviction`, tanpa persistensi, sandi opsional lewat `REDIS_PASSWORD`). Jalankan `docker compose up -d` (keduanya) atau `docker compose up -d redis`.

## Pengujian

`test/integration/redis.spec.ts` memakai database Redis **1** dengan awalan `stockbottest:` dan dilewati (dengan peringatan terlihat) bila Redis tidak terjangkau di `TEST_REDIS_URL` (bawaan `redis://127.0.0.1:6380/1`). Yang diuji: koneksi/ping/shutdown, atomisitas (100 konsumsi paralel, batas 10 → tepat 10), berbagi antar dua "proses", jendela geser, dua governor berbagi kuota pengguna, fallback saat Redis mati (masih ditegakkan per proses, terhitung), dan mode tanpa Redis. Suite integrasi lain tetap berjalan tanpa `REDIS_URL` (mode dalam proses).

## Operasional

- `/health` → `redis: disabled | connected | unavailable`; `/metrics` → `redis_connected`, `redis_errors_total`, `redis_fallback_total{what}`.
- Mematikan Redis saat bot berjalan: kuota beralih ke proses, log peringatan satu baris, tidak ada permintaan yang gagal. Menyalakan kembali: klien tersambung ulang otomatis (backoff sampai 30 dtk).
