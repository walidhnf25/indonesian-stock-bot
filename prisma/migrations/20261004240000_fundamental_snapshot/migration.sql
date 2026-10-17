-- One fundamentals snapshot per stock per day (last-known figures when the provider is down).
-- CreateTable
CREATE TABLE "FundamentalSnapshot" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundamentalSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundamentalSnapshot_stockId_day_key" ON "FundamentalSnapshot"("stockId", "day");
CREATE INDEX "FundamentalSnapshot_stockId_asOf_idx" ON "FundamentalSnapshot"("stockId", "asOf");
CREATE INDEX "FundamentalSnapshot_asOf_idx" ON "FundamentalSnapshot"("asOf");

-- AddForeignKey
ALTER TABLE "FundamentalSnapshot" ADD CONSTRAINT "FundamentalSnapshot_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
