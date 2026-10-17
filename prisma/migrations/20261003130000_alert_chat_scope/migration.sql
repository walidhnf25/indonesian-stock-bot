-- an alert is delivered to the chat it was created in, never to the user's "last active chat".
ALTER TABLE "Alert" ADD COLUMN "chatId" BIGINT;
ALTER TABLE "Alert" ADD COLUMN "chatType" TEXT NOT NULL DEFAULT 'private';

-- Existing alerts go to the owner's PRIVATE chat. A private chat id equals the Telegram user id, so
-- this does not depend on User.chatId (which used to be overwritten by messages from groups).
UPDATE "Alert" AS a
SET "chatId" = u."telegramId"
FROM "User" AS u
WHERE a."userId" = u."id";
