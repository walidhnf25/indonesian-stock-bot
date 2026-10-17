import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is asking, carried implicitly through async calls so that deep layers (the market-data governor) can
 * charge shared resources to the right party without every method taking a "caller" argument.
 *
 * Keys: `tg:<telegramId>` for a Telegram user, `rest:<ip>` for the local REST API, `system:<job>` for
 * background jobs (alert checks). Code that runs without a context is charged to `anonymous`, which is NOT
 * exempt from quotas, so a forgotten `run()` fails safe (and is counted, see `provider_unattributed_total`).
 */
interface Frame {
  key: string;
  signal?: AbortSignal;
}
const storage = new AsyncLocalStorage<Frame>();

export const ANONYMOUS_CALLER = 'anonymous';
export const SYSTEM_PREFIX = 'system:';

export const CallerContext = {
  /** `signal` (optional) cancels provider calls still queued or running when the request is abandoned. */
  run<T>(key: string, fn: () => T, signal?: AbortSignal): T {
    return storage.run({ key, signal }, fn);
  },
  /** The current caller key, or null when none was set. */
  peek(): string | null {
    return storage.getStore()?.key ?? null;
  },
  current(): string {
    return storage.getStore()?.key ?? ANONYMOUS_CALLER;
  },
  /** The abort signal of the current request, if the caller provided one. */
  signal(): AbortSignal | undefined {
    return storage.getStore()?.signal;
  },
  isSystem(key: string): boolean {
    return key.startsWith(SYSTEM_PREFIX);
  },
};
