-- CreateTable
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "userId" TEXT NOT NULL,
    CONSTRAINT "AgentToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_tokenHash_key" ON "AgentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentToken_userId_idx" ON "AgentToken"("userId");
