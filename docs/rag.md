# RAG: basis pengetahuan dan catatan pribadi

## Apa yang dijawab

`GENERAL_QUESTION` (pertanyaan konsep tanpa kode saham) dijawab berurutan: (1) glosarium deterministik (perilaku lama, tidak berubah), (2) **retrieval hibrida** atas korpus pengetahuan Indonesian Stock Bot dan — hanya di chat pribadi — catatan pengguna sendiri, (3) teks fallback tetap. Model bahasa **tidak terlibat**: semua teks yang ditampilkan ditulis aplikasi (`src/knowledge/corpus.ts`, `glossary.ts`) atau ditulis pengguna sendiri, dirender apa adanya dengan HTML di-escape.

Pesan yang tidak dipahami aturan maupun model (`UNKNOWN`, tanpa kode saham) mendapat satu kesempatan terakhir: bila ada chunk korpus/catatan yang **berbagi kata** dengan pesan (hit kanal leksikal), chunk itu ditampilkan alih-alih "saya belum mengerti"; hit yang hanya datang dari kanal vektor sengaja tidak dipakai di sini agar kemiripan samar tidak mengubah pesan acak menjadi ceramah. Parser juga mengenali "apa itu auto rejection?": kata kecil yang kebetulan kode saham (AUTO) dan diikuti kata lain diperlakukan sebagai istilah, bukan kode.

Catatan pribadi (`catat: …`, `catatan saya`, `cari catatan …`, `hapus catatan 2`, `hapus semua catatan`) adalah **satu-satunya** tempat Indonesian Stock Bot menyimpan teks yang ditulis pengguna, atas permintaan eksplisit, maksimal 50 catatan × 500 karakter, hanya di chat pribadi, dan ikut terhapus oleh `hapus data saya`.

## Model data

```text
KnowledgeDocument (id, scope GLOBAL|USER, userId?, source 'corpus'|'note', externalId?, title, content, contentHash)
   └─ KnowledgeChunk (documentId, ordinal, content, embeddingModel?, embedding vector?, search tsvector GENERATED)
```

- Korpus di-ingest saat boot (`RagService.onModuleInit`, latar belakang, idempoten): dokumen ditulis ulang hanya bila `contentHash` berubah; chunk tanpa vektor untuk model embedding aktif di-embed per batch 32. Ingest yang gagal (mis. ekstensi `vector` tidak ada) menonaktifkan retrieval sampai boot berikutnya; glosarium dan fallback tetap bekerja.
- Chunking deterministik (`chunker.ts`): paragraf → kalimat → paket ≤ 700 karakter dengan satu kalimat tumpang tindih; judul dibawa setiap chunk agar chunk pendek tetap membawa kata topiknya.
- `search` tsvector dipelihara PostgreSQL (konfigurasi `simple`, tanpa stemming; pencocokan awalan `:*` untuk kata ≥ 4 huruf menutup imbuhan).
- Kolom `embedding` bertipe `vector` tanpa dimensi tetap agar model berbeda dimensi bisa hidup berdampingan; `embeddingModel` memastikan hanya vektor dari model yang sama yang dibandingkan. Tanpa indeks ANN (korpus ratusan chunk); tambah HNSW pada kolom bertipe tetap bila > ~10k chunk.

## Embedding

`EmbeddingProvider` (`src/rag/embedding.provider.ts`):

| `EMBEDDING_PROVIDER` | Model | Dimensi | Catatan |
|---|---|---|---|
| `hashing` (bawaan) | `hashing-v1-256` | 256 | Deterministik, tanpa dependensi: feature hashing unigram + bigram kata + trigram karakter, L2-normal. Menangkap kemiripan leksikal (imbuhan, salah ketik), bukan makna. Sama di semua mesin → tes stabil. |
| `ollama` | `ollama:<EMBEDDING_MODEL>` via `/api/embed` | `EMBEDDING_DIMENSIONS` | Vektor dengan dimensi salah ditolak sebelum disimpan. Bila Ollama mati: ingest berhenti (dicoba lagi boot berikutnya), query jatuh ke kanal leksikal saja (`rag_embedding_failures_total{stage}`). |

Mengganti model cukup mengubah env: chunk lama di-embed ulang otomatis karena `embeddingModel` berbeda.

## Retrieval hibrida

1. **Otorisasi sebelum peringkat**: filter `d.scope = 'GLOBAL' OR d."userId" = $userId` (atau hanya `USER` milik pengguna untuk `scope: 'notes'`) ada di `WHERE` kedua kanal. Tidak ada penyaringan setelah peringkat, jadi catatan orang lain tidak pernah memengaruhi hasil — bahkan urutannya.
2. Kanal leksikal: kata tanya dan kata sambung dibuang dari query (`queryTerms`: "PER dan PBV itu apa" → `per pbv`; bila tidak tersisa apa pun, kata aslinya dipakai), lalu `to_tsquery('simple', 'kata1:* | kata2 | …')`, `ts_rank_cd`, 20 kandidat. Penyedia `hashing` menerima query yang sama sudah dibersihkan (ia leksikal); model Ollama menerima kalimat utuh.
3. Kanal vektor: `embedding <=> $q::vector` (jarak kosinus), 20 kandidat, hanya `embeddingModel` aktif.
4. Reciprocal rank fusion (k = 60), satu chunk per dokumen, kandidat yang hanya datang dari kanal vektor harus punya kemiripan ≥ `RAG_MIN_SIMILARITY`/100 (bawaan 30).

Query dipotong 300 karakter dan disanitasi; parameter selalu lewat `Prisma.sql` (tidak ada SQL yang dirangkai dari teks pengguna).

## Konfigurasi

| Env | Bawaan | Arti |
|---|---|---|
| `RAG_ENABLED` | `true` | Matikan retrieval sepenuhnya (glosarium tetap) |
| `EMBEDDING_PROVIDER` | `hashing` | `hashing` atau `ollama` |
| `EMBEDDING_MODEL` | – | Nama model Ollama (mis. `nomic-embed-text`); wajib bila `ollama` |
| `EMBEDDING_DIMENSIONS` | `768` | Dimensi model Ollama |
| `EMBEDDING_TIMEOUT_MS` | `20000` | Batas waktu `/api/embed` |
| `RAG_MIN_SIMILARITY` | `30` | Ambang kemiripan (persen) untuk hasil yang hanya ditemukan kanal vektor |

## Basis data

Butuh ekstensi `vector`. `docker/postgres/Dockerfile` membangun pgvector (v0.8.0, `with_llvm=no`) di atas `postgres:16-alpine` yang sama dengan volume data yang ada (tetap musl → kolasi dan indeks teks tidak berubah; `pgvector/pgvector:pg16` berbasis Debian/glibc akan merusak indeks btree pada kolom teks). Peralihan image: backup → `docker compose build postgres` → `docker compose up -d postgres` (volume yang sama) → verifikasi jumlah baris → `prisma migrate deploy` (`20261004230000_rag`, berisi `CREATE EXTENSION IF NOT EXISTS vector`).

## Keamanan

- Teks pengguna (catatan, query) tidak pernah dikirim ke model bahasa dan tidak pernah dirangkai ke SQL.
- `NOTE_ADD/DELETE` ada di `STATE_CHANGING` (hanya parser deterministik); `NOTE_LIST/SEARCH` tanpa parameter dari AI.
- Jawaban korpus membawa disclaimer yang sama dengan glosarium; setiap artikel dan setiap chunk-nya lolos `GENERAL_ANSWER_POLICY` di `corpus.spec.ts`.
- Catatan tidak pernah muncul di grup (pencarian di grup memakai `userId = null`).

## Pengujian

- Unit: `rag-core.spec.ts` (hashing: determinisme, kemiripan, imbuhan; Ollama: dimensi salah ditolak, kegagalan jadi `EmbeddingUnavailableError`; chunker; RRF), `corpus.spec.ts` (kebijakan), `note-parser.spec.ts`.
- Integrasi (`test/integration/rag.spec.ts`, pgvector nyata): ingest idempoten dan re-embed selektif; **golden set 18 pertanyaan, hit@2 ≥ 90 %**; kedua kanal berkontribusi; omong kosong → kosong; isolasi catatan antar pengguna (cocok persis pun tidak bocor, termasuk `scope: 'notes'` dan tanpa pengguna); hapus milik orang lain gagal; batas 50; cascade `hapus data saya`; tidak bocor ke grup; perintah catatan dari chat; glosarium tetap didahulukan; model tidak dipanggil.
