-- Knowledge corpus, personal notes and hybrid retrieval (full text + pgvector).
-- Requires the vector extension (docker/postgres/Dockerfile builds it into the alpine image).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeScope" AS ENUM ('GLOBAL', 'USER');

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "scope" "KnowledgeScope" NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embeddingModel" TEXT,
    "embedding" vector,
    -- lexical channel: maintained by PostgreSQL, 'simple' config (no stemming; prefix matching covers affixes)
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_source_externalId_key" ON "KnowledgeDocument"("source", "externalId");
CREATE INDEX "KnowledgeDocument_userId_createdAt_idx" ON "KnowledgeDocument"("userId", "createdAt");
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_ordinal_key" ON "KnowledgeChunk"("documentId", "ordinal");
CREATE INDEX "KnowledgeChunk_embeddingModel_idx" ON "KnowledgeChunk"("embeddingModel");
CREATE INDEX "KnowledgeChunk_search_idx" ON "KnowledgeChunk" USING GIN ("search");
-- No ANN index on purpose: the corpus is small (hundreds of chunks) and the column is untyped so that
-- embedding models of different dimensions can coexist; add an HNSW index on a typed column when the
-- corpus grows past ~10k chunks.

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
