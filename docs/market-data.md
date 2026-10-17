# Data pasar dan tata kelola panggilan penyedia

Dokumen ini menjelaskan **apa yang benar-benar ada di kode** (Milestone 1). Hal yang masih direncanakan ditandai jelas.

## 1. Masalah yang diselesaikan

Sebuah review independen menunjukkan bahwa satu akun publik, tanpa melewati batas per-pengguna mana pun, bisa memicu sekitar **400 request
Yahoo per menit** dari IP pemilik: `analisis` lima ticker nyata di luar daftar bawaan (kutipan + riwayat + fundamental) dua puluh kali per menit.
Semua panggilan melewati satu antrean FIFO yang tidak dibatasi, sehingga data baru milik pengguna lain menunggu di belakang penyerang (3 detik dengan 20
akun, 18 detik dengan 120 akun, 29 detik dengan 400 pasangan chat/pengirim), dan blokir IP oleh Yahoo akan mematikan data untuk semua orang.

## 2. Rancangan

```text
StockService (cache → ...) ── hanya jika cache MISS ──▶ MarketDataGovernor.execute(provider, call)
                                                           │
   1. circuit breaker      OPEN?              → BUSY  (tidak ada panggilan, tidak ada kuota terpakai)
   2. PENGGUNA:  kuota per menit  MARKET_DATA_USER_UNCACHED_PER_MINUTE → QUOTA (+ retryAfterSeconds)
                 kuota per jam    MARKET_DATA_USER_UNCACHED_PER_HOUR   → QUOTA
                 kolam pengguna   MARKET_DATA_GLOBAL_PER_HOUR − cadangan sistem → BUSY (mode terdegradasi)
      SISTEM (system:alerts):  cadangan sistem  MARKET_DATA_SYSTEM_RESERVE_PER_HOUR → BUSY
   3. penjadwal adil terbatas (system dilayani LEBIH DAHULU; di dalam tiap kelas round-robin per pemanggil;
      antrean per pemanggil, antrean global pengguna, antrean cadangan sistem; batas tunggu, timeout
      eksekusi, concurrency, jeda minimum antar mulai)
   4. penyedia (Yahoo)  → breaker diperiksa LAGI saat tugas benar-benar mulai, hasil dicatat ke breaker
      dan metrik SEBELUM slot dilepas
```

### 2a. Model kapasitas

Sebelumnya anggaran jam adalah **satu ember** untuk semua pengguna **dan** pemeriksa alert. Audit 2026-10-07 menunjukkan bahwa 6 akun biasa, masing-masing
dalam kuota 30/menit, menghasilkan 180 panggilan/menit = 10.800/jam (> 10.000) dan bisa mengosongkan ember itu terus-menerus: pemeriksa alert tidak
mendapat data dan alert tertunda untuk semua orang. Sekarang:

| Besaran | Nilai bawaan | Dasar |
|---|---|---|
| Plafon total penyedia (`MARKET_DATA_GLOBAL_PER_HOUR`) | 10.000/jam | tidak diubah; kolam pengguna + cadangan sistem **selalu** berjumlah plafon ini, jadi sistem tidak bisa melewati batas keselamatan penyedia |
| Cadangan sistem (`MARKET_DATA_SYSTEM_RESERVE_PER_HOUR`) | 2.000/jam (20%) | satu siklus alert = 1 kutipan batch + 1 riwayat per simbol alert (riwayat di-cache 15 menit, jadi ≤ 4/jam/simbol); kebutuhan = 30 siklus/jam (interval 120 d) + 4 × simbol; 2.000 cukup untuk ±490 simbol berbeda |
| Kolam pengguna | 8.000/jam | plafon − cadangan; pengguna tidak pernah bisa menyentuh cadangan |
| Kuota pengguna | 30/menit dan **300/jam** | 300/jam jauh di atas pemakaian wajar (cache hit tidak dihitung) dan menaikkan jumlah akun yang dibutuhkan untuk menguras kolam dari 6 menjadi 27+ |
| Kapasitas penjadwal | ≤ 400 panggilan/menit (3 pekerja, jeda mulai global 150 ms; diukur 390/menit) | 24.000/jam, lebih besar dari plafon: yang membatasi total adalah anggaran, bukan penjadwal |
| Antrean | 5/pengguna, 200 pengguna total, **+100 slot khusus sistem** | pengguna tidak dapat mengisi slot sistem; sistem dilayani sebelum pengguna mana pun |

Perilaku:

- **Kolam pengguna habis:** pengguna biasa mendapat data tersimpan yang ditandai *stale* bila ada, atau pesan jujur ("layanan data dibatasi … belum ada data
  tersimpan"). Evaluasi alert **tetap berjalan** dari cadangan sistem dan tetap menolak data basi/tidak tepercaya.
- **Cadangan sistem habis:** evaluasi alert mendapat `BUSY`; alert **tidak dikonsumsi** (tetap ACTIVE) dan dievaluasi lagi saat jendela membebaskan unit.
  Sistem **tidak** meminjam dari kolam pengguna. Terlihat di `provider_budget_remaining{pool="system"}` = 0 dan
  `provider_throttled_total{reason="system_reserve"}`, plus satu log `provider_budget_exhausted` per menit.
- **Cadangan = 0:** satu kolam bersama (perilaku lama), untuk instalasi yang memang menginginkannya.
- **Redis tersedia:** semua kuota/anggaran memakai skrip Lua atomik (tidak bisa dilampaui oleh panggilan paralel). **Redis restart tanpa persistensi**
  mengosongkan jendela; karena itu governor juga menyimpan **lantai lokal** (cermin setiap hibah di memori proses) dan menolak bila lantai itu penuh, sehingga
  satu proses tidak dapat membelanjakan anggaran jam dua kali. Dengan beberapa proses setelah restart Redis, batas efektif sementara bisa mencapai jumlah proses ×
  batas sampai jendela berlalu (dicatat sebagai batas yang diketahui).
- **Redis mati:** fallback dalam proses (kuota per proses, terhitung di metrik fallback), kebijakan tetap berlaku per proses.
- **Breaker OPEN:** menolak pengguna **dan** sistem tanpa memakai unit anggaran apa pun. Setelah masa tunggu tepat satu probe lolos (tugas yang sudah antre
  sebelum breaker terbuka memeriksa ulang breaker saat mulai, sehingga tidak ada yang menyelinap); probe yang dibatalkan melepaskan haknya.

Erratum: laju maksimum penjadwal adalah ~400 panggilan/menit (bukan 1.181 seperti tertulis di audit; angka itu menghitung backlog yang dikuras setelah jendela uji).

- **Identitas pemanggil** dibawa lewat `AsyncLocalStorage` (`src/common/caller-context.ts`): `tg:<telegramId>` (diset di `ChatService.handle`),
  `rest:<ip>` (middleware di `configureHttp`), `system:alerts` (evaluasi alert, bebas dari kuota per pengguna tetapi tetap memakai anggaran global dan
  antrean yang sama). Kode tanpa konteks dihitung sebagai `anonymous` (**tidak** dibebaskan) dan dicatat di `provider_unattributed_total`.
- **Cache hit tidak pernah sampai ke governor**, jadi tidak memakai kuota. **Setiap percobaan ulang** kembali lewat governor dan memakai kuota lagi, sehingga
  retry tidak bisa melewati batas.
- **Penolakan (QUOTA/BUSY) tidak pernah mencapai penyedia dan tidak ditulis ke `DataFetchLog`**, supaya banjir penolakan tidak menjadi banjir baris database.
- **Mode terdegradasi:** bila kuota/anggaran/breaker menolak, `StockService` menyajikan data tersimpan (ditandai *stale*) bila ada; bila tidak ada, pengguna
  mendapat pesan singkat yang jujur (`QUOTA`: "terlalu banyak data baru… coba lagi dalam N detik"; `BUSY`: layanan data dibatasi).
- **Registri ticker** (`TickerRegistry`): `listed` (90 kode bawaan), `verified` (penyedia pernah memberi kutipan nyata, TTL `TICKER_EXISTS_TTL_SECONDS`),
  `missing` (dua kali "tidak ada" dalam semenit, TTL `TICKER_MISSING_TTL_SECONDS`), `unverified`. Panggilan **mahal** (riwayat, fundamental, profil, foreign
  flow, broker) untuk ticker `unverified` menunggu **satu** kutipan sebagai probe keberadaan (di-cache, di-dedup, dibebankan ke kuota pemanggil). Ticker
  `missing` ditolak tanpa panggilan sama sekali; ticker `listed`/`verified` tidak pernah dianggap hilang oleh satu kegagalan sementara.
- **Circuit breaker** per penyedia: `MARKET_DATA_BREAKER_FAILURES` kegagalan beruntun (error, rate limit, timeout; "tidak ditemukan" bukan kegagalan) membuka
  breaker selama `MARKET_DATA_BREAKER_COOLDOWN_SECONDS`; setelah itu tepat satu probe boleh lewat.

## 3. Konfigurasi (semua divalidasi dengan batas atas)

| Variabel | Bawaan | Arti |
|---|---|---|
| `MARKET_DATA_USER_UNCACHED_PER_MINUTE` | 30 | Panggilan penyedia tanpa cache per pengguna per menit (setiap percobaan dihitung) |
| `MARKET_DATA_USER_UNCACHED_PER_HOUR` | 300 | Panggilan penyedia tanpa cache per pengguna per jam |
| `MARKET_DATA_GLOBAL_PER_HOUR` | 10000 | **Plafon total** per jam per penyedia (pengguna + sistem) |
| `MARKET_DATA_SYSTEM_RESERVE_PER_HOUR` | 2000 | Bagian plafon yang hanya boleh dipakai pekerjaan sistem (evaluasi alert); harus < plafon; 0 = satu kolam bersama |
| `MARKET_DATA_QUEUE_PER_USER` / `MARKET_DATA_QUEUE_GLOBAL` | 5 / 200 | Panggilan yang boleh menunggu slot; lebih dari itu ditolak seketika |
| `MARKET_DATA_QUEUE_SYSTEM` | 100 | Slot antrean tambahan yang hanya boleh dipakai pekerjaan sistem |
| `MARKET_DATA_MAX_RESPONSE_BYTES` | 4194304 | Ukuran respons HTTP maksimum dari penyedia (Yahoo harga/berita); dibaca bertahap dan dibatalkan begitu terlampaui |
| `MARKET_DATA_QUEUE_WAIT_MS` | 15000 | Batas menunggu slot |
| `MARKET_DATA_TIMEOUT_MS` | 20000 | Batas eksekusi satu panggilan; slot dilepas setelahnya |
| `MARKET_DATA_BREAKER_FAILURES` / `MARKET_DATA_BREAKER_COOLDOWN_SECONDS` | 5 / 30 | Ambang dan masa tunggu breaker |
| `TICKER_EXISTS_TTL_SECONDS` / `TICKER_MISSING_TTL_SECONDS` | 86400 / 120 | Lama "ada"/"tidak ada" diingat |
| `STOCK_API_MAX_CONCURRENCY` / `STOCK_API_MIN_INTERVAL_MS` | 3 / 150 | Dipakai ulang oleh penjadwal (konkurensi dan jeda mulai) |

## 4. Metrik (`GET /metrics`, hanya lokal)

Format teks Prometheus. Label hanya dari himpunan tetap (penyedia, hasil, alasan); **tidak pernah** berisi id pengguna, id chat, atau isi pesan.

| Metrik | Arti |
|---|---|
| `provider_requests_total{provider,outcome}` | `ok`, `not_found`, `error`, `timeout` |
| `provider_throttled_total{reason}` | `user_quota`, `user_hourly`, `global_budget` (kolam pengguna habis), `system_reserve` (cadangan sistem habis), `breaker_open`, `queue_user`, `queue_global`, `queue_timeout`, `aborted` |
| `provider_budget_limit{pool}`, `provider_budget_remaining{pool}`, `provider_budget_consumed_total{pool}` | anggaran per kolam (`user` / `system`): batas, sisa, konsumsi. **Hanya nama kolam sebagai label** |
| `provider_queue_depth`, `provider_active` | gauge penjadwal |
| `market_data_cache_total{kind,result}` | `hit`, `miss`, `negative` untuk `quote` dan `history` |
| `market_data_existence_gate_total{result}` | probe keberadaan yang tidak meloloskan panggilan mahal |
| `provider_unattributed_total` | panggilan tanpa identitas pemanggil (seharusnya 0) |

## 5. Batas yang sengaja ada

- **Tanpa Redis:** kuota, anggaran, antrean, dan breaker berada di memori proses; restart mengosongkannya. Dengan `REDIS_URL` kuota dibagi antar proses (lihat
  2a untuk restart Redis).
- Kuota per pengguna (menit dan jam) melindungi dari **satu** akun. Banyak akun masing-masing mendapat kuotanya sendiri: 27+ akun yang masing-masing menghabiskan 300/jam
  tetap bisa menguras **kolam pengguna** 8.000/jam dan membuat pengguna lain terdegradasi, tetapi tidak lagi dapat menyentuh cadangan sistem sehingga alert tetap
  dievaluasi. Ini risiko yang diterima dan terlihat di metrik; tidak ada batas jumlah pengguna.
- Ticker nyata di luar daftar bawaan pertama kali butuh satu probe; daftar 90 kode bukan registri lengkap IDX. Registri yang disegarkan otomatis belum dibuat.
- Pembatalan: penjadwal mendukung `AbortSignal`, tetapi pemanggil saat ini belum mengoper sinyal (permintaan yang ditinggalkan pengguna tetap berjalan sampai
  selesai atau timeout).
- Dampak sisi Yahoo (apakah 10.000 panggilan per jam aman) tidak diuji; nilai bawaan adalah perkiraan konservatif dan bisa diubah.
