-- CreateEnum
CREATE TYPE "ExamRole" AS ENUM ('OWNER', 'GRADER');

-- CreateTable
CREATE TABLE "ExamMember" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ExamRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamInvite" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "ExamRole" NOT NULL DEFAULT 'GRADER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamMember_examId_userId_key" ON "ExamMember"("examId", "userId");

-- CreateIndex
CREATE INDEX "ExamInvite_examId_idx" ON "ExamInvite"("examId");

-- CreateIndex
CREATE INDEX "ExamInvite_email_idx" ON "ExamInvite"("email");

-- AddForeignKey
ALTER TABLE "ExamMember" ADD CONSTRAINT "ExamMember_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamMember" ADD CONSTRAINT "ExamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamInvite" ADD CONSTRAINT "ExamInvite_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamInvite" ADD CONSTRAINT "ExamInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
