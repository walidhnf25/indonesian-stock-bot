/**
 * Ticker CODES (not market data) of commonly traded IDX stocks. Used for:
 *  - recognising lower-case tickers in free text ("analisis bbca"),
 *  - the default screening universe.
 * Any other valid 4-letter ticker still works for quotes/analysis; the data provider is the
 * authority on whether a ticker exists. Tickers that are delisted/renamed are simply skipped
 * by the provider.
 */
export const IDX_UNIVERSE: readonly string[] = [
  // Banks
  'BBCA',
  'BBRI',
  'BMRI',
  'BBNI',
  'BRIS',
  'BBTN',
  'BNGA',
  'BDMN',
  'NISP',
  'PNBN',
  'MEGA',
  'ARTO',
  'BTPS',
  'BJTM',
  'BJBR',
  // Telco & infrastructure
  'TLKM',
  'ISAT',
  'EXCL',
  'TOWR',
  'MTEL',
  'TBIG',
  'JSMR',
  'PGEO',
  // Consumer
  'ASII',
  'UNVR',
  'ICBP',
  'INDF',
  'MYOR',
  'KLBF',
  'SIDO',
  'HMSP',
  'GGRM',
  'CPIN',
  'JPFA',
  'AMRT',
  'MIDI',
  'ACES',
  'MAPI',
  'ERAA',
  'CMRY',
  // Energy & mining
  'ADRO',
  'PTBA',
  'ITMG',
  'BYAN',
  'INDY',
  'HRUM',
  'MEDC',
  'PGAS',
  'AKRA',
  'ENRG',
  'BUMI',
  'ELSA',
  'ANTM',
  'INCO',
  'MDKA',
  'TINS',
  'MBMA',
  'NCKL',
  'AMMN',
  'PSAB',
  'HRTA',
  // Industrial, materials, property
  'UNTR',
  'SMGR',
  'INTP',
  'BRPT',
  'TPIA',
  'ESSA',
  'INKP',
  'TKIM',
  'AUTO',
  'SMRA',
  'BSDE',
  'CTRA',
  'PWON',
  'KIJA',
  // Tech, media, health
  'GOTO',
  'BUKA',
  'EMTK',
  'SCMA',
  'MNCN',
  'MIKA',
  'HEAL',
  'SILO',
  'CUAN',
  'BREN',
  'DSSA',
  // Plantations
  'AALI',
  'LSIP',
  'SIMP',
  'TAPG',
];

export const UNIVERSE_SET: ReadonlySet<string> = new Set(IDX_UNIVERSE);

/**
 * Listed IDX codes that are also ordinary words (and therefore in the ticker extractor's stop list). They are
 * recognised only when written in upper case inside a mixed-case message ("harga GOOD"), like BUKA, and they
 * count as real tickers for the registry (never negatively cached). Not part of the screening universe.
 */
export const WORD_TICKERS: readonly string[] = [
  'GOOD',
  'BEST',
  'BANK',
  'AMAN',
  'BULL',
  'EMAS',
  'LABA',
];
export const WORD_TICKER_SET: ReadonlySet<string> = new Set(WORD_TICKERS);

/** Every code the application knows to be a real listed ticker. */
export const KNOWN_TICKER_SET: ReadonlySet<string> = new Set([...IDX_UNIVERSE, ...WORD_TICKERS]);

/** Plain-language company names/short names people type. */
export const NAME_ALIASES: Readonly<Record<string, string>> = {
  bca: 'BBCA',
  'bank central asia': 'BBCA',
  bri: 'BBRI',
  'bank rakyat indonesia': 'BBRI',
  mandiri: 'BMRI',
  'bank mandiri': 'BMRI',
  bni: 'BBNI',
  telkom: 'TLKM',
  telkomsel: 'TLKM',
  astra: 'ASII',
  antam: 'ANTM',
  vale: 'INCO',
  unilever: 'UNVR',
  indofood: 'INDF',
  adaro: 'ADRO',
  'bukit asam': 'PTBA',
  sampoerna: 'HMSP',
  kalbe: 'KLBF',
  gojek: 'GOTO',
  tokopedia: 'GOTO',
  bukalapak: 'BUKA',
  amman: 'AMMN',
};
