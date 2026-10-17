import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { SlidingWindowLimiter } from '../utils/rate-limiter';

/** Simple per-IP limiter for the REST API (60 requests / minute). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter = new SlidingWindowLimiter(60, 60_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const result = this.limiter.tryConsume(req.ip ?? 'unknown');
    if (!result.allowed) {
      throw new HttpException(
        {
          statusCode: 429,
          message: `Terlalu banyak permintaan. Coba lagi dalam ${result.retryAfterSeconds} detik.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
