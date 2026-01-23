/*
  Warnings:

  - You are about to drop the `AttemptEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExamQuestion` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `createdAt` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `pointsAwarded` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `valueIndex` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `valueNumber` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `valueText` on the `Answer` table. All the data in the column will be lost.
  - You are about to drop the column `livesLeft` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `pausesUsed` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `startedAt` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `submittedAt` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `suspicionFlags` on the `Attempt` table. All the data in the column will be lost.
  - You are about to drop the column `allowPauses` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `allowedTypes` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `durationMinutes` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `forgiveMode` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `gradingMode` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `isOpen` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `maxLives` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `maxPauses` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `publicToken` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `showScoreAt` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `shuffleOptions` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `shuffleQuestions` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `timeLimitMinutes` on the `Exam` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Exam` table. All the data in the column will be lost.
  - Added the required column `studentId` to the `Attempt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `durationMins` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lives` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ownerId` to the `Exam` table without a default value. This is not possible if the table is not empty.
  - Added the required column `publicCode` to the `Exam` table without a default value. This is not possible if the table is not empty.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AttemptEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ExamQuestion";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "options" JSONB,
    "correct" JSONB,
    "points" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,
    CONSTRAINT "Event_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Answer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "content" JSONB,
    "isCorrect" BOOLEAN,
    "score" REAL,
    "timeSpentMs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Answer" ("attemptId", "id", "isCorrect", "questionId") SELECT "attemptId", "id", "isCorrect", "questionId" FROM "Answer";
DROP TABLE "Answer";
ALTER TABLE "new_Answer" RENAME TO "Answer";
CREATE UNIQUE INDEX "Answer_attemptId_questionId_key" ON "Answer"("attemptId", "questionId");
CREATE TABLE "new_Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "startAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" DATETIME,
    "score" REAL,
    "livesUsed" INTEGER NOT NULL DEFAULT 0,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "extraTimeSecs" INTEGER NOT NULL DEFAULT 0,
    "questionOrder" JSONB,
    CONSTRAINT "Attempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Attempt" ("examId", "id", "score", "status", "studentName") SELECT "examId", "id", "score", "status", "studentName" FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
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
INSERT INTO "new_Exam" ("createdAt", "id", "title") SELECT "createdAt", "id", "title" FROM "Exam";
DROP TABLE "Exam";
ALTER TABLE "new_Exam" RENAME TO "Exam";
CREATE UNIQUE INDEX "Exam_publicCode_key" ON "Exam"("publicCode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
