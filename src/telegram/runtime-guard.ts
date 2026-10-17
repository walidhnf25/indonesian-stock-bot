/**
 * Test-runtime detection for the Telegram transport.
 *
 * Why it reads `process.env` at call time and not the validated config: ConfigModule validates and
 * caches the environment when it is first imported. A harness that imports the app before it has
 * neutralised its environment (or a developer's `.env`) would otherwise leave a REAL bot token in the
 * cached config and start real long polling. The process environment and the Jest worker id are the
 * runtime truth, so they are checked right before anything touches the network.
 */
export const TELEGRAM_DISABLED_IN_TEST = 'TELEGRAM_DISABLED_IN_TEST';

export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
}
