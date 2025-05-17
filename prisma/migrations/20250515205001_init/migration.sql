-- CreateTable
CREATE TABLE "torrent_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "infoHash" TEXT NOT NULL,
    "name" TEXT,
    "magnetURI" TEXT NOT NULL,
    "size" BIGINT,
    "dateAdded" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateCompleted" DATETIME,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "progress" REAL NOT NULL DEFAULT 0,
    "downloadSpeed" REAL,
    "uploadSpeed" REAL,
    "downloaded" BIGINT NOT NULL DEFAULT 0,
    "uploaded" BIGINT NOT NULL DEFAULT 0,
    "timeRemaining" INTEGER,
    "numPeers" INTEGER NOT NULL DEFAULT 0,
    "numSeeds" INTEGER NOT NULL DEFAULT 0,
    "saveLocation" TEXT,
    "metadata" TEXT
);

-- CreateTable
CREATE TABLE "torrent_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "progress" REAL NOT NULL DEFAULT 0,
    "isSelected" BOOLEAN NOT NULL DEFAULT true,
    "torrentId" TEXT NOT NULL,
    CONSTRAINT "torrent_files_torrentId_fkey" FOREIGN KEY ("torrentId") REFERENCES "torrent_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "torrent_records_infoHash_key" ON "torrent_records"("infoHash");
