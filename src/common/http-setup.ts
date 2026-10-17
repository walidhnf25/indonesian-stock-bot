import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import { isLoopbackHost } from '../config/env.schema';
import { CallerContext } from './caller-context';

/** The REST API takes no request body; anything bigger than this is not a legitimate client. */
export const MAX_BODY_BYTES = '10kb';

const hostnameOf = (hostHeader: string): string => {
  // "localhost:3000", "127.0.0.1:3000", "[::1]:3000", "example.com"
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
};

const originHostname = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Keeps the unauthenticated REST API loopback-only at the HTTP level, not just by bind address:
 *  - the Host header must name a loopback host (stops DNS-rebinding pages from reading local data),
 *  - a browser-supplied Origin must be a loopback origin (stops a web page the operator visits from firing
 *    "simple" cross-origin requests such as a body-less POST /analysis/:symbol at the local machine).
 * Requests without an Origin (curl, scripts, supertest) are unaffected. Disabled by REST_ALLOW_REMOTE=true.
 */
export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host;
  if (host && !isLoopbackHost(hostnameOf(host))) {
    res.status(403).json({ statusCode: 403, message: 'Host tidak diizinkan.' });
    return;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    const name = originHostname(origin);
    if (name === null || !isLoopbackHost(name)) {
      res.status(403).json({ statusCode: 403, message: 'Origin tidak diizinkan.' });
      return;
    }
  }
  next();
}

/**
 * HTTP-level settings shared by the real server (main.ts) and the e2e/test apps, so tests exercise the
 * same behaviour. Call before app.init()/listen().
 */
export function configureHttp(app: INestApplication, opts: { allowRemote: boolean }): void {
  const express = app.getHttpAdapter().getInstance() as { disable?: (name: string) => void };
  express.disable?.('x-powered-by');
  // Parsed before Nest's own parser (which then skips a request that is already parsed).
  app.use(json({ limit: MAX_BODY_BYTES }));
  if (!opts.allowRemote) app.use(localOnly);
  // Who is asking, for quotas on shared resources (market-data governor). One bucket per client address.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    CallerContext.run(`rest:${req.ip ?? 'unknown'}`, () => next());
  });
}
