# AI lanjutan

## Prinsip yang tidak berubah

Model bahasa **tetap hanya memilih id** dari katalog kalimat yang ditulis aplikasi (`docs/architecture-map.md`). Fitur ini memperluas **katalognya**, bukan kebebasan modelnya: sumber baru masuk sebagai kalimat yang ditulis aplikasi dari data yang sudah diverifikasi aplikasi, lengkap dengan angka yang boleh dikutip (`extraNumbers` untuk kebijakan keluaran). Sumber yang tidak tepercaya **diam** — tidak ada klaim, bukan klaim yang dilunakkan.

## Sumber yang digabung (`src/ai/extra-claims.ts`, `buildAnalysisContext`)

| Sumber | Syarat masuk katalog | Observasi | Risiko turunan data |
|---|---|---|---|
| Data pasar + teknikal | seperti sebelumnya | fakta harga/MA/RSI/volume | RSI ekstrem, dekat level, volume, di bawah MA50 |
| Fundamental | laporan **bukan** `stale`; metrik `reported`/`derived`/`estimated` saja | PER, PBV, ROE, dividend yield, margin, pertumbuhan, DER — dengan tanda `(turunan)`/`(estimasi analis)`; maks 6 | DER > 2; laba turun > 20 %; margin negatif; PER > 50 |
| Berita | dari penyedia (bukan arsip), ada artikel `direct` | satu kalimat: jumlah, umur terbaru, sumber, **tag kejadian** — tidak pernah judul | berita suspensi/UMA (sumber, umur), maks 2 |
| Portofolio pengguna | hanya chat pribadi, hanya milik penanya | "Kamu memegang N lot, rata-rata Rp…, posisi ±x %" | – |
| Watchlist pengguna | hanya chat pribadi | "Saham ini ada di watchlist kamu." | – |
| Konteks percakapan | seperti sebelumnya (tiket dari konteks) | – | – |
| Pengetahuan RAG | tidak masuk katalog (jawaban konsep sudah deterministik, `docs/rag.md`) | – | – |

Bila fundamental atau berita ikut, kalimat tetap `NO_NEWS_RISK` ("hanya harga dan volume") diganti `SOURCES_RISK` ("memakai harga, volume, fundamental yang dilaporkan, dan kejadian berita; semuanya masa lalu, bukan prediksi"), dan keterbatasan data menyebut bahwa isi berita tidak dibaca model dan tidak ada sentimen. Aturan validator tidak berubah: ≥ 3 observasi dilengkapi urutan katalog, **semua risiko turunan data selalu tampil**, angka harus ada di konteks.

## Fitur

- **Analisis kontekstual**: `analisis BBCA` di chat pribadi menyertakan posisi/watchlist penanya di katalog; di grup tidak pernah (bahkan untuk pemiliknya). Kartu analisis menampilkan fundamental **dengan asal-usul** dan blok "Berita terkait" (judul dari penyedia; bukan penjelasan sebab).
- **Sintesis risiko**: risiko teknikal + fundamental + berita dalam satu daftar, semuanya turunan data, semuanya tampil.
- **Ringkasan portofolio** (`ringkas portofolio saya`, `bagaimana portofolio saya?`; chat pribadi): katalog dari `PortfolioView` (nilai, laba/rugi mengambang & terealisasi, dividen, porsi terbesar, posisi terbaik/terlemah; risiko konsentrasi > 50 %, saham tak ternilai, harga tidak terkini, rugi > 20 %). Model memilih; tanpa model: urutan katalog. Tidak ada saran.
- **Preferensi penyajian**: `jawab ringkas` / `jawab lengkap` (`User.preferences.detail`). Ringkas = harga + tren + ringkasan + ≤ 2 observasi + **semua risiko** + keterbatasan; bagian volume, level, fundamental, dan berita dilewati. Risiko dan disclaimer tidak pernah dipangkas.
- Perbandingan multi-saham dan penjelasan teknikal/fundamental: sudah ada — penjelasan istilah lewat glosarium/korpus, bukan model.

## Pengujian

- Unit: `extra-claims.spec.ts` (kalimat per sumber, tanda asal-usul, risiko turunan, `stale`/arsip/`related` → kosong, judul berita tidak pernah bocor, klaim portofolio), `memory-intents.spec.ts` (preferensi `detail`), `portfolio-routing.spec.ts` (`PORTFOLIO_SUMMARY`).
- Integrasi `test/integration/advanced-ai.spec.ts`: katalog di prompt memuat klaim fundamental dan kalimat berita **tanpa judul**; klaim posisi hanya di chat pribadi pemiliknya; fundamental basi tidak masuk; kartu memuat fundamental berasal-usul dan blok berita terkait; `jawab ringkas` memangkas bagian tetapi mempertahankan risiko; ringkasan portofolio dengan dan tanpa model, ditolak di grup.
