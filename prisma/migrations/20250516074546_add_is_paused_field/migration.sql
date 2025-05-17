-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_torrent_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "infoHash" TEXT NOT NULL,
    "name" TEXT,
    "magnetURI" TEXT NOT NULL,
    "size" BIGINT,
    "dateAdded" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateCompleted" DATETIME,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "progress" REAL NOT NULL DEFAULT 0,
    "downloadSpeed" REAL,
    "uploadSpeed" REAL,
    "downloaded" BIGINT NOT NULL DEFAULT 0,
    "uploaded" BIGINT NOT NULL DEFAULT 0,
    "timeRemaining" BIGINT,
    "numPeers" INTEGER NOT NULL DEFAULT 0,
    "numSeeds" INTEGER NOT NULL DEFAULT 0,
    "saveLocation" TEXT,
    "metadata" TEXT
);
INSERT INTO "new_torrent_records" ("dateAdded", "dateCompleted", "downloadSpeed", "downloaded", "id", "infoHash", "isDeleted", "magnetURI", "metadata", "name", "numPeers", "numSeeds", "progress", "saveLocation", "size", "timeRemaining", "uploadSpeed", "uploaded") SELECT "dateAdded", "dateCompleted", "downloadSpeed", "downloaded", "id", "infoHash", "isDeleted", "magnetURI", "metadata", "name", "numPeers", "numSeeds", "progress", "saveLocation", "size", "timeRemaining", "uploadSpeed", "uploaded" FROM "torrent_records";
DROP TABLE "torrent_records";
ALTER TABLE "new_torrent_records" RENAME TO "torrent_records";
CREATE UNIQUE INDEX "torrent_records_infoHash_key" ON "torrent_records"("infoHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
