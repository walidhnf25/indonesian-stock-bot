# Fundamental

## Prinsip: setiap angka membawa asal-usulnya

| Status | Arti | Tampilan |
|---|---|---|
| `reported` | dilaporkan provider sebagai angka historis/trailing | tanpa tanda |
| `estimated` | perkiraan analis dari provider (PER forward, EPS forward) | `(estimasi)` |
| `derived` | dihitung Indonesian Stock Bot dari angka **reported** lain dengan identitas baku | `(turunan)` |
| `stale` | dari snapshot tersimpan karena provider tidak tersedia, dan snapshot lebih tua dari `FUNDAMENTALS_STALE_DAYS` | `(basi)` + peringatan di kepala |
| `missing` | tidak ada dari provider dan tidak bisa diturunkan | disebut eksplisit di baris "Tidak tersedia: …" |

Tidak ada angka yang direka: metrik tanpa sumber tetap `missing`. Turunan hanya memakai masukan `reported` (tidak pernah estimasi, tidak pernah turunan lain) dan menolak masukan tak masuk akal (EPS ≤ 0, harga ≤ 0, ekuitas ≤ 0, pendapatan ≤ 0):

```text
PER            = harga / EPS trailing
PBV            = harga / nilai buku per lembar
dividend yield = dividen per lembar / harga
margin bersih  = laba bersih / pendapatan
DER            = total utang / ekuitas
ROE            = laba bersih / ekuitas
```

## Metrik

Valuasi: kapitalisasi pasar, PER, PER forward, PBV, EPS, EPS forward, dividend yield. Profitabilitas: pendapatan, laba bersih, margin bersih, ROE. Utang: total utang, DER. Pertumbuhan: pertumbuhan pendapatan, pertumbuhan laba. (`src/fundamentals/fundamentals.types.ts`)

Penyedia Yahoo memetakan `quote` + `quoteSummary(summaryDetail, defaultKeyStatistics, financialData)`; angka pecahan (ROE, margin, pertumbuhan, dividend yield dari `summaryDetail`) dikonversi ke persen. Penyedia lain cukup mengisi `Fundamentals` (semua kolom opsional selain delapan kolom lama).

## Alur

```text
fundamental BBCA
  → StockService.getFundamentals (gerbang keberadaan ticker, kuota, breaker, cache 1 jam)
  → sukses: deriveFields(raw, harga) → simpan FundamentalSnapshot (1 per saham per hari, UTC) → kartu
  → gagal : snapshot terakhir → umur > FUNDAMENTALS_STALE_DAYS ? semua nilai 'stale' : nilai apa adanya, berlabel tanggal
  → tidak ada keduanya: "belum tersedia" (tanpa angka)
```

`bandingkan fundamental BBCA BBRI` menyandingkan metrik yang sama; nilai yang tidak ada ditampilkan `–`, bukan angka. Kedua jalur deterministik: model bahasa tidak terlibat. Konteks AI untuk analisis tetap menerima objek `Fundamentals` mentah seperti sebelumnya (kolom baru ikut, tetap hanya dipakai untuk memilih klaim).

## Konfigurasi dan retensi

| Env | Bawaan | Arti |
|---|---|---|
| `FUNDAMENTALS_STALE_DAYS` | `7` | Umur snapshot (hari) yang membuat nilai dari snapshot ditandai basi |
| `FUNDAMENTAL_SNAPSHOT_RETENTION_DAYS` | `400` | Snapshot lebih tua dari ini dihapus oleh job retensi |

Migrasi `20261004240000_fundamental_snapshot` (`FundamentalSnapshot(stockId, day, asOf, source, data JSONB)`, unik per `stockId+day`, cascade dari `Stock`).

## Metrik observabilitas

`fundamentals_reports_total{origin=provider|snapshot|snapshot_stale|none}`.

## Pengujian

- Unit: `src/fundamentals/derive.spec.ts` (asal-usul, enam turunan, tidak menimpa angka yang dilaporkan, tidak menurunkan dari estimasi, menolak masukan tak masuk akal, `markStale`), `fundamentals-format.spec.ts` (tanda per nilai, daftar yang hilang, snapshot segar vs basi, kartu kosong, kebijakan keluaran, tabel perbandingan), `yahoo-normalizer.spec.ts` (kolom baru).
- Integrasi: `test/integration/fundamentals.spec.ts` — reported/estimated/derived/missing dari fixture; satu snapshot per hari; provider gagal → snapshot bertanggal; snapshot tua → basi; tanpa data → tanpa angka; perbandingan; ticker tak dikenal tidak menyentuh provider maupun tabel.
