-- Headlines per stock, de-duplicated by provider id and by normalised title.
-- CreateTable
CREATE TABLE "NewsArticle" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "titleHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbols" TEXT[],
    "events" TEXT[],

    CONSTRAINT "NewsArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsArticle_externalId_key" ON "NewsArticle"("externalId");
CREATE INDEX "NewsArticle_titleHash_idx" ON "NewsArticle"("titleHash");
CREATE INDEX "NewsArticle_publishedAt_idx" ON "NewsArticle"("publishedAt");
CREATE INDEX "NewsArticle_symbols_idx" ON "NewsArticle" USING GIN ("symbols");
