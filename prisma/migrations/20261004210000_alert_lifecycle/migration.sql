-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertStatus" ADD VALUE 'PAUSED';
ALTER TYPE "AlertStatus" ADD VALUE 'EXPIRED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'MA_CROSS_ABOVE';
ALTER TYPE "AlertType" ADD VALUE 'MA_CROSS_BELOW';

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryError" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);


-- Existing live alerts get the default lifetime from now, so nothing expires at once on deploy.
UPDATE "Alert" SET "expiresAt" = now() + interval '90 days' WHERE "status" = 'ACTIVE' AND "expiresAt" IS NULL;
