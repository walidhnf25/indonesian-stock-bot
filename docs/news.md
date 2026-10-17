# Berita

## Prinsip

- **Berita adalah data, bukan narasi.** Indonesian Stock Bot menampilkan judul, sumber, waktu, dan tautan apa adanya; tidak meringkas, tidak menilai, tidak menyimpulkan sebab. Model bahasa **tidak pernah menerima teks berita** — ia tidak bisa mengarang atau menggemakan berita.
- **Setiap pernyataan turunan berita berjangkar pada sumber**: event (dividen, RUPS, right issue, …) hanya ditempelkan bila judulnya **secara harfiah** memuat kata kuncinya (`news-events.ts`), dan selalu ditampilkan bersama judul dan sumbernya.
- **Sentimen sengaja tidak ada.** Tidak ada metode deterministik di sini yang bisa membenarkan label sentimen; memakai model untuk itu bertentangan dengan prinsip di atas. Kolomnya tidak dibuat agar tidak ada yang tergoda mengisinya.
- Relevansi: `direct` bila penyedia atau judul menyebut saham itu; selain itu `related` (ditandai "(terkait)").

## Abstraksi penyedia

`NewsProvider { name; getNews(symbol, limit) }` (`news-provider.interface.ts`). Implementasi: `YahooNewsProvider` (endpoint pencarian Yahoo, `newsCount` ≤ 20) dan `NullNewsProvider` (`NEWS_PROVIDER=none`: selalu "tidak tersedia", jujur). Penyedia berikutnya (API berita Indonesia, RSS) cukup mengembalikan `RawNewsItem[]` dengan id stabil.

Pengambilan lewat `StockService.getNews` → gerbang keberadaan ticker, kuota per pengguna/global, breaker, cache `NEWS_CACHE_TTL_SECONDS`, log pengambilan — biaya yang sama dengan panggilan penyedia lain; ticker tak dikenal tidak pernah sampai ke vendor.

## Penyimpanan dan dedup

`NewsArticle(externalId unik, titleHash, title, source, url, publishedAt, fetchedAt, symbols[], events[])`. Dedup dua lapis: id penyedia **dan** hash judul ternormalisasi (huruf kecil, tanpa tanda baca/aksen) — judul yang sama dari dua outlet disimpan sekali; pengambilan ulang hanya bisa menambah saham ke `symbols`. Item tanpa judul berarti, tanpa id, atau bertanggal masa depan (> 1 jam) dibuang. Retensi `NEWS_RETENTION_DAYS`.

## Kesegaran

Hanya artikel ≤ `NEWS_MAX_AGE_DAYS` yang ditampilkan, maksimal 8, terbaru dulu, masing-masing dengan umur ("3 jam lalu", "kemarin", "5 hari lalu"). Bila penyedia gagal, arsip Indonesian Stock Bot dipakai dan ditandai "arsip"; bila arsip pun kosong, alasan penyedia ditampilkan tanpa judul apa pun.

## Di percakapan

- `berita BBCA`, `news BBCA`, `headline BBCA`, `kabar terbaru BBCA` → kartu berita (`STOCK_NEWS`, perlu kode saham).
- `kenapa BBCA turun?` (`STOCK_QUESTION`) → jawaban analisis seperti biasa, lalu blok terpisah "📰 Berita terkait (judul dari penyedia; bukan penjelasan sebab)" berisi ≤ 3 judul `direct`. Indonesian Stock Bot tetap tidak menyatakan sebab.
- Tautan hanya dirender bila `http(s)`; judul selalu di-escape.

## Konfigurasi

| Env | Bawaan | Arti |
|---|---|---|
| `NEWS_PROVIDER` | `yahoo` | `yahoo` atau `none` |
| `NEWS_MAX_AGE_DAYS` | `14` | Umur maksimal artikel yang ditampilkan |
| `NEWS_CACHE_TTL_SECONDS` | `900` | Cache hasil penyedia per saham |
| `NEWS_RETENTION_DAYS` | `90` | Artikel lebih tua dihapus job retensi |

Metrik: `news_reports_total{origin=provider|archive|none}`; panggilan penyedia terhitung di `provider_requests_total` seperti biasa.

## Pengujian

- Unit: `news-events.spec.ts` (12 pola event, hash judul, pemetaan ticker, relevansi, tautan aman), `news-format.spec.ts` (umur, escape, tautan tak aman, arsip/kosong/tidak tersedia, blok terkait tanpa klaim sebab, kebijakan keluaran), `yahoo-news.provider.spec.ts` (normalisasi respons Yahoo).
- Integrasi: `test/integration/news.spec.ts` — kartu dari fixture; dedup lintas pengambilan (id dan judul); kesegaran; penyedia gagal → arsip; tanpa apa pun → alasan; ticker tak dikenal tidak menyentuh penyedia; `kenapa TSTA turun?` menambah blok terkait dan **prompt model tidak memuat judul**; `NEWS_PROVIDER=none` jujur.
