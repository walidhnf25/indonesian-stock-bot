# Keamanan

> Pemeriksaan keamanan proyek ini dilakukan oleh pembangun dan alat otomatis (tes, mutasi, pemindaian). Ia **bukan**
> tinjauan keamanan oleh manusia atau pihak ketiga dan bukan uji penetrasi. Jika bot ini dipakai untuk data atau dana
> yang sebenarnya sensitif, minta tinjau oleh orang yang kompeten sebelum dipercaya.

## Melaporkan kerentanan

Jangan membuka issue publik yang memuat detail kerentanan, token, atau data pengguna. Gunakan **Security → Report a
vulnerability** di halaman repo ini (laporan privat GitHub) bila tersedia; jika tidak, hubungi pemilik repo lewat profil
GitHub-nya. Sertakan langkah yang bisa diulang dan versi (commit) yang diuji.

## Model ancaman

| Aset | Ancaman | Pelaku |
|---|---|---|
| Data pengguna (watchlist, alert, portofolio, catatan pribadi) di PostgreSQL dan cadangan | dibaca atau diubah pihak lain, bocor antar pengguna | pengguna Telegram lain (bot publik), proses lain di mesin, jaringan yang sama |
| Integritas pembukuan portofolio dan alert | transaksi ganda atau hilang, alert terkirim dua kali atau tidak sama sekali, batas jumlah alert terlewati | retry, balapan (race), input jahat, keluaran AI yang keliru |
| Keluaran AI | anjuran beli/jual, target harga, prediksi, atau penjamin keuntungan sampai ke pengguna | prompt injection, model yang melenceng |
| Kredensial (token bot, kunci penyedia AI, sandi backup) | bocor lewat repo, log, atau pesan galat | kelalaian, dependensi |
| Ketersediaan (penyedia data pasar, model AI, antrean) | banjir permintaan, banyak akun menguras anggaran, respons raksasa dari upstream, notifikasi beracun di antrean | pengguna berniat buruk, penyedia yang salah konfigurasi, penulis Redis |
| API REST lokal | diakses dari luar mesin atau dari halaman web asing | pihak di jaringan yang sama, DNS rebinding |

Di luar cakupan: keamanan Telegram sebagai platform, keamanan fisik/OS mesin, malware di mesin pemilik, dan keandalan
data penyedia gratis (Yahoo Finance tidak resmi dan bisa tertunda atau salah).

## Kontrol yang diterapkan dan di mana diuji

| Kontrol | Penjelasan singkat | Tes / bukti |
|---|---|---|
| Akses bot | mode bawaan `allowlist` (fail-closed); mode `public` hanya bila dipilih eksplisit di `.env` | `src/access/access.service.ts`, `test/integration/security.spec.ts` |
| Isolasi antar pengguna | setiap kueri dibatasi `userId`; konteks per (pengguna, chat); portofolio, catatan, dan memori hanya di chat pribadi | `test/integration/scoping-and-races.spec.ts`, `portfolio-isolation.spec.ts`, `rag.spec.ts` |
| AI tidak menulis jawaban bebas | model hanya memilih id dari katalog kalimat yang ditulis aplikasi; pelanggaran kebijakan tidak pernah sampai ke pengguna | `src/ai/claims.spec.ts`, `test/integration/ai-input-and-fairness.spec.ts` |
| AI tidak mengubah data | niat yang mengubah data (catat transaksi, hapus data, buat alert) hanya dari parser deterministik, tidak dari klasifikasi model | `src/intent/intent-validator.ts`, `src/intent/intent-matrix.spec.ts` |
| Anggaran penyedia data | kuota per pengguna (menit dan jam), kolam pengguna terpisah dari cadangan sistem (alert), penjadwal adil, circuit breaker | `src/stock/governance/*.spec.ts`, `test/integration/market-data-reserve.spec.ts`; ringkasan di `docs/market-data.md` |
| Respons upstream berbatas | respons AI, embedding, harga, dan berita dibaca bertahap dan dibatalkan di batas ukuran | `src/common/utils/bounded-http.spec.ts` |
| Antrean notifikasi tak dipercaya | payload divalidasi di sisi pembaca (bentuk, penerima yang dikenal, panjang, markup, tanpa tautan); job cacat gagal sekali | `src/notifier/notification-payload.spec.ts`, `test/integration/notification-queue.spec.ts`; `docs/bullmq.md` |
| Batas alert | satu aturan kapasitas untuk membuat dan mengaktifkan ulang alert, di bawah kunci per pengguna | `test/integration/alert-cap.spec.ts` |
| REST hanya lokal | startup menolak `HOST` non-loopback kecuali `REST_ALLOW_REMOTE=true`; pemeriksaan Host/Origin; batas ukuran body | `src/common/security-hardening.spec.ts`, `test/e2e/rest-hardening.spec.ts` |
| Redis | dipublikasikan hanya ke `127.0.0.1`; sandi opsional (`REDIS_PASSWORD`); URL non-loopback tanpa sandi ditolak saat startup | `src/config/limits-env.spec.ts`; `docs/redis.md` |
| Rahasia | `.env`, `backups/`, dan dump SQL tidak pernah di-commit; `.env.example` tidak memuat rahasia (token, kunci, dan sandi dikosongkan); pesan galat dan log dibersihkan dari rahasia | `.gitignore`, `src/common/common.spec.ts` |
| Cadangan | `pg_dump` terenkripsi secara bawaan (GPG), diverifikasi dengan dibaca ulang; latihan restore pada container sekali pakai | `scripts/backup-db.sh`, `scripts/lib-backup.sh`, `scripts/restore-rehearsal.sh`; `docs/operations.md` |
| Batas sumber daya container | batas memori/CPU di `docker-compose.yml`, dengan pemeriksa nilai yang benar-benar aktif | `npm run docker:verify` |
| Tes tidak menyentuh dunia nyata | tes menolak database non-lokal dan yang namanya bukan database tes; bot Telegram sungguhan tidak pernah dijalankan dari tes | `src/testing/db-guard.ts`, `src/telegram/runtime-guard.ts` |

## Cara menjalankan pemeriksaan

```bash
npm run lint
npm run typecheck
npm test                  # unit
npm run test:integration  # PostgreSQL nyata (database tes terpisah)
npm run test:e2e
npm run test:load
npm run test:mutations    # menghapus satu penjaga pada salinan pribadi, lalu memastikan tes gagal
npm run docker:verify     # batas container yang dideklarasikan vs yang aktif
```

Tes integrasi memakai database `ai_stock_test` dan, untuk mode Redis, database Redis terpisah dengan awalan
`stockbottest:`. Database pengembangan tidak disentuh.

## Risiko yang diketahui dan diterima

- Satu penyedia data tidak resmi (Yahoo Finance): bisa tertunda, salah, atau tidak tersedia. Bot menandai data basi dan
  menolak mengirim alert dari data yang tidak tepercaya.
- Redis tanpa sandi secara bawaan, hanya terjangkau dari `127.0.0.1`. Siapa pun yang bisa menulis ke Redis bisa mengantre
  teks biasa ke pengguna yang dikenal. Isi `REDIS_PASSWORD` bila mesin dipakai bersama.
- Kredensial PostgreSQL bawaan untuk pengembangan lokal (`postgres`/`postgres`), hanya di `127.0.0.1`. Ganti sebelum
  dipakai di server.
- Banyak akun Telegram dapat menguras kolam anggaran pengguna dan menurunkan layanan bagi pengguna lain; alert tetap
  dievaluasi dari cadangan sistem. Terlihat di metrik, bukan dicegah sepenuhnya.
- Pengiriman alert bersifat paling banyak sekali: bila proses mati tepat antara menandai dan mengirim, satu notifikasi
  bisa hilang.
- Perutean "anjuran" oleh parser berbasis pola bersifat heuristik; keselamatannya tidak bergantung padanya karena model
  tidak bisa menulis anjuran.
- `npm audit` melaporkan temuan tingkat tinggi pada rantai CLI Prisma (alat pengembangan, bukan kode yang berjalan di
  produksi). Jalankan `npm audit` untuk keadaan terkini.

Bot ini adalah asisten analisis berbasis data, bukan layanan sinyal perdagangan, dan tidak menjalankan transaksi apa pun.
