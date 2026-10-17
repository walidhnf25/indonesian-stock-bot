import { assertSafeTestDatabase } from './db-guard';

describe('test database guard', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5436/ai_stock_test',
    'postgresql://u:p@127.0.0.1:5432/stock_bot_test',
    'postgresql://u:p@[::1]:5432/test',
    'postgresql://u:p@localhost/test_run_2',
  ])('accepts %s', (url) => {
    expect(() => assertSafeTestDatabase(url)).not.toThrow();
  });

  it.each([
    ['production-looking name containing "test"', 'postgresql://u:p@localhost:5432/latest_prod'],
    ['"contest"', 'postgresql://u:p@localhost:5432/contest'],
    ['the development database', 'postgresql://u:p@localhost:5436/ai_stock'],
    ['a remote host with a test name', 'postgresql://u:p@db.example.com:5432/ai_stock_test'],
    ['a LAN host', 'postgresql://u:p@192.168.1.10:5432/ai_stock_test'],
    [
      'a hostname that only starts like loopback',
      'postgresql://u:p@localhost.evil.com/ai_stock_test',
    ],
    ['an unsafe database name', 'postgresql://u:p@localhost/ai_test"; DROP DATABASE x; --'],
    ['no database', 'postgresql://u:p@localhost:5432/'],
    ['garbage', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertSafeTestDatabase(url)).toThrow(/Refusing/);
  });

  it('refuses an empty value', () => {
    expect(() => assertSafeTestDatabase(undefined)).toThrow(/Refusing/);
  });

  it('never echoes the password', () => {
    let message = '';
    try {
      assertSafeTestDatabase('postgresql://u:topsecret@db.example.com:5432/x');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Refusing/); // it did refuse; the assertion below is not vacuous
    expect(message).not.toContain('topsecret');
  });
});
