# Operasi dan pengerasan produksi

## Komponen

| Komponen | Cara jalan | Status/probe |
|---|---|---|
| PostgreSQL 16 + pgvector | `docker compose up -d postgres` (image lokal `indonesian-stock-bot-postgres:16-pgvector`, volume `ai-stock-indonesia_postgres_data`, hanya `127.0.0.1:5436`) | healthcheck compose (`pg_isready`), `GET /ready` |
| Redis 7 | `docker compose up -d redis` (`127.0.0.1:6380`, `maxmemory 256mb noeviction`, tanpa persistensi — hanya status sementara) | healthcheck compose, `GET /health`.redis |
| Indonesian Stock Bot (Node) | `npm run build && npm run start:prod`; `BOT_ROLE=all|gateway|worker` | `GET /live`, `GET /ready`, `GET /health`, `GET /metrics` |
| Ollama | layanan terpisah (`OLLAMA_BASE_URL`) | `GET /health`.ai; mode terdegradasi deterministik bila mati |

Batas sumber daya compose: `postgres` 1 GiB / 1 CPU, `redis` 320 MiB / 0.5 CPU (`mem_limit` + `cpus`); batas proses Node ditetapkan oleh supervisor (systemd/pm2) — lihat README.

**Batas yang dideklarasikan belum tentu batas yang aktif.** Batas di `docker-compose.yml` baru berlaku setelah kontainer **dibuat ulang**; kontainer lama tetap
`Memory=0` / `NanoCpus=0` (tak terbatas) walau berkasnya benar. Periksa dengan `npm run docker:verify` (membandingkan deklarasi compose dengan `docker inspect`; kode
keluar 0 = aktif, 1 = selisih/tidak berjalan). Terapkan dengan `docker compose up -d` — hanya kontainer yang konfigurasinya berubah dibuat ulang, **volume tetap** (jangan pernah
`down -v`). Urutan aman: `sh scripts/backup-db.sh before-recreate` → `docker compose up -d` → `npm run docker:verify` → `prisma migrate status` → bandingkan jumlah baris.

## Rahasia

- Semua rahasia di `.env` (git-ignored, `.env.*` juga; hanya `.env.example` yang dilacak). Tidak pernah dicetak ke log, tidak pernah dimasukkan ke metrik atau pesan.
- Rotasi token Telegram: ganti `TELEGRAM_BOT_TOKEN`, restart proses; token lama dicabut di BotFather.
- Kredensial DB: `POSTGRES_PASSWORD` di `.env` + `DATABASE_URL`; mengganti keduanya + `ALTER USER` lalu restart.

## Backup dan pemulihan

- **Sebelum setiap migrasi dan setiap perubahan image DB**: `sh scripts/backup-db.sh pre-<label>` → `backups/ai_stock-pre-<label>-<stamp>.sql.gpg` (+ `.sha256`). **Terenkripsi** (GnuPG AES-256) karena berisi data pengguna; skrip meminta passphrase (atau `BACKUP_PASSPHRASE_FILE`, berkas di luar repo), lalu membaca balik hasilnya (dekripsi di memori, dump harus lengkap) dan membuang cadangan yang tidak lolos. Git-ignored. **Salin satu ke luar mesin ini**, dan simpan passphrase terpisah di pengelola kata sandi: tanpa passphrase cadangan tidak bisa dipulihkan siapa pun. Opt-out plaintext hanya dengan `BACKUP_ALLOW_PLAINTEXT=1` (tidak disarankan).
- Jadwal rutin: lihat **Jadwal otomatis di VPS** di bawah. RPO = interval backup; RTO ≈ waktu restore (menit untuk basis data ini).
- **Rotasi**: `scripts/backup-db.sh` menyimpan `BACKUP_KEEP` cadangan terbaru (bawaan 30) **per label**, setelah cadangan baru ditulis dan terverifikasi; `0` mematikannya. Label terpisah = kelompok terpisah, jadi cron harian (`daily`) tidak menghapus cadangan manual seperti `pre-<migrasi>`. Hanya berkas dengan pola nama yang tepat (label + cap waktu) beserta `.sha256`-nya yang disentuh.
- **Latihan restore** (wajib sebelum mengandalkan backup): `sh scripts/restore-rehearsal.sh backups/<dump>.sql.gpg` (tanpa argumen = cadangan terbaru) — memeriksa checksum dan dekripsi, memulihkan ke kontainer sekali pakai (dekripsi di memori, tanpa berkas plaintext), menjalankan `prisma migrate deploy`, mencetak jumlah baris, lalu menghapus kontainer. Tidak pernah menyentuh `ai_stock`.
- **Pemulihan bencana** (volume hilang): `docker compose up -d postgres` (volume baru) → `gpg --decrypt backups/<dump terbaru>.sql.gpg | docker exec -i ai-stock-postgres psql -U postgres -d ai_stock` (dump lama berformat `.sql` plaintext: `... psql ... < backups/<dump>.sql`) → `npx prisma migrate deploy` → `GET /ready` harus `ready: true`. Korpus RAG di-ingest ulang otomatis saat boot; cache dan kuota (Redis) hilang tanpa dampak.
- **Dump lama yang masih plaintext** (`backups/*.sql` dari sebelum 2026-10-16): `sh scripts/encrypt-existing-backups.sh` membuat salinan terenkripsi yang diverifikasi (byte-identik) dan **tidak menghapus apa pun**; setelah kamu memeriksa salinannya dengan latihan restore, hapus yang plaintext sendiri (perintah `rm` dicetak di akhir). Perintah backup/restore dijalankan dari terminal Git Bash di Windows.

### Jadwal otomatis di VPS

Untuk server Linux dengan Docker. Diuji di kontainer Linux (`sh` busybox tanpa bash, database nyata) pada 2026-10-16: cadangan terenkripsi, rotasi, kunci anti-tumpang-tindih, kegagalan tanpa passphrase. **Belum** diuji di VPS sungguhan dengan daemon cron-nya sendiri, dan job `rehearsal` (butuh Node untuk `prisma`) belum diuji di Linux.

- Prasyarat: Docker, GnuPG (`apt install gnupg`), pengguna cron di grup `docker`, kode dari `git clone` (LF terjamin oleh `.gitattributes`; salinan zip/scp dari Windows bisa membawa CRLF), image DB sudah dibangun (`docker compose build postgres`).
- Cron tidak punya terminal: passphrase dari berkas di luar repo, hanya bisa dibaca pemilik: `install -m 600 /dev/null ~/.indonesian-stock-bot-backup-passphrase`, isi baris pertama dengan passphrase, dan simpan passphrase yang sama di pengelola kata sandi, **terpisah dari server**.
- `crontab -e`:

```cron
BACKUP_PASSPHRASE_FILE=/home/deploy/.indonesian-stock-bot-backup-passphrase
BACKUP_KEEP=30
MAILTO=kamu@contoh.com
17 3 * * * /opt/indonesian-stock-bot/scripts/cron-job.sh backup
43 4 * * 0 /opt/indonesian-stock-bot/scripts/cron-job.sh rehearsal
```

- `scripts/cron-job.sh`: satu proses per job (kunci `backups/.cron-<job>.lock`, kunci >6 jam dianggap sisa), PATH minimal, log di `logs/backup-cron.log` (UTC, dipangkas di atas ±1 MB, tanpa rahasia), kode keluar = kode keluar skrip. Tanpa `BACKUP_PASSPHRASE_FILE` ia gagal dengan kode 1, bukan menulis cadangan kosong.
- Uji sekali manual: `BACKUP_PASSPHRASE_FILE=~/.indonesian-stock-bot-backup-passphrase /opt/indonesian-stock-bot/scripts/cron-job.sh backup` lalu `tail logs/backup-cron.log`.
- **Salinan keluar server belum otomatis.** Cadangan yang hanya ada di VPS ikut hilang bila VPS hilang. Berkas `.sql.gpg` sudah terenkripsi sehingga aman disalin, misalnya dengan `rclone copy backups remote:indonesian-stock-bot --include "ai_stock-daily-*.sql.gpg*" --max-age 2d` (contoh, belum diuji).
- Hanya untuk PostgreSQL di kontainer lokal (`docker exec`). Untuk database terkelola, skrip perlu diganti dengan `pg_dump` lewat jaringan, dan server tujuan restore harus mendukung ekstensi `vector`.

## Deploy ke VPS (Docker)

Satu server Linux dengan Docker menjalankan PostgreSQL (image pgvector) dan bot dari `docker-compose.yml`. Telegram memakai long polling: **tidak ada port yang dibuka ke luar**, tidak butuh domain atau sertifikat. Redis tidak dipakai (satu instans berjalan dengan implementasi dalam proses; lihat `docs/redis.md` bila nanti butuh banyak instans).

**Status pengujian (jujur):** diuji 2026-10-16 di Docker Desktop (laptop), pada tumpukan terpisah dengan **token Telegram palsu**. Terbukti: image terbangun, 12 migrasi berjalan dari database kosong, `/ready` 200, RAG/pgvector bekerja (31 dokumen ter-embed), crash dipulihkan otomatis (`kill -9`), penghentian rapi, data bertahan setelah `down`/`up`, migrasi kedua tanpa perubahan, bot tetap hidup tanpa Ollama (`degraded`). **Belum terbukti:** polling dengan token asli di dalam kontainer, jalur Ollama di host Linux, dan semuanya di VPS sungguhan.

1. **Server**: Debian/Ubuntu, `apt install -y git gnupg`, Docker Engine + Compose plugin (petunjuk resmi), pengguna di grup `docker`, `sudo systemctl enable docker`, `ufw allow OpenSSH` lalu `ufw enable`. Jangan menambahkan `ports:` ke layanan `app`.
2. **Kode dan konfigurasi**: `git clone`, `cp .env.example .env && chmod 600 .env`, lalu isi: `POSTGRES_PASSWORD` (kuat, **huruf dan angka saja**, **sebelum start pertama** karena database mengingat kata sandi pertamanya; bawaan `postgres` hanya cocok untuk laptop), `TELEGRAM_BOT_TOKEN` (disarankan token baru untuk server), dan `TELEGRAM_ACCESS_MODE` + `TELEGRAM_ALLOWED_USER_IDS` (bawaan `allowlist` menolak start bila daftar kosong; mode publik harus dipilih eksplisit).
3. **Nyalakan**: `docker compose --profile app up -d --build`. Build pertama juga membangun image PostgreSQL dengan pgvector dari sumbernya (beberapa menit). Urutannya otomatis: database sehat, `migrate` (`prisma migrate deploy`), lalu bot. Profil `app` membuat `docker compose up -d` di laptop **tidak** ikut menyalakan bot kedua.
4. **Cek**: `docker compose --profile app ps` (postgres dan app `healthy`, migrate `exited (0)`); `docker compose logs -f app`; dari dalam kontainer: `docker compose exec app node -e "fetch('http://127.0.0.1:3000/ready').then(async r=>console.log(r.status, await r.text()))"`.
5. **Variabel khusus kontainer**: layanan `app` membaca `.env` sebagai konfigurasi aplikasi, lalu menimpa yang bergantung alamat: `DATABASE_URL` (jaringan Docker), `REDIS_URL` dari `APP_REDIS_URL` (kosong = tanpa Redis), `OLLAMA_BASE_URL` dari `APP_OLLAMA_BASE_URL` (bawaan `http://host.docker.internal:11434`), serta `HOST=127.0.0.1`, `PORT=3000`, `NODE_ENV=production`. Karena itu `REDIS_URL`/`OLLAMA_BASE_URL` untuk laptop di `.env` tidak ikut terbawa. Di Linux, Ollama yang hanya mendengarkan `127.0.0.1` tidak terjangkau dari kontainer (**belum diuji**): buat Ollama mendengarkan di alamat jembatan Docker dan jangan buka port 11434 ke internet. Untuk memakai Gemini/OpenAI cukup isi kuncinya di `.env`.
6. **Pembaruan**: `sh scripts/backup-db.sh pre-update`, `git pull`, `docker compose --profile app up -d --build` (migrasi baru jalan otomatis sebelum bot). Kembali ke versi lama: `git checkout <commit>` lalu perintah yang sama; migrasi tidak dibatalkan (pulihkan cadangan, lihat Migrasi dan rollback).
7. **Sehari-hari**: log `docker compose logs -f app` (dirotasi: 5 × 10 MB); mulai ulang `docker compose restart app`; hentikan semuanya `docker compose --profile app down` (volume tetap; **jangan** `down -v`, itu menghapus database). `restart: unless-stopped` menyalakan ulang setelah reboot atau crash.
8. **Cadangan**: bagian "Jadwal otomatis di VPS" di atas; buat cadangan pertama dan latihan restore sebelum mengandalkan server.

Pengerasan kontainer: pengguna non-root, sistem berkas root read-only (hanya `/tmp`), semua capability dibuang, `no-new-privileges`, batas memori 1 GB, tidak ada port terbuka, tidak ada rahasia di dalam image (`.dockerignore` mengeluarkan `.env*`). Penghentian rapi berakhir dengan kode keluar 143 (SIGTERM), itu normal. Batasan: satu instans per token Telegram (jangan jalankan bot yang sama di laptop dan server), image ±0,85 GB, log `/ready` dari healthcheck muncul tiap 30 detik, database terkelola belum didukung skrip cadangan.

## Migrasi dan rollback

1. `sh scripts/backup-db.sh pre-<migrasi>`
2. (opsional, disarankan) `sh scripts/restore-rehearsal.sh backups/<dump>.sql.gpg` — membuktikan migrasi berjalan di atas data nyata.
3. `npx prisma migrate deploy`; verifikasi `GET /ready` (`migrations: ok`, `pendingMigrations: []`).
4. **Rollback** = pulihkan dump pra-migrasi: hentikan Indonesian Stock Bot → `psql -c 'DROP DATABASE ai_stock'`/buat ulang → restore dump → jalankan versi kode sebelumnya. Migrasi Indonesian Stock Bot bersifat aditif (kolom/tabel/enum baru, backfill) sehingga kode lama tetap berjalan di skema baru; rollback kode tanpa rollback skema umumnya cukup.
5. Perubahan image DB (mis. pgvector): backup → `docker compose build postgres` → `docker compose up -d postgres` (volume sama, basis alpine sama) → bandingkan jumlah baris → baru migrasi (`docs/rag.md`).

## Pemantauan

- `GET /live`: proses hidup, p99 jeda event loop, RSS. `GET /ready`: DB, migrasi, Redis, antrean → 503 bila belum siap. `GET /health`: ringkasan dependensi (503 hanya bila PostgreSQL mati).
- `GET /metrics` (Prometheus, lokal): permintaan chat (jumlah, latensi per intent), panggilan/kesalahan/kuota penyedia, cache, antrean (kedalaman, latensi, sukses/gagal), AI (latensi, hasil), RAG (latensi, kualitas hit), alert (evaluasi, pengiriman), Telegram (kesalahan), DB/Redis (latensi ping). Tidak ada id pengguna di label.
- Log terstruktur JSON per permintaan dengan `reqId` (acak, bukan identitas) untuk korelasi; `LOG_LEVEL`.
- Alarm yang disarankan: `/ready` 503 > 1 menit; `provider_throttled_total{reason=breaker_open}` naik; `queue_failed` > 0; `chat_requests_total{status=error}` > 1 %/5 menit; `redis_connected` 0 saat Redis dikonfigurasi.

## Catatan kinerja I/O (Docker Desktop)

Pada Docker Desktop (Windows/WSL2) `COMMIT` sesekali menunggu `WALSync` ~2 detik (fsync volume). Dampaknya: transaksi tulis tertahan dan, lewat rantai kunci/pool koneksi, pembaca yang bersamaan ikut tertahan. Mitigasi di kode: tulis latar belakang untuk snapshot fundamental dan arsip berita, tidak ada `UPDATE` pada baris `Stock` bila nama tak berubah, dedup panggilan penyedia identik yang bersamaan. Untuk basis data **uji** (sekali pakai) `ALTER DATABASE ai_stock_test SET synchronous_commit = off` menghilangkan tunggu WAL; **jangan** lakukan pada `ai_stock` (durabilitas). Di produksi gunakan volume dengan fsync cepat (disk lokal, bukan bind mount Windows).

## Kapasitas

Bot publik: kuota per pengguna (pesan/menit, AI/menit), anggaran global penyedia per jam, antrean AI terbatas (`AI_MAX_QUEUE_DEPTH`), gerbang pengirim Telegram. Uji beban: `npm run test:load` (lihat `docs/load-tests.md`).
