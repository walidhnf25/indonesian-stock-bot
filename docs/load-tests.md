# Uji beban

`npm run test:load` (`test/load/chat-load.spec.ts`, konfigurasi `test/jest-load.json`; **tidak** termasuk gerbang pengujian biasa karena memakan waktu).

## Apa yang diuji

`LOAD_USERS` (bawaan 150) pengguna publik berbeda mengirim `LOAD_MESSAGES` (bawaan 6) pesan masing-masing secara bersamaan ke `ChatService` nyata di atas PostgreSQL nyata, dengan penyedia data fixture dan model palsu (jeda 50 ms) — sehingga angkanya mengukur Indonesian Stock Bot, bukan Yahoo atau Ollama. Campuran: harga, teknikal, analisis AI, perbandingan, alert, portofolio, glosarium, RAG, pertanyaan "kenapa", status bursa.

Konfigurasi sengaja ketat agar kontrol keadilan terlihat bekerja: `AI_MAX_CONCURRENT_REQUESTS=2`, `AI_MAX_QUEUE_DEPTH=4`, kuota data per pengguna 30/menit.

## Yang harus terpenuhi (assertion)

- Tidak ada kesalahan internal yang bocor ke pengguna (`terjadi kendala` / `Layanan penyimpanan`): 0.
- Semua pesan terjawab (tidak ada yang hilang).
- Model adalah sumber daya bersama yang dibatasi: sebagian pengguna **harus** menerima "AI sedang sibuk" dan jumlah panggilan model < jumlah pesan (bukti antrean terbatas, bukan antrean tanpa batas).
- Ekor latensi terbatas: p99 < 30 s (batas waktu permintaan dan antrean AI yang membatasinya).
- Setelah beban, satu permintaan tunggal dijawab < 5 s (proses tidak terkunci).

Ringkasan dicetak sebagai satu baris `LOAD {...}`: throughput/detik, p50/p95/p99/maks, jumlah rate-limit, AI sibuk, throttling penyedia, panggilan penyedia dan model.

## Hasil rujukan

Jalankan `npm run test:load` untuk hasil di mesinmu; angka absolut bergantung mesin — yang dipantau adalah pola (tanpa kesalahan internal, kontrol aktif, ekor terbatas).

## Batas yang disengaja

Uji ini tidak memukul Telegram (tidak pernah dalam tes), Yahoo, maupun Ollama. Beban penyedia nyata dilindungi oleh anggaran global per jam dan breaker (`docs/market-data.md`); beban Ollama oleh antrean AI (`AI_MAX_*`).
