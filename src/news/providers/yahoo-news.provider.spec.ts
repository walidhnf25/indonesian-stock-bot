import { normalizeYahooNews } from './yahoo-news.provider';

describe('Yahoo news normalisation', () => {
  it('maps items, times (Date or epoch seconds/millis) and IDX related tickers; drops junk', () => {
    const items = normalizeYahooNews({
      news: [
        {
          uuid: 'a',
          title: 'BBCA bagikan dividen',
          publisher: 'Kontan',
          link: 'https://example.com/a',
          providerPublishTime: new Date('2026-10-01T00:00:00Z'),
          relatedTickers: ['BBCA.JK', 'AAPL'],
        },
        { uuid: 'b', title: 'Epoch seconds', providerPublishTime: 1_760_000_000 },
        { uuid: 'c', title: 'Epoch millis', providerPublishTime: 1_760_000_000_000 },
        { title: 'no uuid' },
        { uuid: 'd' },
        'garbage',
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['yahoo:a', 'yahoo:b', 'yahoo:c']);
    expect(items[0]).toMatchObject({
      title: 'BBCA bagikan dividen',
      publisher: 'Kontan',
      url: 'https://example.com/a',
      relatedTickers: ['BBCA'],
    });
    expect(items[1].publishedAt.toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(items[2].publishedAt.toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(items[1].publisher).toBe('');
    expect(items[1].url).toBeNull();
  });

  it('a response without news gives an empty list', () => {
    expect(normalizeYahooNews({})).toEqual([]);
    expect(normalizeYahooNews(null)).toEqual([]);
    expect(normalizeYahooNews({ news: 'nope' })).toEqual([]);
  });
});
