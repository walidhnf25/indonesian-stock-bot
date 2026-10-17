-- new alerts store their threshold with at most 6 decimals, but alerts created earlier may hold
-- values such as 0.1234565 or 4.0000005, for which PostgreSQL's key (numeric rounding) and the
-- application's key (binary rounding) differ. Quantise every stored threshold the same way the application
-- does now, then rebuild the keys of ACTIVE alerts.

-- An ACTIVE alert whose threshold is not a usable number any more cannot be created today (it must be
-- positive at 6 decimals and at most 1 000 000 000, where PostgreSQL's 15 significant digits are exact);
-- disable it instead of silently turning it into "above 0" or a value that may be rounded differently.
-- Nothing is deleted.
UPDATE "Alert"
SET "status" = 'DISABLED', "activeKey" = NULL
WHERE "status" = 'ACTIVE'
  AND (round("threshold"::numeric, 6) <= 0 OR "threshold" > 1000000000);

UPDATE "Alert"
SET "threshold" = round("threshold"::numeric, 6)::float8
WHERE "threshold"::numeric <> round("threshold"::numeric, 6);

-- Alerts that became identical: keep the oldest ACTIVE one of each group, disable the others.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "userId", "stockId", "type", "threshold", COALESCE("chatId"::text, '')
           ORDER BY "createdAt", "id"
         ) AS rn
  FROM "Alert"
  WHERE "status" = 'ACTIVE'
)
UPDATE "Alert" AS a
SET "status" = 'DISABLED', "activeKey" = NULL
FROM ranked AS r
WHERE a."id" = r."id" AND r.rn > 1;

UPDATE "Alert"
SET "activeKey" = "userId" || ':' || "stockId" || ':' || "type"::text || ':' ||
                  trim_scale(round("threshold"::numeric, 6))::text || ':' || COALESCE("chatId"::text, '')
WHERE "status" = 'ACTIVE';
