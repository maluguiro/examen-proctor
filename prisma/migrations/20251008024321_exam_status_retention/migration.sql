-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationMins" INTEGER NOT NULL,
    "lives" INTEGER NOT NULL,
    "publicCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "closedAt" DATETIME,
    "settings" JSONB
);
INSERT INTO "new_Exam" ("createdAt", "durationMins", "id", "lives", "ownerId", "publicCode", "settings", "title") SELECT "createdAt", "durationMins", "id", "lives", "ownerId", "publicCode", "settings", "title" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
CREATE UNIQUE INDEX "Exam_publicCode_key" ON "Exam"("publicCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
