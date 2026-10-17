import { AppConfig } from '../config/app-config.service';
import { MarketService } from './market.service';

const config = (holidays: string[] = []) => ({ holidays }) as unknown as AppConfig;
// Asia/Jakarta is UTC+7 (no DST): 09:00 WIB = 02:00Z.
const wib = (isoLocal: string) => new Date(`${isoLocal}+07:00`);

describe('MarketService (Asia/Jakarta)', () => {
  const svc = new MarketService(config(['2026-10-02']));

  it('is closed on weekends', () => {
    const s = svc.getStatus(wib('2026-10-03T10:00:00')); // Saturday
    expect(s).toMatchObject({ state: 'WEEKEND', isTrading: false });
    expect(s.nextOpen).toBe(wib('2026-10-05T09:00:00').toISOString()); // Monday (Oct 2 is configured holiday, Fri)
  });

  it('is closed on configured holidays and reopens the next trading day', () => {
    const s = svc.getStatus(wib('2026-10-02T10:00:00')); // Friday, holiday
    expect(s).toMatchObject({ state: 'HOLIDAY', isTrading: false });
    expect(s.nextOpen).toBe(wib('2026-10-05T09:00:00').toISOString());
  });

  it('Mon-Thu: before open, session 1, lunch break, session 2, pre-closing, after close', () => {
    expect(svc.getStatus(wib('2026-10-01T08:59:00')).state).toBe('BEFORE_OPEN'); // Thursday
    expect(svc.getStatus(wib('2026-10-01T09:00:00'))).toMatchObject({
      state: 'OPEN',
      isTrading: true,
    });
    expect(svc.getStatus(wib('2026-10-01T11:59:00')).isTrading).toBe(true);
    expect(svc.getStatus(wib('2026-10-01T12:00:00')).state).toBe('LUNCH_BREAK');
    expect(svc.getStatus(wib('2026-10-01T13:29:00')).state).toBe('LUNCH_BREAK');
    expect(svc.getStatus(wib('2026-10-01T13:30:00')).isTrading).toBe(true);
    expect(svc.getStatus(wib('2026-10-01T15:49:00')).isTrading).toBe(true);
    expect(svc.getStatus(wib('2026-10-01T15:50:00')).state).toBe('PRE_CLOSING');
    expect(svc.getStatus(wib('2026-10-01T16:00:00')).state).toBe('AFTER_CLOSE');
  });

  it('Friday has the longer lunch break (11:30-14:00)', () => {
    const svc2 = new MarketService(config());
    expect(svc2.getStatus(wib('2026-10-02T11:29:00')).isTrading).toBe(true);
    expect(svc2.getStatus(wib('2026-10-02T11:30:00')).state).toBe('LUNCH_BREAK');
    expect(svc2.getStatus(wib('2026-10-02T13:59:00')).state).toBe('LUNCH_BREAK');
    expect(svc2.getStatus(wib('2026-10-02T14:00:00')).isTrading).toBe(true);
  });

  it('gives the next open for same-day and lunch reopenings', () => {
    expect(svc.getStatus(wib('2026-10-01T07:00:00')).nextOpen).toBe(
      wib('2026-10-01T09:00:00').toISOString(),
    );
    expect(svc.getStatus(wib('2026-10-01T12:30:00')).nextOpen).toBe(
      wib('2026-10-01T13:30:00').toISOString(),
    );
    // after close on Thursday -> Friday is a configured holiday -> Monday
    expect(svc.getStatus(wib('2026-10-01T17:00:00')).nextOpen).toBe(
      wib('2026-10-05T09:00:00').toISOString(),
    );
  });

  it('uses Jakarta wall-clock, not the server timezone (UTC evening is already next day in WIB)', () => {
    // 2026-10-04T18:00Z is Monday 2026-10-05 01:00 WIB -> before open on a trading day
    expect(svc.getStatus(new Date('2026-10-04T18:00:00Z')).state).toBe('BEFORE_OPEN');
  });

  it('describe() includes the schedule', () => {
    expect(svc.describe(wib('2026-10-01T10:00:00'))).toMatch(/Senin–Kamis: 09:00–12:00/);
  });
});
