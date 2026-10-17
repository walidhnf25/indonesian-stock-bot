import { canonicalize } from '../ai/policy/canonical';

/**
 * Deterministic educational glossary for the indicators Indonesian Stock Bot itself computes.
 *
 * Conceptual questions ("apa itu RSI?") are answered from this application-owned text, never by the
 * language model: no prompt-injection surface, no invented definitions, no latency or AI quota. The
 * wording is descriptive only: no trading instructions, guarantees or predictions. Every entry is
 * checked against the AI output policy in the unit tests.
 */

export interface GlossaryEntry {
  id: string;
  title: string;
  /** Matched against the canonical (lower-cased, de-obfuscated) question. */
  match: RegExp;
  text: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: 'rsi',
    title: 'RSI (Relative Strength Index)',
    match: /\b(rsi|relative strength|overbought|oversold|jenuh beli|jenuh jual)\b/,
    text: 'RSI adalah indikator momentum berskala 0–100 yang membandingkan rata-rata kenaikan dan penurunan harga penutupan dalam suatu periode (umumnya 14 hari). Secara umum, RSI di atas 70 dianggap zona jenuh beli (overbought) dan RSI di bawah 30 dianggap zona jenuh jual (oversold); nilai di antaranya dianggap netral. Zona ini menggambarkan kondisi harga saat ini, bukan kepastian arah berikutnya: harga bisa bertahan lama di zona tersebut.',
  },
  {
    id: 'macd',
    title: 'MACD (Moving Average Convergence Divergence)',
    match: /\b(macd|moving average convergence)\b/,
    text: 'MACD menunjukkan hubungan dua rata-rata bergerak eksponensial (EMA), umumnya EMA 12 dan EMA 26. Garis MACD adalah selisih keduanya, garis sinyal adalah EMA 9 dari garis MACD, dan histogram adalah selisih garis MACD dengan garis sinyal. Histogram positif berarti garis MACD berada di atas garis sinyal (momentum cenderung menguat); histogram negatif berarti sebaliknya. MACD menggambarkan momentum yang sudah terjadi, bukan jaminan arah berikutnya.',
  },
  {
    id: 'ma',
    title: 'Moving average (MA)',
    match: /\b(moving average|rata-rata bergerak|ma ?(?:20|50|100|200))\b/,
    text: 'Moving average adalah rata-rata harga penutupan selama N periode yang terus bergeser mengikuti data terbaru, sehingga menghaluskan naik-turunnya harga. Dua jenis yang umum adalah SMA (rata-rata sederhana) dan EMA (memberi bobot lebih besar pada harga terbaru). Indonesian Stock Bot menampilkan MA 20, 50, dan 200 hari bila datanya cukup. Harga di atas MA berarti harga berada di atas rata-rata periode tersebut; di bawahnya berarti sebaliknya.',
  },
  {
    id: 'sma',
    title: 'SMA (Simple Moving Average)',
    match: /\b(sma|simple moving average)\b/,
    text: 'SMA adalah rata-rata sederhana harga penutupan selama N periode, misalnya SMA 20 adalah rata-rata 20 penutupan terakhir. Semakin panjang periodenya, semakin halus kurvanya dan semakin lambat bereaksi terhadap perubahan harga.',
  },
  {
    id: 'ema',
    title: 'EMA (Exponential Moving Average)',
    match: /\b(ema|exponential moving average)\b/,
    text: 'EMA adalah rata-rata bergerak yang memberi bobot lebih besar pada harga terbaru, sehingga bereaksi lebih cepat daripada SMA dengan periode yang sama. EMA 12 dan EMA 26 adalah komponen penghitungan MACD.',
  },
  {
    id: 'bollinger',
    title: 'Bollinger Bands',
    match: /\b(bollinger|bollinger bands?|pita bollinger)\b/,
    text: 'Bollinger Bands terdiri dari garis tengah (SMA 20) dan dua pita, atas dan bawah, pada jarak dua simpangan baku dari garis tengah. Pita melebar saat volatilitas meningkat dan menyempit saat volatilitas menurun. Harga yang menyentuh pita atas atau bawah hanya menunjukkan harga sedang relatif jauh dari rata-ratanya, bukan otomatis tanda pembalikan arah.',
  },
  {
    id: 'atr',
    title: 'ATR (Average True Range)',
    match: /\b(atr|average true range)\b/,
    text: 'ATR mengukur volatilitas: rata-rata "true range" (rentang harga harian termasuk selisih dari penutupan sebelumnya), umumnya selama 14 periode. Nilainya dalam satuan harga (rupiah), jadi ATR yang besar berarti pergerakan harian cenderung lebar. ATR tidak menunjukkan arah harga.',
  },
  {
    id: 'support',
    title: 'Support',
    match: /\b(support|suport|penyangga)\b/,
    text: 'Support adalah level harga di mana penurunan sebelumnya cenderung tertahan, biasanya dihitung dari titik terendah (swing low) historis yang beberapa kali disentuh. Indonesian Stock Bot menghitungnya dari data harga historis. Level ini bukan batas pasti: harga bisa saja menembusnya.',
  },
  {
    id: 'resistance',
    title: 'Resistance',
    match: /\b(resistance|resisten|hambatan)\b/,
    text: 'Resistance adalah level harga di mana kenaikan sebelumnya cenderung tertahan, biasanya dihitung dari titik tertinggi (swing high) historis yang beberapa kali disentuh. Indonesian Stock Bot menghitungnya dari data harga historis. Level ini bukan batas pasti: harga bisa saja menembusnya.',
  },
  {
    id: 'volume_ratio',
    title: 'Rasio volume',
    match: /\b(rasio volume|volume ratio)\b/,
    text: 'Rasio volume membandingkan volume hari ini dengan rata-rata volume 20 hari sebelumnya. Rasio 1,0x berarti sama dengan rata-rata; di atas 1,5x umumnya dianggap tinggi dan di bawah 0,8x dianggap rendah. Selama sesi masih berjalan, volume hari ini belum lengkap sehingga rasionya cenderung lebih rendah dari akhir hari.',
  },
  {
    id: 'volume',
    title: 'Volume',
    match: /\bvolume\b/,
    text: 'Volume adalah jumlah lembar saham yang diperdagangkan dalam suatu periode. Volume membantu menilai seberapa besar partisipasi pasar di balik pergerakan harga: pergerakan dengan volume besar umumnya dianggap lebih bermakna daripada volume kecil. Volume sendiri tidak menunjukkan arah harga.',
  },
  {
    id: 'volatility',
    title: 'Volatilitas',
    match: /\b(volatilitas|volatility|volatil)\b/,
    text: 'Volatilitas menggambarkan seberapa lebar harga bergerak naik-turun dalam suatu periode. Volatilitas tinggi berarti pergerakan lebar (risiko dan fluktuasi lebih besar), volatilitas rendah berarti pergerakan lebih tenang. Biasa diukur dengan ATR atau simpangan baku seperti pada Bollinger Bands.',
  },
  {
    id: 'trend',
    title: 'Tren dan momentum',
    match: /\b(tren|trend|momentum)\b/,
    text: 'Tren adalah arah umum pergerakan harga dalam periode tertentu. Indonesian Stock Bot menilainya dari posisi harga terhadap MA, urutan MA, dan histogram MACD, lalu menyebutnya bullish, netral, atau bearish. Momentum menggambarkan kekuatan pergerakan harga (dihitung dari RSI dan MACD). Keduanya menggambarkan kondisi yang sudah terjadi, bukan ramalan.',
  },
  {
    id: 'price',
    title: 'Istilah harga',
    match:
      /\b(harga penutupan|harga terakhir|penutupan sebelumnya|previous close|harga open|harga high|harga low)\b/,
    text: 'Harga terakhir adalah harga transaksi terkini (atau penutupan jika bursa tutup). Penutupan sebelumnya adalah harga akhir sesi sebelumnya dan dipakai untuk menghitung perubahan harian. Open, high, dan low adalah harga pembukaan, tertinggi, dan terendah pada sesi berjalan. Data dari provider gratis bisa tertunda sekitar 10 menit.',
  },
];

export const SUPPORTED_TOPICS =
  'RSI, MACD, moving average (SMA/EMA), Bollinger Bands, ATR, support, resistance, volume, rasio volume, volatilitas, serta tren dan momentum';

export const GLOSSARY_FALLBACK = `Saya bisa menjelaskan istilah yang dipakai Indonesian Stock Bot: ${SUPPORTED_TOPICS}. Contoh: "apa itu RSI?". Untuk topik lain saya belum punya penjelasan resmi.`;

/** Entries relevant to a question (max 3, most specific first). Empty when nothing matches. */
export function findGlossaryEntries(question: string): GlossaryEntry[] {
  const q = canonicalize(question);
  const hits = GLOSSARY.filter((e) => e.match.test(q));
  const ids = new Set(hits.map((h) => h.id));
  return hits
    .filter((e) => !(e.id === 'volume' && ids.has('volume_ratio')))
    .filter((e) => !(e.id === 'ma' && (ids.has('sma') || ids.has('ema'))))
    .slice(0, 3);
}
