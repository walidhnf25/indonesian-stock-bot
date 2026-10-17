# Konteks, memori, preferensi, dan penghapusan data

## Prinsip

- **Tanpa transkrip.** Indonesian Stock Bot tidak pernah menyimpan isi pesan. Yang disimpan hanya *apa yang dicari*: kode saham dan jenis permintaan, beserta waktunya.
- **Per pengguna DAN per chat.** Apa yang dicari di chat pribadi tidak pernah muncul di grup; konteks grup hanya berisi pencarian pengguna itu di grup itu.
- **Semua fitur memori hanya di chat pribadi.** Di grup, perintah konteks/preferensi/penghapusan dijawab dengan penolakan tetap.
- **AI tidak pernah mengubah memori.** `CONTEXT_CLEAR`, `PREFERENCE_SET`, `PREFERENCE_CLEAR`, `DATA_DELETE` ada di `STATE_CHANGING`: hanya parser deterministik yang bisa menghasilkannya; hasil classifier AI untuk intent ini diturunkan ke UNKNOWN. `CONTEXT_RECALL`/`PREFERENCE_VIEW` hanya membaca data pengguna sendiri dan tidak membawa parameter.
- **PostgreSQL adalah sumber kebenaran**; Redis tidak dipakai untuk memori.

## Lapisan

| Lapisan | Isi | Umur | Cara melihat / mengubah |
|---|---|---|---|
| Konteks segera (`ConversationContext.context`) | `lastSymbols`, `lastIntent`, `recent` (≤ 10 `{symbols, intent, at}`), `deletionRequestedUntil` | `CONTEXT_TTL_MINUTES` (bawaan 30) sejak pesan terakhir; dihapus oleh job retensi dan pembersihan oportunistik | `apa yang tadi saya tanya?`, `saham apa yang terakhir saya cek?`, `riwayat obrolan` → daftar; `lupakan konteks` / `/lupakan` → hapus |
| Preferensi (`User.preferences`, JSONB) | hanya kunci ber-allowlist: `defaultSymbol` | sampai diubah atau data dihapus | `pengaturan saya` / `/pengaturan`; `saham default saya BBCA`; `hapus saham default` |
| Data pengguna lain | watchlist, alert, portofolio, analisis tersimpan | retensi masing-masing (lihat `docs/alerts.md`, `docs/portfolio.md`) | `hapus data saya` |

`readPreferences()` memvalidasi kolom JSON pada **setiap** pembacaan (kunci tak dikenal dibuang, ticker dinormalkan), sehingga kolom yang rusak atau disunting tangan tidak pernah sampai ke handler.

## Saham default

Pertanyaan tanpa kode saham diselesaikan dengan urutan: (1) kode dalam teks, (2) konteks chat (`lastSymbols`), (3) **saham default** pengguna, (4) tanya balik. Saham default hanya dipakai di chat pribadi dan hanya untuk intent baca (`STOCK_QUOTE/HISTORICAL/TECHNICAL/ANALYSIS/QUESTION`, `FOREIGN_FLOW`, `BROKER_SUMMARY`, `FUNDAMENTALS`) — tidak pernah untuk watchlist, alert, atau portofolio, agar sebuah preferensi tidak pernah memicu perubahan data secara diam-diam. Pengisian dari preferensi dicatat di log (`defaultSymbol: true`) dan sumber intent menjadi `context`.

## Penghapusan data (dua langkah)

1. `hapus data saya` (atau `/hapusdata`): bot menjelaskan apa yang akan dihapus dan mencatat permintaan di konteks chat dengan masa berlaku 5 menit.
2. `konfirmasi hapus data saya` (atau `/hapusdata konfirmasi`) dalam 5 menit: `UserDataService.deleteAll()` menghitung lalu menghapus baris `User` dalam **satu transaksi**; semua tabel turunan ikut terhapus lewat `onDelete: Cascade` (watchlist dan isinya, alert, portofolio + holding + transaksi + snapshot, analisis AI, konteks). Data pasar (saham, kutipan, candle) adalah data bersama dan tidak disentuh.

Konfirmasi tanpa permintaan yang menunggu, atau setelah 5 menit, ditolak. Pesan apa pun yang menyebut saham di antara kedua langkah menulis ulang konteks tanpa `deletionRequestedUntil`, sehingga permintaan dibatalkan. Log hanya mencatat jumlah baris (`USER_DATA_DELETED`), bukan identitas. Profil dibuat kembali otomatis pada pesan berikutnya (tanpa preferensi, tanpa konteks).

## Retensi

- Konteks: `expiresAt` per baris; `RetentionService` menghapus yang lewat waktu setiap `RETENTION_INTERVAL_HOURS`, dan `ConversationService` membersihkan oportunistik maksimal tiap 10 menit.
- Preferensi: tidak ada retensi otomatis (milik pengguna sampai dihapus).
- Konfigurasi: `CONTEXT_TTL_MINUTES` (1–1440).

## Yang sengaja tidak dibuat

- Ringkasan/kompresi percakapan oleh AI: butuh transkrip, yang bertentangan dengan prinsip "tanpa transkrip".
- Preferensi gaya jawaban: belum ada kegunaan deterministik yang tidak mengurangi informasi risiko; akan ditambah hanya bila ada.

## Pengujian

- Unit: `src/intent/memory-intents.spec.ts` — frasa → intent, tanpa salah tangkap (pertanyaan saham biasa, "cek harga terakhir BBCA"), `DATA_DELETE` dari AI ditolak, `readPreferences` membuang kunci asing.
- Integrasi: `test/integration/context-memory.spec.ts` — konteks per chat (pribadi vs grup), daftar dan penghapusan konteks, saham default mengisi pertanyaan tanpa kode hanya untuk intent baca dan hanya di chat pribadi, preferensi lihat/ubah/hapus, penghapusan dua langkah (ditolak tanpa permintaan, kedaluwarsa, cascade penuh, profil dibuat ulang), penolakan di grup.
