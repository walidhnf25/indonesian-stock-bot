-- two identical ACTIVE alerts must not exist, even when created concurrently.
-- "activeKey" is filled only while an alert is ACTIVE and has a UNIQUE index (NULLs do not collide).
ALTER TABLE "Alert" ADD COLUMN "activeKey" TEXT;

-- Existing duplicates: keep the oldest ACTIVE alert of each identical group, DISABLE the others
-- (nothing is deleted; they stay visible in history until retention removes them).
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
SET "status" = 'DISABLED'
FROM ranked AS r
WHERE a."id" = r."id" AND r.rn > 1;

UPDATE "Alert"
SET "activeKey" = "userId" || ':' || "stockId" || ':' || "type"::text || ':' || "threshold"::text || ':' || COALESCE("chatId"::text, '')
WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "Alert_activeKey_key" ON "Alert"("activeKey");

-- conversation context belongs to a chat, not to the user across all chats.
-- Existing rows were written from the user's private chat (private chat id == Telegram user id).
ALTER TABLE "ConversationContext" ADD COLUMN "chatId" BIGINT;

UPDATE "ConversationContext" AS c
SET "chatId" = u."telegramId"
FROM "User" AS u
WHERE c."userId" = u."id";

-- A context row whose user vanished cannot be attributed to a chat; the FK cascade makes this a no-op.
DELETE FROM "ConversationContext" WHERE "chatId" IS NULL;
ALTER TABLE "ConversationContext" ALTER COLUMN "chatId" SET NOT NULL;

DROP INDEX "ConversationContext_userId_key";
CREATE UNIQUE INDEX "ConversationContext_userId_chatId_key" ON "ConversationContext"("userId", "chatId");

-- Retention scans AIAnalysis by age; without this index each run reads the whole table.
CREATE INDEX "AIAnalysis_createdAt_idx" ON "AIAnalysis"("createdAt");
