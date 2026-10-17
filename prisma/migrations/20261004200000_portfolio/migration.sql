-- CreateEnum
CREATE TYPE "PortfolioTxType" AS ENUM ('BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'REVERSAL');

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Utama',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "cash" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holding" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "avgCost" DECIMAL(20,4) NOT NULL,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioTransaction" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "stockId" TEXT,
    "type" "PortfolioTxType" NOT NULL,
    "quantity" DECIMAL(20,4),
    "price" DECIMAL(20,4),
    "fees" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "cashDelta" DECIMAL(20,2) NOT NULL,
    "realizedPnl" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "qtyBefore" DECIMAL(20,4),
    "avgCostBefore" DECIMAL(20,4),
    "reversesId" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "marketValue" DECIMAL(20,2) NOT NULL,
    "cash" DECIMAL(20,2) NOT NULL,
    "costBasis" DECIMAL(20,2) NOT NULL,
    "unrealizedPnl" DECIMAL(20,2) NOT NULL,
    "realizedPnl" DECIMAL(20,2) NOT NULL,
    "unpriced" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_userId_name_key" ON "Portfolio"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Holding_portfolioId_stockId_key" ON "Holding"("portfolioId", "stockId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioTransaction_reversesId_key" ON "PortfolioTransaction"("reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioTransaction_idempotencyKey_key" ON "PortfolioTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PortfolioTransaction_portfolioId_createdAt_idx" ON "PortfolioTransaction"("portfolioId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_portfolioId_asOf_key" ON "PortfolioSnapshot"("portfolioId", "asOf");

-- AddForeignKey
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioTransaction" ADD CONSTRAINT "PortfolioTransaction_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioTransaction" ADD CONSTRAINT "PortfolioTransaction_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "Stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

