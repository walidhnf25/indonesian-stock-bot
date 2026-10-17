import { GLOSSARY } from './glossary';

/**
 * Application-authored knowledge corpus for the RAG layer. Every article is descriptive
 * Indonesian text about how the IDX and Indonesian Stock Bot work; none contains advice, predictions, guarantees or
 * prices, and every article is run through the AI output policy in the unit tests, exactly like the
 * glossary. The language model never writes or rewrites any of this: retrieval returns these texts
 * verbatim. Figures that the exchange changes from time to time are described as such, not asserted.
 */
export interface CorpusArticle {
  /** Stable id (used as externalId for idempotent ingestion). */
  id: string;
  title: string;
  /** Plain text; paragraphs separated by blank lines. */
  content: string;
  tags: string[];
}

const ARTICLES: CorpusArticle[] = [
  {
    id: 'lot-dan-satuan',
    title: 'Lot, lembar, dan nilai transaksi',
    tags: ['lot', 'lembar', 'satuan', 'nilai transaksi'],
    content: `Di Bursa Efek Indonesia, saham diperdagangkan dalam satuan lot. Satu lot sama dengan 100 lembar saham. Harga yang tampil di papan perdagangan adalah harga per lembar, sehingga nilai satu lot adalah harga per lembar dikalikan 100.

Nilai sebuah transaksi dihitung dari jumlah lot dikali 100 dikali harga per lembar, ditambah biaya transaksi dari perusahaan efek. Indonesian Stock Bot memakai konvensi yang sama: "beli 10 lot BBCA di 9000" dicatat sebagai 1.000 lembar dengan harga 9000 per lembar.

Perdagangan dalam jumlah kurang dari satu lot (odd lot) dilakukan di pasar negosiasi, bukan di pasar reguler, dan harganya bisa berbeda dari harga pasar reguler.`,
  },
  {
    id: 'jam-perdagangan',
    title: 'Jam perdagangan bursa',
    tags: ['jam', 'sesi', 'buka', 'tutup', 'pra-pembukaan', 'pasca-penutupan'],
    content: `Perdagangan di pasar reguler Bursa Efek Indonesia berlangsung dalam dua sesi pada hari kerja, dengan jeda istirahat di antaranya. Secara umum sesi pertama dimulai pukul 09:00 WIB dan sesi kedua berakhir menjelang pukul 16:00 WIB; pada hari Jumat jeda istirahat lebih panjang karena waktu salat Jumat. Sebelum sesi pertama ada periode pra-pembukaan untuk membentuk harga pembukaan, dan setelah sesi kedua ada periode pasca-penutupan.

Jadwal rinci ditetapkan oleh bursa dan dapat berubah, misalnya pada bulan Ramadan atau hari bursa khusus. Bursa tutup pada hari Sabtu, Minggu, dan hari libur bursa.

Indonesian Stock Bot menjawab "jam berapa market buka?" dengan status bursa saat ini dan memakai daftar hari libur yang dikonfigurasi. Di luar jam perdagangan, harga yang ditampilkan adalah harga penutupan sesi terakhir.`,
  },
  {
    id: 'auto-rejection',
    title: 'Auto rejection (ARA dan ARB)',
    tags: ['ara', 'arb', 'auto rejection', 'batas harian'],
    content: `Auto rejection adalah mekanisme bursa yang menolak secara otomatis order dengan harga di luar batas yang ditetapkan untuk satu hari perdagangan. Batas atas disebut auto rejection atas (ARA) dan batas bawah disebut auto rejection bawah (ARB).

Batas dihitung sebagai persentase dari harga acuan (umumnya harga penutupan sebelumnya) dan berbeda menurut rentang harga saham: saham berharga rendah memiliki persentase batas yang lebih besar daripada saham berharga tinggi. Besaran persentase ditetapkan oleh bursa dan telah beberapa kali diubah, sehingga angka pastinya perlu dicek pada peraturan bursa yang berlaku.

Saat sebuah saham menyentuh ARA, order pembelian di atas batas tidak dapat masuk; saat menyentuh ARB, order penjualan di bawah batas tidak dapat masuk. Istilah "mentok ARA" atau "mentok ARB" merujuk pada kondisi ini. Harga yang menyentuh batas menggambarkan kondisi hari itu, bukan arah hari berikutnya.`,
  },
  {
    id: 'fraksi-harga',
    title: 'Fraksi harga (tick size)',
    tags: ['fraksi', 'tick', 'kelipatan harga'],
    content: `Fraksi harga adalah kelipatan terkecil perubahan harga yang diperbolehkan untuk sebuah saham. Fraksi berbeda menurut rentang harga: makin tinggi harga saham, makin besar fraksinya. Dengan aturan yang berlaku beberapa tahun terakhir, saham di bawah 200 rupiah bergerak per 1 poin, 200 sampai di bawah 500 per 2 poin, 500 sampai di bawah 2.000 per 5 poin, 2.000 sampai di bawah 5.000 per 10 poin, dan 5.000 ke atas per 25 poin. Bursa dapat mengubah pembagian ini.

Fraksi memengaruhi seberapa rapat antrian harga di order book. Pada saham berharga rendah, satu fraksi dapat berarti perubahan persentase yang besar; pada saham berharga tinggi, satu fraksi adalah perubahan persentase yang kecil.`,
  },
  {
    id: 'dividen',
    title: 'Dividen: cum date, ex date, dan dividend yield',
    tags: ['dividen', 'cum date', 'ex date', 'recording date', 'yield'],
    content: `Dividen adalah bagian laba perusahaan yang dibagikan kepada pemegang saham, biasanya dalam bentuk tunai per lembar saham dan diputuskan dalam rapat umum pemegang saham. Tanggal-tanggal pentingnya adalah cum date (hari terakhir pembelian saham masih memberi hak dividen), ex date (hari pertama pembelian tidak lagi memberi hak), recording date (tanggal pencatatan pemegang saham yang berhak), dan payment date (tanggal pembayaran).

Pada ex date, harga saham lazimnya menyesuaikan kurang lebih sebesar dividen per lembar, karena nilai tunai tersebut keluar dari perusahaan. Dividend yield adalah dividen per lembar dalam satu tahun dibagi harga saham, dinyatakan dalam persen; angka ini bergantung pada harga saat dihitung dan dividen masa lalu, bukan dividen yang akan datang.

Indonesian Stock Bot menampilkan dividend yield dari data penyedia bila tersedia dan dapat mencatat dividen yang diterima ke dalam catatan portofolio ("dividen BBCA 150000").`,
  },
  {
    id: 'aksi-korporasi',
    title: 'Aksi korporasi: stock split, reverse split, right issue',
    tags: ['stock split', 'reverse split', 'right issue', 'hmetd', 'dilusi'],
    content: `Stock split memecah satu lembar saham menjadi beberapa lembar dengan nilai nominal lebih kecil; jumlah lembar bertambah dan harga per lembar turun secara proporsional, sehingga nilai kepemilikan tidak berubah pada saat pemecahan. Reverse split adalah kebalikannya: beberapa lembar digabung menjadi satu.

Right issue (HMETD, hak memesan efek terlebih dahulu) adalah penerbitan saham baru yang ditawarkan lebih dulu kepada pemegang saham lama dengan rasio dan harga pelaksanaan tertentu. Pemegang saham yang tidak melaksanakan haknya mengalami dilusi, yaitu persentase kepemiliknya mengecil karena jumlah saham beredar bertambah.

Riwayat harga yang ditampilkan Indonesian Stock Bot berasal dari penyedia data yang umumnya sudah menyesuaikan harga lama terhadap stock split; angka sebelum dan sesudah aksi korporasi sebaiknya dibaca dengan memperhatikan penyesuaian tersebut.`,
  },
  {
    id: 'ipo-dan-pencatatan',
    title: 'IPO dan papan pencatatan',
    tags: [
      'ipo',
      'penawaran umum',
      'papan utama',
      'papan pengembangan',
      'papan akselerasi',
      'pemantauan khusus',
    ],
    content: `IPO (initial public offering) adalah penawaran umum perdana saham sebuah perusahaan kepada publik sebelum sahamnya tercatat di bursa. Investor memesan saham pada masa penawaran melalui sistem e-IPO atau perusahaan efek, dan saham mulai diperdagangkan pada tanggal pencatatan.

Saham tercatat pada salah satu papan: papan utama, papan pengembangan, papan akselerasi, atau papan pemantauan khusus. Papan menggambarkan kriteria pencatatan seperti ukuran aset dan masa operasi, bukan kualitas perusahaan. Saham di papan pemantauan khusus diperdagangkan dengan mekanisme berbeda (periodic call auction) karena memenuhi kriteria pemantauan tertentu, misalnya harga sangat rendah atau likuiditas kecil.`,
  },
  {
    id: 'indeks-saham',
    title: 'IHSG dan indeks saham lainnya',
    tags: ['ihsg', 'indeks', 'lq45', 'idx30', 'composite'],
    content: `IHSG (Indeks Harga Saham Gabungan) adalah indeks yang mengukur pergerakan harga seluruh saham tercatat di papan utama dan papan pengembangan, dengan pembobotan berdasarkan kapitalisasi pasar. Karena pembobotan ini, saham berkapitalisasi besar memengaruhi IHSG lebih kuat daripada saham kecil.

Bursa juga menerbitkan indeks lain dengan konstituen terpilih, misalnya LQ45 (45 saham dengan likuiditas tinggi dan kapitalisasi besar) dan IDX30. Konstituen indeks dievaluasi secara berkala, sehingga daftarnya berubah dari waktu ke waktu.

Perubahan indeks dinyatakan dalam poin dan persen. Indeks menggambarkan rata-rata tertimbang, jadi IHSG naik tidak berarti setiap saham naik.`,
  },
  {
    id: 'biaya-transaksi',
    title: 'Biaya transaksi saham',
    tags: ['fee', 'biaya', 'komisi', 'levy', 'pajak'],
    content: `Setiap transaksi saham dikenai biaya. Komponen utamanya adalah komisi perusahaan efek (persentase dari nilai transaksi, berbeda antar perusahaan efek dan sering lebih tinggi untuk transaksi penjualan), biaya bursa dan lembaga kliring serta penyimpanan (levy), PPN atas komisi, dan pajak penghasilan final atas transaksi penjualan sebesar sepersepuluh persen dari nilai transaksi penjualan.

Karena biaya ini, harga pembelian efektif sedikit lebih tinggi dan hasil penjualan efektif sedikit lebih rendah daripada harga di papan. Catatan portofolio Indonesian Stock Bot menerima biaya sebagai angka opsional ("fee 10rb") dan memasukkannya ke harga rata-rata serta laba rugi yang dihitung.`,
  },
  {
    id: 'order-book',
    title: 'Order book, bid, offer, dan spread',
    tags: ['bid', 'offer', 'ask', 'spread', 'antrian', 'order book', 'likuiditas'],
    content: `Order book menampilkan antrian order yang belum terpenuhi: sisi bid berisi order pembelian beserta harga dan jumlah lotnya, sisi offer (ask) berisi order penjualan. Harga bid tertinggi dan harga offer terendah disebut best bid dan best offer; selisih keduanya adalah spread.

Spread yang sempit dan antrian yang tebal menandakan likuiditas tinggi: transaksi besar dapat terjadi tanpa menggeser harga jauh. Spread lebar atau antrian tipis menandakan likuiditas rendah, sehingga satu transaksi dapat menggerakkan harga beberapa fraksi.

Transaksi terjadi saat order pembelian dan penjualan bertemu pada harga yang sama; harga transaksi terakhir itulah yang tampil sebagai harga saham saat ini.`,
  },
  {
    id: 'suspensi-dan-uma',
    title: 'Suspensi dan Unusual Market Activity (UMA)',
    tags: ['suspensi', 'uma', 'unusual market activity', 'pengumuman bursa'],
    content: `Unusual Market Activity (UMA) adalah pengumuman bursa bahwa aktivitas perdagangan sebuah saham dinilai tidak biasa, misalnya kenaikan atau penurunan harga dan volume yang jauh di luar kebiasaan. UMA adalah pemberitahuan agar investor memperhatikan informasi perusahaan, bukan penilaian bahwa ada pelanggaran.

Suspensi adalah penghentian sementara perdagangan sebuah saham oleh bursa, antara lain karena pergerakan harga yang dinilai perlu dijeda, keterlambatan laporan keuangan, atau permintaan klarifikasi. Selama suspensi, order tidak dapat dieksekusi dan harga yang tampil adalah harga terakhir sebelum suspensi. Pencabutan suspensi diumumkan oleh bursa.

Data penyedia gratis yang dipakai Indonesian Stock Bot tidak selalu menandai status suspensi; kutipan yang tidak berubah selama beberapa hari dapat menjadi petunjuk untuk memeriksa pengumuman bursa.`,
  },
  {
    id: 'rasio-fundamental',
    title: 'Rasio fundamental: EPS, PER, PBV, ROE, DER',
    tags: ['eps', 'per', 'pe', 'pbv', 'roe', 'der', 'fundamental', 'valuasi', 'kapitalisasi pasar'],
    content: `EPS (earnings per share) adalah laba bersih dibagi jumlah saham beredar, yaitu laba yang dihasilkan per lembar saham. PER (price to earnings ratio) adalah harga saham dibagi EPS; angka ini menyatakan berapa kali laba per lembar yang dibayar pasar untuk satu lembar saham. PBV (price to book value) adalah harga saham dibagi nilai buku per lembar, yaitu ekuitas dibagi jumlah saham.

ROE (return on equity) adalah laba bersih dibagi ekuitas, menggambarkan laba yang dihasilkan dari modal pemegang saham. DER (debt to equity ratio) adalah total utang dibagi ekuitas, menggambarkan struktur pendanaan perusahaan.

Kapitalisasi pasar adalah harga saham dikali jumlah saham beredar. Semua rasio ini bergantung pada periode laporan keuangan yang dipakai (tahunan atau empat kuartal terakhir) dan pada harga saat dihitung, sehingga angka dari sumber berbeda dapat berbeda. Rasio menggambarkan kondisi perusahaan dan harga saat ini, bukan kepastian kinerja berikutnya.`,
  },
  {
    id: 'investor-asing-dan-broker',
    title: 'Aliran dana asing dan broker summary',
    tags: ['asing', 'net buy', 'net sell', 'foreign flow', 'broker summary', 'bandar'],
    content: `Bursa membedakan transaksi investor asing dan domestik. Net buy asing berarti nilai pembelian investor asing pada suatu saham lebih besar daripada nilai penjualannya dalam periode tertentu; net sell asing adalah kebalikannya. Aliran dana asing sering diikuti sebagai salah satu gambaran minat investor institusi, tetapi investor asing bukan satu kelompok yang bertindak seragam.

Broker summary adalah ringkasan nilai transaksi per perusahaan efek untuk sebuah saham dalam suatu periode, biasanya menampilkan perusahaan efek dengan nilai pembelian dan penjualan terbesar. Satu perusahaan efek melayani banyak nasabah, sehingga ringkasan ini tidak menunjukkan siapa pemilik order sebenarnya.

Fitur asing dan broker summary di Indonesian Stock Bot bergantung pada ketersediaan data dari penyedia; bila penyedia tidak menyediakannya, Indonesian Stock Bot mengatakan datanya tidak tersedia.`,
  },
  {
    id: 'capital-gain-dan-floating',
    title: 'Capital gain, capital loss, dan laba mengambang',
    tags: ['capital gain', 'capital loss', 'floating', 'unrealized', 'realized', 'harga rata-rata'],
    content: `Capital gain adalah selisih positif antara harga penjualan dan harga pembelian sebuah saham; capital loss adalah selisih negatif. Keduanya baru terealisasi (realized) saat saham benar-benar dijual. Selama saham masih dipegang, selisih antara harga pasar dan harga pembelian disebut laba atau rugi mengambang (floating, unrealized) dan berubah mengikuti harga.

Harga rata-rata (average price) adalah total nilai pembelian dibagi jumlah lembar yang dipegang; pembelian tambahan pada harga berbeda mengubah rata-rata ini. Catatan portofolio Indonesian Stock Bot memakai metode biaya rata-rata: laba rugi terealisasi dihitung dari harga penjualan dikurangi harga rata-rata saat itu, dan nilai mengambang dihitung dari harga pasar tepercaya terbaru.`,
  },
  {
    id: 'risiko-saham',
    title: 'Jenis risiko dalam saham',
    tags: ['risiko', 'volatilitas', 'likuiditas', 'delisting', 'diversifikasi'],
    content: `Investasi saham mengandung beberapa jenis risiko. Risiko pasar adalah kemungkinan harga bergerak bersama pasar secara umum, terlepas dari kondisi perusahaan itu sendiri. Risiko likuiditas adalah kesulitan menjual pada harga wajar karena antrian tipis. Risiko perusahaan mencakup kinerja usaha yang memburuk hingga kemungkinan delisting (penghapusan pencatatan) bila perusahaan tidak lagi memenuhi ketentuan bursa.

Volatilitas menggambarkan seberapa besar harga berayun dalam suatu periode; saham dengan volatilitas tinggi dapat naik atau turun dalam persentase besar dalam waktu singkat. Diversifikasi adalah penyebaran dana ke beberapa saham atau aset agar hasil tidak bergantung pada satu perusahaan saja.

Indonesian Stock Bot menampilkan data dan risiko yang terbaca dari data (misalnya volatilitas tinggi atau volume tipis) tanpa menilai apakah suatu saham cocok untuk seseorang; keputusan tetap ada pada investor.`,
  },
  {
    id: 'bot-fitur',
    title: 'Fitur Indonesian Stock Bot dan cara memakainya',
    tags: ['bot', 'fitur', 'cara pakai', 'watchlist', 'alert', 'portofolio', 'bantuan'],
    content: `Indonesian Stock Bot adalah bot Telegram untuk membaca data saham Bursa Efek Indonesia dengan bahasa sehari-hari. Harga: tulis kode saham, misalnya "BBCA" atau "harga TLKM". Analisis: "analisis BBCA", "teknikal BBRI", "berapa RSI BBCA?". Perbandingan: "bandingkan BBCA BBRI". Screening: "saham apa yang volumenya tinggi?". Status bursa: "jam berapa market buka?".

Watchlist (chat pribadi): "tambahkan BBCA ke watchlist", "lihat watchlist saya", "hapus BBCA dari watchlist". Alert: "ingatkan saya kalau BBCA di atas 8500", "alert kalau RSI BBCA di bawah 30", "ingatkan kalau BBCA golden cross"; "lihat alert saya", "jeda alert 1", "lanjutkan alert BBCA", "hapus alert 1".

Portofolio (chat pribadi): "beli 10 lot BBCA di 9000", "jual 3 lot TLKM di 3100 fee 10rb", "setor 10 juta", "dividen BBCA 150000", lalu "portofolio saya", "riwayat transaksi", "batalkan transaksi terakhir". Memori: "apa yang tadi saya tanya?", "lupakan konteks", "saham default saya BBCA", "pengaturan saya", dan "hapus data saya" untuk menghapus seluruh data pribadi. Catatan pribadi: "catat: ..." untuk menyimpan catatan singkat, "catatan saya" untuk melihatnya.`,
  },
  {
    id: 'bot-batasan',
    title: 'Batasan dan sumber data Indonesian Stock Bot',
    tags: ['sumber data', 'tertunda', 'batasan', 'disclaimer', 'penyedia'],
    content: `Data harga Indonesian Stock Bot berasal dari penyedia data gratis yang umumnya tertunda sekitar sepuluh menit terhadap bursa dan sesekali tidak tersedia. Setiap jawaban menyebutkan waktu data dan tingkat kesegarannya; data yang basi, tidak konsisten dengan penutupan sebelumnya, atau mencurigakan ditandai dan tidak dipakai untuk alert maupun valuasi portofolio.

Indonesian Stock Bot tidak memberi anjuran untuk bertransaksi, angka harga yang diharapkan, atau prediksi, dan tidak menjalankan transaksi apa pun. Pertanyaan semacam itu dijawab dengan penjelasan kebijakan dan data yang tersedia. Analisis berbasis AI hanya memilih pengamatan dari katalog kalimat yang ditulis aplikasi berdasarkan data; model bahasa tidak pernah menulis teks jawaban sendiri.

Kuota pemakaian berlaku per pengguna agar layanan tetap adil bagi semua, karena bot ini bersifat publik.`,
  },
];

/** Glossary entries are part of the corpus too, so one retrieval covers both. */
const GLOSSARY_ARTICLES: CorpusArticle[] = GLOSSARY.map((g) => ({
  id: `glossary-${g.id}`,
  title: g.title,
  content: g.text,
  tags: [g.id],
}));

export const KNOWLEDGE_CORPUS: readonly CorpusArticle[] = [...ARTICLES, ...GLOSSARY_ARTICLES];
