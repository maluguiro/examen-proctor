/*
  Warnings:

  - You are about to drop the column `durationMinutes` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `reviewMode` on the `Exam` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "publicCode" TEXT NOT NULL,
    "durationMin" INTEGER,
    "durationMins" INTEGER,
    "lives" INTEGER NOT NULL DEFAULT 3,
    "pausesAllowed" BOOLEAN NOT NULL DEFAULT false,
    "forgiveLives" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "teacherName" TEXT,
    "subject" TEXT,
    "gradingMode" TEXT NOT NULL DEFAULT 'auto',
    "maxScore" INTEGER,
    "openAt" DATETIME
);
INSERT INTO "new_Exam" ("createdAt", "endsAt", "expiresAt", "forgiveLives", "gradingMode", "id", "lives", "maxScore", "openAt", "ownerId", "pausesAllowed", "publicCode", "startsAt", "status", "subject", "teacherName", "title", "updatedAt") SELECT "createdAt", "endsAt", "expiresAt", "forgiveLives", "gradingMode", "id", "lives", "maxScore", "openAt", "ownerId", "pausesAllowed", "publicCode", "startsAt", "status", "subject", "teacherName", "title", "updatedAt" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
CREATE UNIQUE INDEX "Exam_publicCode_key" ON "Exam"("publicCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
