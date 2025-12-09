/*
  Warnings:

  - You are about to drop the `Event` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Message` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Question` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `content` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `score` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `timeSpentMs` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `endAt` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `extraTimeSecs` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `livesUsed` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `paused` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `questionOrder` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `startAt` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `studentId` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `closedAt` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `durationMins` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `lives` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `ownerId` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `publicCode` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `retentionDays` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `settings` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Exam` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `Answer` table without a default value. This is not possible if the table is not empty.
  - Made the column `studentName` on table `Attempt` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `allowedTypes` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Exam` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "User_email_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Event";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Message";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Question";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "User";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "ExamQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "options" JSONB,
    "correctOptionIndex" INTEGER,
    "correctBoolean" BOOLEAN,
    "correctText" TEXT,
    "correctNumeric" REAL,
    "points" INTEGER NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttemptEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "meta" JSONB,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttemptEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Answer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" REAL,
    "valueIndex" INTEGER,
    "isCorrect" BOOLEAN,
    "pointsAwarded" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ExamQuestion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Answer" ("attemptId", "id", "isCorrect", "questionId") SELECT "attemptId", "id", "isCorrect", "questionId" FROM "Answer";
DROP TABLE "Answer";
ALTER TABLE "new_Answer" RENAME TO "Answer";
CREATE TABLE "new_Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ongoing',
    "livesLeft" INTEGER NOT NULL DEFAULT 0,
    "pausesUsed" INTEGER NOT NULL DEFAULT 0,
    "suspicionFlags" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "score" REAL,
    CONSTRAINT "Attempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attempt" ("examId", "id", "score", "status", "studentName") SELECT "examId", "id", "score", "status", "studentName" FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
CREATE TABLE "new_Exam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "allowedTypes" JSONB NOT NULL,
    "durationMinutes" INTEGER,
    "timeLimitMinutes" INTEGER,
    "isOpen" BOOLEAN NOT NULL DEFAULT false,
    "maxLives" INTEGER NOT NULL DEFAULT 0,
    "allowPauses" BOOLEAN NOT NULL DEFAULT false,
    "maxPauses" INTEGER NOT NULL DEFAULT 0,
    "forgiveMode" TEXT NOT NULL DEFAULT 'none',
    "gradingMode" TEXT NOT NULL DEFAULT 'auto',
    "showScoreAt" TEXT NOT NULL DEFAULT 'submit',
    "publicToken" TEXT,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Exam" ("createdAt", "id", "title") SELECT "createdAt", "id", "title" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
