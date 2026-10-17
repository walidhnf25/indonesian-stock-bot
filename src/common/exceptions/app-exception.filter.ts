import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { safeErrorMessage } from '../utils/scrub';
import { UserFacingError } from './app-errors';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_TICKER: HttpStatus.NOT_FOUND,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  PROVIDER_DOWN: HttpStatus.SERVICE_UNAVAILABLE,
  INSUFFICIENT_HISTORY: HttpStatus.UNPROCESSABLE_ENTITY,
};

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

/** Maps errors to safe JSON. Internal details (stack, DB URLs, keys) never reach the client. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof UserFacingError) {
      const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
      res.status(status).json({
        statusCode: status,
        code: exception.code,
        message: stripTags(exception.userMessage),
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    // Errors raised by the HTTP layer itself (body-parser: too large, malformed...) carry a 4xx status.
    const status = (exception as { status?: unknown; statusCode?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        statusCode: status,
        message: status === 413 ? 'Permintaan terlalu besar.' : 'Permintaan tidak valid.',
      });
      return;
    }
    this.logger.error(`Unhandled error: ${safeErrorMessage(exception)}`);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Terjadi kesalahan internal.',
    });
  }
}
