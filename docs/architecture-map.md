# Indonesian Stock Bot — Peta Arsitektur Saat Ini

Tanggal audit: 2026-10-04. Sumber: inspeksi repositori (bukan klaim laporan). Dokumen ini menjelaskan **apa yang ada sekarang**.

## 1. Ringkasan

| Aspek | Kondisi |
|---|---|
| Bentuk | **Satu aplikasi NestJS (modular monolith)**, satu proses. Bukan monorepo `apps/` + `packages/` |
| Bahasa / runtime | TypeScript strict, Node ≥ 20 (dikembangkan di Node 24), NestJS 11, CommonJS |
| Basis data | PostgreSQL 16 (`postgres:16-alpine`, Docker, `127.0.0.1:5436`), Prisma 6.19, 5 migrasi (semua sudah diterapkan ke `ai_stock`) |
| Redis / antrean / vektor | **Tidak ada**: tidak ada Redis, BullMQ, pgvector, embedding. Semua status sementara ada di memori proses |
| Telegram | grammY + `@grammyjs/runner` (long polling), `sequentialize` per (chat, pengirim), `SenderGate`, anggaran pesan grup |
| AI | `AIService` → `AIProvider` (Ollama default, Gemini, OpenAI); hanya `generate()` + `checkHealth()`; tidak ada `classify()`/`embed()` terpisah |
| Data pasar | `StockDataProvider` (satu implementasi: Yahoo lewat `yahoo-finance2`, tidak resmi) |
| Ukuran | ±12,7 ribu baris kode non-tes, 41 berkas spec, ±1618 tes unit + 302 integration + 22 e2e |
| Git | Hanya satu commit ("first commit"); ±118 entri belum di-commit |

## 2. Modul (`src/`)

| Modul | Tanggung jawab | Catatan |
|---|---|---|
| `telegram/` | Transport grammY, identitas, `addressedText` (mention persis), `SenderGate`, anggaran grup, retry 429, format balasan HTML | `telegram-response.ts` memformat semua balasan |
| `chat/` | `ChatService.handle()`: batas laju per pengguna, panjang input, perutean intent ke handler | `handlers/stock.handler.ts`, `general.handler.ts`, `portfolio.handler.ts` (**nama menyesatkan**: menangani watchlist dan alert, bukan portofolio) |
| `intent/` | Parser deterministik (kutipan, analisis, perbandingan, alert, watchlist, saran, tanggal), ekstraktor ticker, validator, klasifikasi AI sebagai cadangan (read-only) | `intent-parser.ts`, `parsers/*` |
| `ai/` | `AIService` (gerbang adil, antrean, timeout), provider, katalog klaim (`claims.ts`), validasi pilihan (`ai-output.ts`), policy (`policy/*`), konteks AI (`ai-context.ts`), kuota (`ai-quota.service.ts`) | Keluaran pengguna selalu kalimat katalog |
| `analysis/` | Indikator deterministik (SMA, EMA, RSI, MACD, Bollinger, ATR, volume), support/resistance, klasifikasi tren/momentum, `AnalysisService` (cache 60 dtk) | `technical.ts`, `indicators/`, `support-resistance/` |
| `stock/` | `StockService`: cache kutipan/riwayat, cache "tidak ditemukan", throttle provider, retry, persistensi snapshot dan candle; provider Yahoo + normalizer | **Titik rawan**: satu `Throttle(3, 150 ms)` bersama |
| `market/` | Kualitas data (`trusted/suspect/invalid`), kesegaran, jam bursa | `data-quality.ts` |
| `alert/` | `AlertService`: buat/daftar/hapus, kunci unik `activeKey`, kunci advisory per pengguna, evaluasi berkala, klaim lalu kirim (at-most-once), `reactivate` | enum `AlertType`: PRICE_ABOVE/BELOW, RSI_ABOVE/BELOW, VOLUME_MULTIPLIER (dipakai) dan MA_CROSSOVER (**hanya dideklarasikan di enum, tidak ada kode yang memakainya**); `AlertStatus`: ACTIVE/TRIGGERED/DISABLED |
| `watchlist/` | Tambah/hapus/daftar | |
| `conversation/` | `ConversationService`: konteks per (pengguna, chat), kedaluwarsa | Hanya simbol dan intent terakhir; bukan memori percakapan |
| `knowledge/` | Glosarium indikator (jawaban konseptual tanpa model) | |
| `screener/` | Penyaringan atas daftar 90 ticker bawaan | |
| `notifier/` | Pengiriman pesan proaktif (alert) lewat transport | |
| `scheduler/` | Evaluasi alert berkala, retensi data | `@nestjs/schedule` dalam proses |
| `api/`, `health/` | REST lokal (kutipan, teknikal, riwayat, analisis), `/health` | Hanya loopback, Host/Origin diperiksa, kuota AI per alamat |
| `config/` | Skema env (zod) + `AppConfig` | Validasi ketat, batas atas |
| `common/` | Cache TTL, penjaga adil (`fair-gate.ts`), pembatas laju, semafor, retry, `scrub`, `http-setup` | |
| `access/`, `user/`, `database/`, `cli/`, `testing/` | Mode akses (`public`/`allowlist`), pengguna, Prisma, CLI chat lokal, fixture dan penjaga DB uji | |

## 3. Model data (Prisma)

`User`, `Stock`, `StockQuoteSnapshot`, `StockDailyPrice`, `TechnicalIndicator`, `Watchlist`, `WatchlistItem`, `Alert`, `AIAnalysis`,
`ConversationContext`, `DataFetchLog`. **Tidak ada**: portofolio, posisi, transaksi, kas, snapshot portofolio, registri ticker, dokumen/chunk RAG,
outbox, riwayat pesan.

## 4. Alur utama

```text
Telegram update
  → bot.use(otorisasi AccessService)            [mode public/allowlist, ID bersama diabaikan]
  → SenderGate (≤3 per pengirim, soft limit 300)
  → sequentialize(chat:pengirim)                [urutan per pengirim]
  → onText: addressedText → ChatService.handle
      → batas laju pengguna → panjang input → IntentService.resolve
          parser deterministik → (jika tak dikenali) klasifikasi AI read-only
      → handler (stock / general / watchlist+alert)
          StockService (cache → throttle → Yahoo) → AnalysisService (indikator) → kualitas data
          AIService.analyze (katalog klaim → id dari model → kalimat aplikasi → policy)
  → telegram-response (HTML) → send (anggaran grup, retry 429)
```

Alert: `SchedulerService` → `AlertService.checkAll` (kelompok per simbol → kutipan tepercaya + referensi → evaluasi → klaim `TRIGGERED` →
`NotifierService.send`; kegagalan sementara → `reactivate` di bawah kunci).

## 5. Status dalam proses (hilang saat restart)

Cache kutipan (60 dtk) / riwayat (900 dtk) / "tidak ditemukan" / laporan analisis (60 dtk) / health (15 dtk); `knownGood`; `Throttle` provider;
`FairGate` AI; `AiQuotaService`; `SlidingWindowLimiter` (pesan pengguna, grup, REST); `SenderGate`; `sequentialize`; antrean AI. **Konsekuensi:** hanya
satu instance yang benar; tidak ada koordinasi antar proses.

## 6. Infrastruktur dan operasional

- `docker-compose.yml`: hanya `postgres:16-alpine` (kata sandi bawaan `postgres`, port hanya di 127.0.0.1). Tidak ada profil (`core/ai/workers/…`), tidak ada Redis/Ollama dalam compose (Ollama berjalan di host).
- Logging: pino (nestjs-pino) dengan `scrub`; `/health` ada; **tidak ada** `/ready`, `/live`, metrik, tracing.
- Tes: Jest 30 (unit `src/**/*.spec.ts`; integration dan e2e di `test/` dengan DB `ai_stock_test`; penjaga DB uji; tes migrasi dengan data tersemai); skrip live Ollama (`npm run test:live-ai`).
- Pengerasan REST: loopback, Host/Origin, 10 kB, kuota AI per alamat.

## 7. Titik perluasan yang sudah ada (dipertahankan)

`StockDataProvider` (antarmuka penyedia data), `AIProvider`, `FairGate` (dasar penjadwal adil), `TtlCache`, pembatas laju, `DataQuality`,
katalog klaim + policy berlapis, kunci `activeKey` dan kunci advisory, `ConversationContext(userId, chatId)`.
