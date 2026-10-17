# Alert

## Jenis

| Jenis | Contoh kalimat | Nilai |
|---|---|---|
| `PRICE_ABOVE` / `PRICE_BELOW` | `ingatkan saya kalau BBCA di atas 8500` | harga |
| `RSI_ABOVE` / `RSI_BELOW` | `alert kalau RSI BBCA di bawah 30` | 0–100 |
| `VOLUME_MULTIPLIER` | `kasih tahu kalau volume BBCA lebih dari 2x rata-rata` | pengali ≥ 1 |
| `MA_CROSS_ABOVE` / `MA_CROSS_BELOW` | `ingatkan kalau BBCA golden cross`, `alert BBCA death cross`, `MA20 BBCA memotong MA50 ke bawah` | tidak ada (0) |

Crossover dihitung deterministik dari candle harian: selisih MA20 − MA50 pada sesi terakhir dan sesi sebelumnya (`computeTechnical` pada dua irisan candle yang
sama). Alert hanya terpicu pada **sesi tempat tanda selisih berubah**; MA20 yang sudah lama di atas MA50 tidak memicu apa pun. Butuh ≥ 52 candle.

## Siklus hidup

```text
ACTIVE ──(kondisi terpenuhi, diklaim)──▶ TRIGGERED ──(terkirim)──▶ deliveredAt diisi
  │  ▲                                        │
  │  └─(reactivate, gagal sementara)──────────┘        (gagal permanen) ──▶ DISABLED + deliveryError
  ├─(jeda alert)──▶ PAUSED ──(lanjutkan alert)──▶ ACTIVE
  ├─(hapus alert)──▶ DISABLED
  └─(ALERT_TTL_DAYS lewat)──▶ EXPIRED (pemilik diberi tahu sekali)
```

- **Sekali pakai**: alert yang terpicu selesai (tidak ada *cooldown*, karena tidak ada pemicu ulang); buat lagi bila masih perlu. Klaim `ACTIVE → TRIGGERED` atomik
  sebelum pengiriman (*at-most-once*; tidak pernah terkirim dua kali walau proses tumpang tindih).
- **PAUSED** (`jeda alert 1`, `pause alert BBCA`, `hentikan sementara alert nomor 2`): tidak dievaluasi, **tetap memegang `activeKey`** sehingga alert identik tidak bisa
  dibuat, dan **tetap dihitung** dalam batas 20. `lanjutkan alert …` / `aktifkan lagi alert …` mengembalikannya ke ACTIVE.
- **EXPIRED**: `expiresAt = dibuat + ALERT_TTL_DAYS` (bawaan 90). Pada tiap pengecekan, alert ACTIVE/PAUSED yang lewat waktu diubah jadi EXPIRED, kuncinya dilepas, dan
  pemilik diberi tahu satu kali lewat antrean notifikasi (`alert-expired:<id>` sebagai kunci dedup). Alert yang ada sebelum migrasi mendapat 90 hari sejak migrasi.
- **Pelacakan pengiriman**: `deliveredAt` saat terkirim; `deliveryError` (pesan tersensor, ≤ 200 karakter) saat chat menolak permanen (403/blokir) dan alert dinonaktifkan.
- Retensi menghapus TRIGGERED/DISABLED/EXPIRED yang lebih tua dari `ALERT_HISTORY_RETENTION_DAYS`; ACTIVE dan PAUSED tidak pernah dihapus.

## Keamanan data (tidak berubah)

Alert hanya dievaluasi dengan kutipan **tepercaya** yang punya acuan penutupan tersimpan; data basi, mencurigakan, atau tidak valid dilewati dan dicatat. Alert
indikator (RSI, volume, crossover) juga menuntut riwayat yang tidak basi. Alert dikirim ke chat tempat ia dibuat; di grup pemiliknya ditampilkan hanya sebagai
`@username` yang valid.

## Perintah yang mengubah data

`ALERT_CREATE`, `ALERT_DELETE`, `ALERT_PAUSE`, `ALERT_RESUME` hanya datang dari parser deterministik; classifier AI tidak bisa menghasilkannya (`STATE_CHANGING`).

## Evaluasi

Dengan Redis: job berulang `alert-check` di antrean `alerts` (satu jadwal, satu pekerja, satu run); tanpa Redis: timer dalam proses. Interval `ALERT_CHECK_INTERVAL_SECONDS`,
hanya saat bursa buka kecuali `ALERT_CHECK_WHEN_CLOSED=true`.

## Pengujian

`test/integration/alert-lifecycle.spec.ts`: jeda/lanjut (tidak dievaluasi saat dijeda, kunci dan slot dipertahankan, terpicu setelah dilanjutkan, `deliveredAt`);
dijeda dihitung ke batas; dari chat; kedaluwarsa (EXPIRED, kunci lepas, satu pemberitahuan, bisa dibuat ulang); golden/death cross memicu hanya pada sesi persilangan;
tren panjang tanpa persilangan tidak memicu; pembuatan dari bahasa alami; pengiriman gagal permanen mencatat `deliveryError`. Parser: `advice-and-concept-routing.spec.ts`.
