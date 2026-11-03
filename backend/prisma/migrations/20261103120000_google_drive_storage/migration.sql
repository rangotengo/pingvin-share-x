-- AlterTable
ALTER TABLE "File" ADD COLUMN "providerFileId" TEXT;

-- CreateTable
CREATE TABLE "DriveUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sessionUri" TEXT,
    "bytesSent" INTEGER NOT NULL DEFAULT 0,
    "remainder" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DriveUpload_shareId_idx" ON "DriveUpload"("shareId");
