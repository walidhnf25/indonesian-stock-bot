import { BeforeApplicationShutdown, Global, Injectable, Logger, Module } from '@nestjs/common';
import { Metrics } from './metrics.service';

/**
 * Tracks fire-and-forget work (cache persistence, context writes) so it can be flushed on shutdown
 * instead of racing with the database disconnect.
 */
@Injectable()
export class BackgroundTasks implements BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundTasks.name);
  private readonly pending = new Set<Promise<unknown>>();

  run(task: Promise<unknown>): void {
    const tracked = task.catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /**
   * Waits for pending work, but never forever: a write stuck behind a lock or a lost connection must not keep
   * a shutdown (or a test) hanging. Whatever is still pending after the bound is abandoned and logged.
   */
  async flush(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.logger.warn(
          JSON.stringify({
            evt: 'BACKGROUND_FLUSH_TIMEOUT',
            abandoned: this.pending.size,
            timeoutMs,
          }),
        );
        this.pending.clear();
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((r) => {
          timer = setTimeout(r, left);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.flush();
  }
}

@Global()
@Module({ providers: [BackgroundTasks, Metrics], exports: [BackgroundTasks, Metrics] })
export class CommonModule {}
