-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "totalChunks" INTEGER,
    "expectedChunkIndex" INTEGER NOT NULL DEFAULT 0,
    "committedBytes" INTEGER NOT NULL DEFAULT 0,
    "fileHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "S3Upload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "parts" TEXT NOT NULL DEFAULT '[]',
    "uploadedBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CleanupFailure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "shareId" TEXT,
    "fileId" TEXT,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "UploadSession_shareId_idx" ON "UploadSession"("shareId");

-- CreateIndex
CREATE INDEX "S3Upload_shareId_idx" ON "S3Upload"("shareId");

-- CreateIndex
CREATE INDEX "CleanupFailure_provider_idx" ON "CleanupFailure"("provider");

-- CreateIndex
CREATE INDEX "CleanupFailure_shareId_idx" ON "CleanupFailure"("shareId");
