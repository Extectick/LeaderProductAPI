CREATE TABLE "OnecConnection" (
  "userId" INTEGER NOT NULL,
  "baseKey" TEXT NOT NULL,
  "boundGuid" TEXT,
  "loginCipher" TEXT,
  "passwordCipher" TEXT,
  "loginSource" TEXT NOT NULL DEFAULT 'manual',
  "verifiedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "attemptWindow" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OnecConnection_pkey" PRIMARY KEY ("userId", "baseKey"),
  CONSTRAINT "OnecConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "OnecDirectoryEntry" (
  "baseKey" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "ibGuid" TEXT NOT NULL,
  "loginCipher" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OnecDirectoryEntry_pkey" PRIMARY KEY ("baseKey", "guid")
);
