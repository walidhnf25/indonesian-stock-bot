-- Exact cost basis per holding (order-independent average cost) and its "before" snapshot on the ledger.
-- AlterTable
ALTER TABLE "Holding" ADD COLUMN "costBasis" DECIMAL(20,2) NOT NULL DEFAULT 0;
ALTER TABLE "PortfolioTransaction" ADD COLUMN "costBasisBefore" DECIMAL(20,2);

-- Backfill from the rounded average: the best information the old rows have.
UPDATE "Holding" SET "costBasis" = round("quantity" * "avgCost", 2);
