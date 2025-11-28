/*
  Warnings:

  - You are about to drop the column `closedAt` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `durationMins` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `retentionDays` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `settings` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `correct` on the `Question` table. All the data in the column will be lost.
  - You are about to drop the column `order` on the `Question` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `Question` table. All the data in the column will be lost.

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
    "durationMinutes" INTEGER,
    "lives" INTEGER NOT NULL DEFAULT 3,
    "pausesAllowed" BOOLEAN NOT NULL DEFAULT false,
    "forgiveLives" BOOLEAN NOT NULL DEFAULT false,
    "gradingMode" TEXT NOT NULL DEFAULT 'auto',
    "reviewMode" TEXT NOT NULL DEFAULT 'manual',
    "openAt" DATETIME,
    "maxScore" INTEGER,
    "teacherName" TEXT,
    "subject" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME
);
INSERT INTO "new_Exam" ("createdAt", "id", "lives", "ownerId", "publicCode", "status", "title") SELECT "createdAt", "id", "lives", "ownerId", "publicCode", "status", "title" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
CREATE UNIQUE INDEX "Exam_publicCode_key" ON "Exam"("publicCode");
CREATE TABLE "new_Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL,
    "options" JSONB,
    "answerKey" JSONB,
    "points" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allowedKinds" JSONB,
    CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Question" ("examId", "id", "options", "points", "text") SELECT "examId", "id", "options", "points", "text" FROM "Question";
DROP TABLE "Question";
ALTER TABLE "new_Question" RENAME TO "Question";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
