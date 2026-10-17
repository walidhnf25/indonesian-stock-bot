# Portofolio

Indonesian Stock Bot **mencatat**, tidak pernah bertransaksi. Portofolio adalah buku catatan milik pengguna: pembelian, penjualan, dividen, setoran, dan penarikan yang
diketik pengguna sendiri, dinilai dengan harga pasar yang tepercaya. Tidak ada koneksi broker, tidak ada eksekusi order.

## Cara pakai (chat pribadi saja)

| Pesan | Hasil |
|---|---|
| `beli 10 lot BBCA di 9000` · `catat beli 200 lembar BBRI @ 4500 fee 1500` | pembelian dicatat (1 lot = 100 lembar; biaya masuk ke harga rata-rata) |
| `jual 3 lot TLKM di 3100 biaya 10rb` | penjualan dicatat; P/L terealisasi = hasil bersih − jumlah × harga rata-rata |
| `setor 10 juta` · `tarik 5jt` · `dividen BBCA 150000` | kas dan dividen dicatat |
| `portofolio saya` · `berapa untung saya?` · `posisi saya` | ringkasan: posisi, harga rata-rata, nilai pasar, P/L belum/terealisasi, dividen, kas, alokasi |
| `riwayat transaksi` | 10 catatan terakhir |
| `batalkan transaksi terakhir` | pembalikan persis catatan terakhir (≤ 24 jam) |

Sebuah pesan hanya dianggap **catatan** bila menyebut jumlah (lot/lembar) dan, untuk beli/jual, harga. `beli BBCA?`, `sebaiknya jual?`, atau kalimat
tanya lain tetap diperlakukan sebagai pertanyaan/nasihat (kebijakan yang sudah ada). Di **grup** semua perintah portofolio ditolak tanpa membocorkan apa pun.

## Model data (PostgreSQL, Decimal)

- `Portfolio` (satu per pengguna, nama `Utama`): `cash`, `realizedPnl` sebagai `Decimal(20,2)`.
- `Holding` (`portfolioId`, `stockId` unik): `quantity` lembar `Decimal(20,4)`, `avgCost` per lembar `Decimal(20,4)`, `realizedPnl`.
- `PortfolioTransaction`: buku besar **append-only**. Jenis `BUY | SELL | DIVIDEND | DEPOSIT | WITHDRAWAL | REVERSAL`; `cashDelta` bertanda; `realizedPnl`;
  `qtyBefore`/`avgCostBefore` (keadaan sebelum baris ini, untuk pembalikan persis); `reversesId` unik (satu pembalikan per catatan); `idempotencyKey` unik; `chatId`.
- `PortfolioSnapshot` (`portfolioId`, `asOf` unik): nilai pasar, kas, modal, P/L, jumlah posisi yang tidak bisa dinilai; satu per hari kalender Asia/Jakarta,
  ditulis tiap jam setelah 16:00 WIB (job `portfolio-snapshot` di antrean `maintenance`, atau timer dalam proses).

Migrasi: `20261004200000_portfolio` (hanya tabel baru; tidak menyentuh data yang ada).

## Catatan presisi (2026-10-05)

`Holding.costBasis` (2 dp, eksak) adalah sumber kebenaran; `avgCost` (4 dp) hanya turunan untuk tampilan dan snapshot "sebelum" di buku besar. Sebelumnya rata-rata berikutnya dihitung dari rata-rata **yang sudah dibulatkan**, sehingga hasil bergantung pada urutan penerapan pembelian yang bersamaan (1009,4999 vs 1009,5 untuk dua puluh pembelian 1000..1019). Penjualan membebankan porsi basis yang eksak (`basis × qty / qtyBefore`), pembalikan memulihkan `costBasisBefore`. Migrasi `20261005010000_holding_cost_basis` mengisi `costBasis = round(quantity × avgCost, 2)` untuk baris lama.

## Akuntansi (deterministik, `portfolio-accounting.ts`)

Metode **harga rata-rata**. Beli: `avg' = (q·avg + qty·price + fees) / (q + qty)`; kas −(qty·price + fees). Jual: hasil = qty·price − fees; P/L terealisasi
= hasil − qty·avg; avg tetap (0 bila habis). Pembulatan: uang 2 desimal, harga per lembar 4 desimal, *half-even*. Semua operasi `Prisma.Decimal`; tidak ada
`number` di jalur perhitungan uang. AI tidak pernah menghitung apa pun: ia hanya membaca angka yang sudah dihitung (dan saat ini tidak dilibatkan sama sekali
pada tampilan portofolio).

Aturan: jumlah lembar bilangan bulat positif; harga > 0; jual tidak boleh melebihi yang dimiliki; penarikan tidak boleh melebihi kas tercatat; kas **boleh** negatif
akibat pembelian (pengguna tidak wajib mencatat setoran lebih dulu); maks `PORTFOLIO_MAX_HOLDINGS` saham berbeda (50) dan `PORTFOLIO_MAX_TRANSACTIONS_PER_DAY`
catatan per 24 jam (100).

## Integritas

- **Idempotensi**: kunci = `tg:<chatId>:<messageId>` (update Telegram yang terkirim ulang mencatat sekali); tanpa id pesan (CLI/tes) kunci = hash(pengguna, teks,
  menit). Kunci yang sudah ada → baris yang sama dikembalikan dengan `duplicate: true`, tanpa baris baru.
- **Konkurensi**: setiap penulisan satu pengguna memakai `pg_advisory_xact_lock('portfolio:<userId>')` dalam satu transaksi; 20 pembelian paralel → tepat 20 baris dengan
  rata-rata yang benar; 5 penjualan paralel atas 100 lembar → hanya satu berhasil.
- **Otorisasi**: semua kueri dibatasi `userId` dari identitas Telegram yang terautentikasi; tidak ada id portofolio yang diterima dari input.
- **Kebal AI**: `PORTFOLIO_RECORD`/`PORTFOLIO_UNDO` ada di `STATE_CHANGING`; keluaran classifier AI dengan intent itu diubah menjadi klarifikasi.
- **Audit**: tidak ada baris yang diubah atau dihapus; pembatalan = baris `REVERSAL` yang memulihkan keadaan sebelumnya (`qtyBefore`, `avgCostBefore`) dan mengembalikan kas/P/L.

## Valuasi dan kualitas data

Hanya kutipan **TRUSTED** (`DataQualityService.plausibilityOf`) yang dipakai sebagai harga. Kutipan `suspect`/`invalid` atau tidak tersedia → posisi dinilai **dari modal**
dan ditandai (`⚠️ Dinilai dari modal: TSTA (harga terlihat tidak wajar)`); jumlahnya tercatat di `totals.unpriced` dan di snapshot. Data tersimpan (stale) ditandai
seperti di watchlist. Nilai pasar, P/L, dan alokasi dihitung dari angka yang sama yang ditampilkan.

## Pengujian

- Unit: `portfolio-accounting.spec.ts` (rata-rata, P/L, pembulatan tanpa drift, valuasi, alokasi), `portfolio-routing.spec.ts` (parser: catatan vs pertanyaan,
  klarifikasi, AI tidak bisa mencatat).
- Integration (`test/integration/portfolio.spec.ts`, PostgreSQL asli): akuntansi lewat layanan; penolakan (oversell, tarik melebihi kas, ticker tak dikenal,
  lembar pecahan, NaN); idempotensi 10× kunci sama; 20 pembelian paralel; balapan jual; undo persis dan undo ganda ditolak; kutipan suspect → dinilai dari modal;
  provider mati; snapshot harian; lewat chat: pencatatan, pengulangan `messageId`, penolakan di grup, isolasi antar pengguna, klasifikasi AI ditolak.

## Batas yang disengaja

Satu portofolio per pengguna; tidak ada aksi korporasi otomatis (stock split dicatat manual lewat jual/beli atau pembatalan); tidak ada impor dari broker;
pembatalan hanya untuk catatan terakhir dalam 24 jam; mata uang IDR saja; snapshot bukan riwayat per-posisi.
