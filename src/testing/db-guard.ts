/**
 * Guards for anything destructive that tests do to a database (CREATE DATABASE, migrate, TRUNCATE).
 * A name that merely CONTAINS "test" ("latest_prod", "contest") is not enough, and a remote host is never
 * acceptable: the database must be local and named like a test database (ai_stock_test, stock_bot_test_2...).
 */
const TEST_NAME = /(^|_)test($|_)/i;
const SAFE_NAME = /^[a-z0-9_]+$/i;

export interface TestDbTarget {
  host: string;
  database: string;
}

/** Parses a connection string and refuses anything that is not a local, test-named database. */
export function assertSafeTestDatabase(connectionString: string | undefined): TestDbTarget {
  if (!connectionString) throw new Error('Refusing to run: no test database URL.');
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Refusing to run: the test database URL is not a valid URL.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!isLocal) {
    throw new Error(`Refusing to run tests against non-local host "${host}".`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!SAFE_NAME.test(database) || !TEST_NAME.test(database)) {
    throw new Error(
      `Refusing to run tests against database "${database}" (the name must be a test database such as ai_stock_test).`,
    );
  }
  return { host, database };
}
