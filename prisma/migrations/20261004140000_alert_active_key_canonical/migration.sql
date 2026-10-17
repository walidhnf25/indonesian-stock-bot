-- the application now builds "activeKey" from a canonical threshold text (at most 6 decimals, plain
-- decimal notation, no trailing zeros). The previous migration used float8::text, which prints exponents
-- ("1e-05", "1e+15") for exotic values and therefore never matched the application's key. Re-key every
-- ACTIVE alert with the canonical form; PostgreSQL 13+ (trim_scale) is required, the project pins 16.

-- Alerts that become identical under the canonical form: keep the oldest ACTIVE one, DISABLE the others.
WITH keyed AS (
  SELECT "id", "userId", "stockId", "type", "createdAt",
         COALESCE("chatId"::text, '') AS chat,
         trim_scale(round("threshold"::numeric, 6))::text AS thr
  FROM "Alert"
  WHERE "status" = 'ACTIVE'
), ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "userId", "stockId", "type", thr, chat
           ORDER BY "createdAt", "id"
         ) AS rn
  FROM keyed
)
UPDATE "Alert" AS a
SET "status" = 'DISABLED', "activeKey" = NULL
FROM ranked AS r
WHERE a."id" = r."id" AND r.rn > 1;

UPDATE "Alert"
SET "activeKey" = "userId" || ':' || "stockId" || ':' || "type"::text || ':' ||
                  trim_scale(round("threshold"::numeric, 6))::text || ':' || COALESCE("chatId"::text, '')
WHERE "status" = 'ACTIVE';
