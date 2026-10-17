import { Controller, Get, Header } from '@nestjs/common';
import { Metrics } from '../common/metrics.service';

/**
 * Process metrics in Prometheus text format. Like the rest of the REST API it is reachable only from the local
 * machine (loopback bind + Host/Origin checks). Labels never contain user ids or message text.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.metrics.toPrometheus();
  }
}
