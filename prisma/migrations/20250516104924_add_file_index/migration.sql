-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_torrent_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "progress" REAL NOT NULL DEFAULT 0,
    "isSelected" BOOLEAN NOT NULL DEFAULT true,
    "index" INTEGER NOT NULL DEFAULT 0,
    "torrentId" TEXT NOT NULL,
    CONSTRAINT "torrent_files_torrentId_fkey" FOREIGN KEY ("torrentId") REFERENCES "torrent_records" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_torrent_files" ("id", "isSelected", "name", "path", "progress", "size", "torrentId") SELECT "id", "isSelected", "name", "path", "progress", "size", "torrentId" FROM "torrent_files";
DROP TABLE "torrent_files";
ALTER TABLE "new_torrent_files" RENAME TO "torrent_files";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
