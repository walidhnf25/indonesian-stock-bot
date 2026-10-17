# Antrean kerja dengan BullMQ

Aktif hanya bila `REDIS_URL` diisi. Tanpa Redis, setiap pemakai antrean memakai jalur dalam proses yang sudah ada (timer interval, pengiriman langsung), jadi
perilaku bot tanpa Redis **tidak berubah** oleh tahap ini.

## Antrean

| Antrean | Pekerjaan | Pemroses | Konkurensi | Retry | Timeout |
|---|---|---|---|---|---|
| `alerts` | `alert-check` (berulang setiap `ALERT_CHECK_INTERVAL_SECONDS`) | `SchedulerService.tick()` (menghormati jam bursa dan tidak tumpang tindih) | 1 | tidak (tick berikutnya) | 5 menit |
| `maintenance` | `retention` (berulang setiap `RETENTION_INTERVAL_HOURS`) | `RetentionService.runSafely()` | 1 | tidak | 10 menit |
| `notifications` | `send` `{chatId, html}` | `NotifierService` (memvalidasi payload, lalu Telegram) | 2 | 5 percobaan, backoff eksponensial dari 5 dtk (job yang **ditolak validasi tidak di-retry**) | 30 dtk |

Pengiriman **alert yang terpicu** sengaja **tidak** lewat antrean: desain *at-most-once* (klaim `TRIGGERED` lalu kirim; gagal sementara → `reactivate` di bawah kunci)
tetap berlaku dan teruji. Antrean `notifications` dipakai untuk pesan proaktif lain yang boleh diulang (pemberitahuan pemilik saat alert tidak bisa diaktifkan
kembali, pemberitahuan grup yang tidak bisa dihubungi). Kunci idempotensi (`jobId`) mencegah pesan yang sama diantrekan dua kali selama belum selesai.

## Payload antrean adalah masukan tidak tepercaya

Job `notifications` disimpan di Redis; siapa pun yang bisa menulis ke Redis bisa menulis job apa saja. Karena itu **pemroses (konsumen)** memvalidasi setiap job saat
runtime — tipe TypeScript produsen tidak membuktikan apa-apa (`src/notifier/notification-payload.ts`, `NotifierService.onModuleInit`):

| Pemeriksaan | Aturan |
|---|---|
| Bentuk | objek biasa dengan **hanya** `chatId`, `html`, (`correlationId` ≤ 100 karakter); properti lain ditolak (`unexpected_field`, termasuk `__proto__`) |
| `chatId` | bilangan bulat aman **positif** (id chat pribadi); string, pecahan, nol, negatif (grup/kanal) ditolak |
| `html` | string, tidak kosong, ≤ **4096** karakter (batas Telegram) (diperiksa sebelum dipindai, jadi 5 MB tidak membebani CPU) |
| Markup | hanya himpunan bagian HTML Telegram yang dipakai Indonesian Stock Bot: `b strong i em u ins s strike del code pre` tanpa atribut, (**tanpa tautan**: pemberitahuan Indonesian Stock Bot yang diantrekan tidak pernah memuat `<a>`, sehingga penulis Redis tidak bisa mengirim URL phishing lewat bot); `<`, `>`, `&` harus di-escape; tag harus seimbang dan tidak bersarang > 6; tanpa karakter kontrol; `javascript:`/`data:`/`tg:` ditolak |
| Penerima | harus pengguna yang **dikenal** (`User.telegramId` atau `chatId` = `chatId` job) dan masih **diizinkan** oleh `AccessService`; grup tidak pernah menerima notifikasi lewat antrean |

Job yang ditolak **gagal sekali** (`UnrecoverableError`, tanpa retry), payload-nya **diganti** `{rejected: <kode>}` agar muatan berbahaya (mis. 5 MB) tidak tinggal di set
`failed` selama 7 hari, dan hanya **kode alasan** yang dicatat (`NOTIFICATION_REJECTED`) dan dihitung (`notifications_rejected_total{reason}`) — payload tidak pernah masuk log.
Produsen (`NotifierService.notify`) menerapkan pemeriksaan yang sama: pemberitahuan yang cacat dicatat dan tidak diantrekan. Job sah dan kegagalan pengiriman sementara
tetap di-retry seperti sebelumnya.

Redis sendiri: dipublikasikan hanya ke `127.0.0.1`; `REDIS_PASSWORD` (compose) mewajibkan sandi dan `REDIS_URL` harus membawanya; validasi env **menolak** `REDIS_URL`
non-loopback tanpa sandi kecuali `REDIS_ALLOW_UNAUTHENTICATED=true`. Kebijakan eviction adalah `noeviction` (BullMQ mewajibkannya; `allkeys-lru` bisa membuang status antrean).

## Jaminan tiap antrean

- Konkurensi pekerja terbatas; **timeout per job** (job yang melewati batas gagal dan kuncinya dilepas); `lockDuration` ≥ timeout.
- Retry dengan **backoff eksponensial** hanya untuk `notifications`; job berulang tidak di-retry (berjalan lagi pada jadwal berikutnya).
- **Dead letter**: job yang gagal pada percobaan terakhir tetap di set `failed` antrean (maks 1000 / 7 hari) dan dicatat `JOB_FAILED` dengan `correlationId`.
- Pembersihan: job selesai disimpan maks 200 / 24 jam.
- **Idempotensi**: `jobId` (notifikasi) dan satu jadwal per nama job (job berulang di-upsert; jadwal lama dengan interval berbeda dihapus).
- Metrik: `queue_jobs_total{queue,outcome=enqueued|completed|retried|failed}`, `queue_job_ms_total{queue}`, gauge `queue_waiting|queue_active|queue_failed{queue}` (disegarkan tiap 15 dtk).
- **Graceful shutdown**: pekerja menyelesaikan job yang sedang dipegang lalu koneksi ditutup.

## Peran proses (`BOT_ROLE`)

| Nilai | Telegram | REST (lokal) | Pekerja antrean | Catatan |
|---|---|---|---|---|
| `all` (bawaan) | ya | ya | ya | satu proses, seperti sebelumnya |
| `gateway` | ya | ya | tidak | butuh `REDIS_URL` (tanpanya tidak ada yang mengevaluasi alert); validasi env menolak |
| `worker` | **tidak** (polling hanya boleh di satu proses) | ya (health/metrics) | ya | |

Koneksi BullMQ dibuat sendiri dari `REDIS_URL` (BullMQ mewajibkan `maxRetriesPerRequest: null`), terpisah dari klien `RedisService`, dengan awalan kunci
`<REDIS_KEY_PREFIX>bull`.

## Pengujian

`test/integration/queues.spec.ts` (Redis database 3, dilewati dengan peringatan bila Redis tidak terjangkau): job diproses; pemroses yang gagal di-retry dengan
backoff lalu masuk `failed` setelah percobaan terakhir; `jobId` yang sama tidak dijalankan dua kali; job berulang berjalan berkali-kali; timeout job melepas pekerja;
metrik; shutdown bersih; mode nonaktif tanpa Redis.
