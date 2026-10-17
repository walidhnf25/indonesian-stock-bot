import { extractEvents, mapRelatedTickers, relevanceFor, safeUrl, titleHash } from './news-events';

describe('News events, dedup hash, ticker mapping, relevance and links', () => {
  it.each([
    ['BBCA bagikan dividen Rp270 per saham, cum date 20 Mei', ['dividend']],
    ['RUPST TLKM setujui pembagian dividen', ['dividend', 'rups']],
    ['BRIS gelar right issue, incar dana Rp5 triliun', ['right_issue']],
    ['BEI suspensi saham XYZW setelah UMA', ['suspension', 'uma']],
    ['Laba bersih BBRI kuartal III tumbuh 12%', ['earnings']],
    ['ASII akuisisi 40% saham perusahaan tambang', ['acquisition']],
    ['Emiten teknologi resmi melantai di BEI, IPO raih Rp1 T', ['ipo']],
    ['GOTO lanjutkan buyback saham', ['buyback']],
    ['ADRO terbitkan obligasi dan sukuk', ['bond']],
    ['Dirut UNVR mengundurkan diri', ['management']],
    ['Bank Central Asia stock split 1:5', ['stock_split']],
    ['Harga BBCA ditutup menguat', []],
  ])('%s -> %j', (title, events) => {
    expect(extractEvents(title)).toEqual(events);
  });

  it('titleHash ignores case, punctuation, accents and spacing', () => {
    expect(titleHash('BBCA bagikan dividen!')).toBe(titleHash('  bbca   BAGIKAN  dividen '));
    expect(titleHash('Émiten')).toBe(titleHash('emiten'));
    expect(titleHash('BBCA dividen')).not.toBe(titleHash('BBRI dividen'));
  });

  it('maps only IDX tickers from provider lists', () => {
    expect(mapRelatedTickers(['BBCA.JK', '^JKSE', 'AAPL', 'tlkm.jk', 42, 'TOOLONG.JK'])).toEqual([
      'BBCA',
      'TLKM',
    ]);
    expect(mapRelatedTickers(undefined)).toEqual([]);
  });

  it('relevance is direct when the provider or the headline names the stock', () => {
    const base = { id: '1', publisher: 'x', url: null, publishedAt: new Date() };
    expect(
      relevanceFor('BBCA', { ...base, title: 'Sektor bank menguat', relatedTickers: ['BBCA'] }),
    ).toBe('direct');
    expect(
      relevanceFor('BBCA', { ...base, title: 'BBCA bagikan dividen', relatedTickers: [] }),
    ).toBe('direct');
    expect(
      relevanceFor('BBCA', { ...base, title: 'Sektor bank menguat', relatedTickers: ['BBRI'] }),
    ).toBe('related');
    expect(relevanceFor('BBCA', { ...base, title: 'ABBCAX', relatedTickers: [] })).toBe('related');
  });

  it('only http(s) URLs survive', () => {
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});
