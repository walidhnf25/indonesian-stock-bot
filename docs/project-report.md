# Indonesian Stock Bot — Laporan proyek

Indonesian Stock Bot adalah bot Telegram untuk membaca data saham Bursa Efek Indonesia (IDX/BEI) dengan bahasa
sehari-hari: harga, analisis teknikal dan fundamental, berita, watchlist, alert harga, pembukuan portofolio pribadi,
catatan pribadi, dan penjelasan istilah. Data disimpan di PostgreSQL; model bahasa lokal (Ollama) hanya menjelaskan
angka yang dihitung aplikasi. Bot ini **bukan** layanan sinyal perdagangan dan tidak menjalankan transaksi apa pun.

> **Tentang laporan ini.** Pemeriksaan di dalamnya dilakukan oleh pembangun proyek dan alat otomatis (tes, mutasi,
> pemindaian). Belum ada tinjauan keamanan oleh manusia atau pihak ketiga, dan ini bukan uji penetrasi. Angka yang
> disebut berasal dari menjalankan tes di mesin pengembangan; jalankan sendiri untuk memastikan di mesin Anda.

## 1. Ringkasan

| Pertanyaan | Jawaban |
|---|---|
| Layak dipakai? | **Ya untuk pemakaian pribadi atau kelompok kecil, dengan batasan terdokumentasi** (bagian 5) |
| Siap di server (VPS)? | **Siap dicoba, belum terbukti.** Ada `Dockerfile`, layanan compose, backup terenkripsi, dan cron; belum diuji dengan token asli di server sungguhan |
| Datanya benar? | Aritmetika portofolio memakai `Decimal`, buku besar hanya bertambah, setiap transaksi idempoten dan bisa dibatalkan persis; terbukti oleh tes pada PostgreSQL nyata |
| Aman dari penyalahgunaan? | Isolasi antar pengguna, batas anggaran penyedia, batas ukuran respons, dan validasi antrean dibuktikan tes dan mutasi. Belum ada audit manusia (bagian 4) |
| Apa yang belum dibuktikan? | Telegram sungguhan dalam skala, Yahoo Finance dalam beban nyata, Ollama di bawah beban bersamaan, dan penerapan multi-proses |

## 2. Gambaran proyek

### 2.1 Fitur

| Area | Isi |
|---|---|
| Akses | mode bawaan `allowlist` (ID Telegram yang diizinkan, fail-closed); mode `public` hanya bila dipilih eksplisit |
| Bahasa alami | parser niat deterministik berbahasa Indonesia (kode saham, alias, format angka `8.500`, `4,5rb`), konteks percakapan per chat |
| Harga dan data | harga, perubahan, OHLC, volume, cap waktu penyedia, dan label kesegaran LIVE/DELAYED/STALE/UNKNOWN; pertanyaan tanggal lampau dijawab dari candle tanggal itu |
| Analisis | indikator teknikal (SMA/EMA, RSI, MACD, Bollinger, ATR, support/resistance), kartu fundamental dengan asal-usul tiap angka, perbandingan 2–6 saham, penyaringan |
| AI | model hanya memilih id dari katalog kalimat yang ditulis aplikasi; pertanyaan anjuran, target harga, dan prediksi dijawab teks kebijakan tetap tanpa melibatkan model |
| Watchlist dan alert | per pengguna; alert harga, RSI, volume, dan persilangan MA; siklus ACTIVE/PAUSED/TRIGGERED/DISABLED/EXPIRED; pengiriman paling banyak sekali; tidak pernah menyala dari data basi atau tak tepercaya |
| Portofolio | pembukuan dari chat pribadi (`beli 10 lot BBCA di 9000`, `setor 10 juta`), biaya rata-rata, laba terealisasi, pembatalan transaksi, ringkasan |
| Berita | judul dari penyedia, tag kejadian, arsip; tidak pernah dijadikan klaim sebab |
| Catatan dan pengetahuan | korpus edukasi dan catatan pribadi dengan pencarian gabungan (pgvector + teks) dan otorisasi sebelum pemeringkatan |
| Data pribadi | konteks, preferensi, dan penghapusan seluruh data dua langkah ("hapus data saya") |
| REST | hanya lokal: `/health`, `/live`, `/ready`, `/metrics`, dan beberapa endpoint saham |

### 2.2 Arsitektur

Satu aplikasi NestJS (modular monolith). Alur satu pesan: **Telegram → akses (allowlist atau publik) → ChatService (batas
laju, panjang input) → parser niat deterministik → handler → StockService → MarketDataGovernor → penyedia**. Model bahasa
dipakai belakangan dan hanya untuk memilih kalimat.

| Komponen | Peran |
|---|---|
| NestJS + grammY | aplikasi dan transport Telegram (long polling) |
| PostgreSQL 16 + pgvector | sumber kebenaran: pengguna, watchlist, alert, buku besar, snapshot, korpus dan catatan, arsip berita |
| Redis dan BullMQ (opsional) | kuota bersama, antrean `alerts`, `maintenance`, `notifications`; tanpa Redis semuanya berjalan di dalam proses |
| Ollama | model lokal (`qwen3:4b-instruct` bawaan) dan embedding opsional |
| Yahoo Finance | satu penyedia data pasar dan berita (tidak resmi, tertunda ±10 menit) |
| `MarketDataGovernor` | satu pintu ke penyedia: circuit breaker, kuota per pengguna, anggaran jam dengan cadangan sistem, penjadwal adil |

Peran proses (`BOT_ROLE`): `all` (bawaan), `gateway` (Telegram + REST), `worker` (pekerja antrean). Compose menyediakan
layanan `postgres`, `redis`, `migrate`, dan `app`. Rincian: `docs/architecture-map.md`.

### 2.3 Model data

`User`, `Stock`, `StockQuoteSnapshot`, `StockDailyPrice`, `TechnicalIndicator`, `Watchlist`, `WatchlistItem`, `Alert`,
`AIAnalysis`, `ConversationContext`, `DataFetchLog`, `Portfolio`, `Holding`, `PortfolioTransaction`, `PortfolioSnapshot`,
`KnowledgeDocument`, `KnowledgeChunk`, `FundamentalSnapshot`, `NewsArticle`. Skema berubah hanya lewat migrasi Prisma.

### 2.4 Konfigurasi

Semua pengaturan lewat variabel lingkungan yang divalidasi saat startup (nilai tak valid menghentikan aplikasi dengan
pesan yang tidak memuat nilainya). Daftar lengkap ada di `.env.example` dan bagian "Environment variables" di `README.md`.

## 3. Bukti (pemeriksaan terakhir)

| Pemeriksaan | Hasil |
|---|---|
| Format (Prettier), ESLint, `tsc` | lolos |
| Tes unit | **2.075** lolos, 51 berkas |
| Tes integrasi (PostgreSQL nyata, mode memori) | **464** lolos, 26 berkas |
| Tes integrasi mode Redis | berkas yang bergantung Redis lolos; sisanya sama dengan mode memori |
| Tes e2e | **25** lolos |
| Uji beban (`npm run test:load`) | 150 pengguna × 6 pesan = 900 pesan dalam ≈ 4,5 detik, p99 ≈ 3,1 detik, 0 kesalahan internal (penyedia data dan model adalah fixture, jadi angka ini mengukur aplikasi, bukan Yahoo atau Ollama) |
| Mutasi penjaga (`npm run test:mutations`) | 35 penjaga dihapus satu per satu pada salinan pribadi; semuanya membuat tes gagal |
| Pemeriksaan model nyata (`npm run test:live-ai`) | lolos pada Ollama lokal; satu skenario tidak meyakinkan karena model menolak dipancing sendiri |
| Batas container | `npm run docker:verify` membandingkan batas yang dideklarasikan dengan yang aktif |
| Cadangan | `pg_dump` terenkripsi; latihan restore ke container sekali pakai terbukti memulihkan data identik |

Keterbatasan bukti: tes memakai fixture untuk penyedia data dan model; transport Telegram diuji dengan Bot API
yang di-stub, bukan sesi Telegram sungguhan.

## 4. Keamanan

Model ancaman, kontrol beserta tes yang membuktikannya, cara melapor, dan risiko yang diterima ada di
**`docs/security.md`**. Ringkasnya: pemeriksaan dilakukan oleh pembangun dan alat otomatis; **tidak** ada tinjauan manusia
atau pihak ketiga. Risiko terbuka yang paling relevan: satu penyedia data tidak resmi, Redis tanpa sandi secara bawaan
(hanya `127.0.0.1`), banyak akun dapat menurunkan layanan bagi pengguna lain, dan pengiriman alert paling banyak sekali.

## 5. Batasan dan yang tidak diklaim

- Data penyedia gratis tertunda sekitar 10 menit dan sesekali tidak tersedia; tidak ada data arus asing atau broker
  summary. Bot menandai data basi dan mengatakan bila datanya tidak ada.
- Hanya satu penyedia data: tidak ada sumber kedua untuk memeriksa silang harga.
- Hari libur bursa adalah konfigurasi (`MARKET_HOLIDAYS`), tidak terdeteksi otomatis; bila kosong, hari libur dianggap
  hari bursa.
- Penyaringan mencakup daftar saham yang dikonfigurasi, bukan seluruh emiten.
- Riwayat intraday (`jam 10:00`) tidak didukung dan dijawab begitu.
- Perutean pertanyaan "anjuran" oleh parser bersifat heuristik; keselamatannya tidak bergantung padanya karena model
  tidak bisa menulis anjuran.
- Penyedia AI cloud (Gemini, OpenAI) hanya dicakup tes dengan mock.
- Penerapan multi-proses dengan Redis sudah didukung, tetapi belum diukur dengan dua proses nyata.

### 5.1 Yang sengaja tidak dibuat

Perdagangan otomatis, rekomendasi atau sinyal beli/jual, prediksi harga, dan analisis sentimen berita oleh model.

## 6. Operasi

| Hal | Di mana |
|---|---|
| Menjalankan (Windows, Docker, Ollama) | `README.md`, bagian "Quick start" |
| Cadangan, restore, cron di VPS, batas sumber daya | `docs/operations.md` |
| Redis dan antrean | `docs/redis.md`, `docs/bullmq.md` |
| Tata kelola panggilan penyedia dan anggaran | `docs/market-data.md` |
| Metrik dan probe | `docs/observability.md` |
| Mode kegagalan dan pemulihan | `docs/resilience.md` |

## Lihat juga

[README](../README.md) · [Keamanan](security.md) · [Arsitektur](architecture-map.md) · [Operasi](operations.md) ·
[Uji beban](load-tests.md) · [Portofolio](portfolio.md) · [Alert](alerts.md) · [RAG](rag.md) · [Fundamental](fundamentals.md) ·
[Berita](news.md)
