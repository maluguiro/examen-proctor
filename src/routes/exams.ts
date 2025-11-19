import { Router } from "express";
import { prisma } from "../prisma";
import { ExamStatus } from "@prisma/client";
import crypto, { randomUUID } from "crypto";

// ===== DOCX exports (chat + review)
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

export const examsRouter = Router();

/* ──────────────────────────────────────────────────────────
   Utils
────────────────────────────────────────────────────────── */

function randomCode(len = 6) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len);
}

async function generateUniquePublicCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomCode(6);
    try {
      const clash = await prisma.exam.findFirst({
        where: { publicCode: code } as any,
      });
      if (!clash) return code;
    } catch {
      // si el schema no tiene columna publicCode, igual usamos el code
      return code;
    }
  }
  return randomCode(6);
}

/** Resolver examen por id / prefijo / publicCode / title */
async function findExamByCode(code: string) {
  try {
    const byId = await prisma.exam.findUnique({ where: { id: code } });
    if (byId) return byId;
  } catch {}

  try {
    const byPrefix = await prisma.exam.findFirst({
      where: { id: { startsWith: code } },
    });
    if (byPrefix) return byPrefix;
  } catch {}

  try {
    const byPublic = await prisma.exam.findFirst({
      where: { publicCode: code } as any,
    });
    if (byPublic) return byPublic;
  } catch {}

  try {
    const byTitle = await prisma.exam.findFirst({ where: { title: code } });
    if (byTitle) return byTitle;
  } catch {}

  return null;
}

/* ──────────────────────────────────────────────────────────
   EXAMS
────────────────────────────────────────────────────────── */

/** POST /api/exams  (crear examen con code único) */
examsRouter.post("/exams", async (req, res) => {
  try {
    const {
      title,
      lives = 3,
      durationMins,
      durationMin,
    } = (req.body ?? {}) as {
      title: string;
      lives?: number;
      durationMins?: number;
      durationMin?: number;
    };

    if (!title?.trim()) return res.status(400).json({ error: "FALTA_TITULO" });

    const ownerId = process.env.DEFAULT_OWNER_ID || "docente-local";
    const code6 = await generateUniquePublicCode();

    const exam = await prisma.exam.create({
      data: {
        title: title.trim(),
        status: ExamStatus.DRAFT,
        lives: Number(lives) || 3,
        durationMin: Number(durationMin ?? durationMins ?? 0) || null,
        ownerId,
        // @ts-ignore
        publicCode: code6,
      } as any,
      select: {
        id: true,
        title: true,
        status: true,
        lives: true,
        durationMin: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        // @ts-ignore
        publicCode: true,
      },
    });

    res.json({
      ...exam,
      code: (exam as any).publicCode || String(exam.id).slice(0, 6),
      durationMins: exam.durationMin ?? 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/exams  (lista mínima) */
examsRouter.get("/exams", async (_req, res) => {
  const items = await prisma.exam.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      // @ts-ignore
      publicCode: true,
    },
  });
  res.json(items);
});

/** GET /api/exams/by-code/:code  (detalle alumno) */
examsRouter.get("/exams/by-code/:code", async (req, res) => {
  const exam = await findExamByCode(req.params.code);
  if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

  res.json({
    exam: {
      ...exam,
      isOpen: String(exam.status).toLowerCase() === "open",
      durationMinutes: exam.durationMin ?? null,
      allowedTypes: [],
      // @ts-ignore
      code: exam.publicCode || String(exam.id).slice(0, 6),
      // @ts-ignore
      publicCode: exam.publicCode || null,
    },
  });
});

/** GET /api/exams/:code  (detalle tablero docente) */
examsRouter.get("/exams/:code", async (req, res) => {
  const exam = await findExamByCode(req.params.code);
  if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

  res.json({
    exam: {
      ...exam,
      isOpen: String(exam.status).toLowerCase() === "open",
      durationMinutes: exam.durationMin ?? null,
      allowedTypes: [],
      // @ts-ignore
      code: exam.publicCode || String(exam.id).slice(0, 6),
      // @ts-ignore
      publicCode: exam.publicCode || null,
    },
  });
});

/** PUT /api/exams/:code  (abrir/cerrar + duración + antifraude flags) */
examsRouter.put("/exams/:code", async (req, res) => {
  const {
    isOpen,
    durationMins,
    durationMinutes,
    durationMin,
    lives,
    pausesAllowed,
    forgiveLives,
  } = (req.body ?? {}) as {
    isOpen?: boolean;
    durationMins?: number;
    durationMinutes?: number;
    durationMin?: number;
    lives?: number;
    pausesAllowed?: boolean;
    forgiveLives?: boolean;
  };

  const exam = await findExamByCode(req.params.code);
  if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

  let nextStatus = exam.status as ExamStatus;
  if (typeof isOpen === "boolean")
    nextStatus = isOpen ? ExamStatus.OPEN : ExamStatus.CLOSED;

  const updated = await prisma.exam.update({
    where: { id: exam.id },
    data: {
      status: nextStatus,
      durationMin:
        Number(
          durationMin ??
            durationMinutes ??
            durationMins ??
            exam.durationMin ??
            0
        ) || null,
      lives:
        typeof lives === "number" ? Math.max(0, Math.floor(lives)) : exam.lives,
      // @ts-ignore
      pausesAllowed:
        typeof pausesAllowed === "boolean"
          ? pausesAllowed
          : (exam as any).pausesAllowed,
      // @ts-ignore
      forgiveLives:
        typeof forgiveLives === "boolean"
          ? forgiveLives
          : (exam as any).forgiveLives,
    } as any,
    select: {
      id: true,
      title: true,
      status: true,
      lives: true,
      durationMin: true,
      updatedAt: true,
      // @ts-ignore
      publicCode: true,
      // @ts-ignore
      pausesAllowed: true,
      // @ts-ignore
      forgiveLives: true,
    },
  });

  res.json({
    ...updated,
    isOpen: String(updated.status).toLowerCase() === "open",
    durationMinutes: updated.durationMin ?? null,
    allowedTypes: [],
    // @ts-ignore
    code: updated.publicCode || String(updated.id).slice(0, 6),
  });
});

/* ──────────────────────────────────────────────────────────
   EXAM META (docente, materia, modo corrección, nota máx, openAt)
   Tabla liviana: ExamMetaLite (raw SQL)
────────────────────────────────────────────────────────── */

async function ensureExamMetaTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ExamMetaLite" (
      examId TEXT PRIMARY KEY,
      teacherName TEXT,
      subject TEXT,
      gradingMode TEXT CHECK (gradingMode IN ('auto','manual')) DEFAULT 'auto',
      maxScore INTEGER DEFAULT 10,
      openAt DATETIME NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(examId) REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);
}

examsRouter.get("/exams/:code/meta", async (req, res) => {
  try {
    await ensureExamMetaTable();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT examId, teacherName, subject, gradingMode, maxScore, openAt
       FROM "ExamMetaLite" WHERE examId = ?`,
      exam.id
    );
    res.json({ meta: rows?.[0] ?? null });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

examsRouter.put("/exams/:code/meta", async (req, res) => {
  try {
    await ensureExamMetaTable();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const { teacherName, subject, gradingMode, maxScore, openAt } =
      req.body ?? {};

    let openAtIso: string | null = null;
    if (openAt) {
      try {
        const d = new Date(openAt);
        if (!isNaN(d.getTime())) openAtIso = d.toISOString();
      } catch {}
    }

    const exists: any[] = await prisma.$queryRawUnsafe(
      `SELECT examId FROM "ExamMetaLite" WHERE examId = ? LIMIT 1`,
      exam.id
    );

    if (exists?.[0]) {
      await prisma.$executeRawUnsafe(
        `UPDATE "ExamMetaLite"
         SET teacherName = COALESCE(?, teacherName),
             subject     = COALESCE(?, subject),
             gradingMode = COALESCE(?, gradingMode),
             maxScore    = COALESCE(?, maxScore),
             openAt      = ?
         WHERE examId = ?`,
        teacherName ?? null,
        subject ?? null,
        gradingMode ?? null,
        Number.isFinite(maxScore) ? Number(maxScore) : null,
        openAtIso,
        exam.id
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ExamMetaLite" (examId, teacherName, subject, gradingMode, maxScore, openAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        exam.id,
        teacherName ?? null,
        subject ?? null,
        gradingMode ?? "auto",
        Number.isFinite(maxScore) ? Number(maxScore) : 10,
        openAtIso
      );
    }

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT examId, teacherName, subject, gradingMode, maxScore, openAt
       FROM "ExamMetaLite" WHERE examId = ?`,
      exam.id
    );
    res.json({ meta: rows?.[0] ?? null });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ──────────────────────────────────────────────────────────
   QUESTIONS LITE (tabla liviana para paper/editor)
────────────────────────────────────────────────────────── */

async function ensureQuestionsLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "QuestionLite" (
      "id"         TEXT PRIMARY KEY,
      "examId"     TEXT NOT NULL,
      "kind"       TEXT NOT NULL DEFAULT 'MCQ',
      "stem"       TEXT NOT NULL DEFAULT '',
      "choices"    TEXT NULL,
      "answer"     TEXT NULL,
      "points"     INTEGER NOT NULL DEFAULT 1,
      "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const cols: any[] = await prisma.$queryRawUnsafe(
    `PRAGMA table_info("QuestionLite")`
  );
  const names = new Set((cols || []).map((c: any) => c.name));
  const alters: string[] = [];
  if (!names.has("id"))
    alters.push(`ALTER TABLE "QuestionLite" ADD COLUMN "id" TEXT`);
  if (!names.has("examId"))
    alters.push(`ALTER TABLE "QuestionLite" ADD COLUMN "examId" TEXT`);
  if (!names.has("kind"))
    alters.push(
      `ALTER TABLE "QuestionLite" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'MCQ'`
    );
  if (!names.has("stem"))
    alters.push(
      `ALTER TABLE "QuestionLite" ADD COLUMN "stem" TEXT NOT NULL DEFAULT ''`
    );
  if (!names.has("choices"))
    alters.push(`ALTER TABLE "QuestionLite" ADD COLUMN "choices" TEXT`);
  if (!names.has("answer"))
    alters.push(`ALTER TABLE "QuestionLite" ADD COLUMN "answer" TEXT`);
  if (!names.has("points"))
    alters.push(
      `ALTER TABLE "QuestionLite" ADD COLUMN "points" INTEGER NOT NULL DEFAULT 1`
    );
  if (!names.has("createdAt"))
    alters.push(
      `ALTER TABLE "QuestionLite" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`
    );

  for (const sql of alters) await prisma.$executeRawUnsafe(sql);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "idx_QuestionLite_examId" ON "QuestionLite"("examId");`
  );
}

async function ensureQuestionRuntimeColumns() {
  try {
    const tables: any[] = await prisma.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='Question'`
    );
    if (!tables?.length) return;

    const cols: any[] = await prisma.$queryRawUnsafe(
      `PRAGMA table_info("Question")`
    );
    const names = new Set((cols || []).map((c: any) => c.name));
    const alters: string[] = [];
    if (!names.has("stem"))
      alters.push(
        `ALTER TABLE "Question" ADD COLUMN "stem"   TEXT    NOT NULL DEFAULT ''`
      );
    if (!names.has("kind"))
      alters.push(
        `ALTER TABLE "Question" ADD COLUMN "kind"   TEXT    NOT NULL DEFAULT 'MCQ'`
      );
    if (!names.has("points"))
      alters.push(
        `ALTER TABLE "Question" ADD COLUMN "points" INTEGER NOT NULL DEFAULT 1`
      );
    if (!names.has("answer"))
      alters.push(`ALTER TABLE "Question" ADD COLUMN "answer" TEXT    NULL`);
    if (!names.has("choices"))
      alters.push(`ALTER TABLE "Question" ADD COLUMN "choices" TEXT   NULL`);
    for (const sql of alters) await prisma.$executeRawUnsafe(sql);
  } catch {}
}

/** POST /api/exams/:code/questions (crear) */
examsRouter.post("/exams/:code/questions", async (req, res) => {
  try {
    await ensureQuestionsLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const { kind, stem, choices, answer, points } = req.body ?? {};
    if (!kind || !stem?.trim())
      return res.status(400).json({ error: "FALTAN_CAMPOS" });

    const id = crypto.randomUUID();
    const choicesStr = Array.isArray(choices) ? JSON.stringify(choices) : null;
    let answerStr: string | null = null;
    if (answer !== undefined) answerStr = JSON.stringify(answer);

    await prisma.$executeRawUnsafe(
      `INSERT INTO QuestionLite (id, examId, kind, stem, choices, answer, points)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      exam.id,
      String(kind),
      String(stem),
      choicesStr,
      answerStr,
      Number(points) || 1
    );

    res.json({
      id,
      examId: exam.id,
      kind,
      stem,
      choices: choices ?? null,
      answer: answer ?? null,
      points: Number(points) || 1,
      createdAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** GET /api/exams/:code/questions (listar) */
examsRouter.get("/exams/:code/questions", async (req, res) => {
  try {
    await ensureQuestionsLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, examId, kind, stem, choices, answer, points
       FROM QuestionLite
       WHERE examId = ?
       ORDER BY rowid ASC`,
      exam.id
    );

    const safeJSON = (v: any) => {
      try {
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    };

    const items = (rows ?? []).map((r) => ({
      id: r.id,
      examId: r.examId,
      kind: r.kind,
      stem: r.stem || "",
      choices: safeJSON(r.choices),
      answer: safeJSON(r.answer),
      points: Number(r.points ?? 1) || 1,
    }));

    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** PUT /api/questions/:id (editar mínimo) */
examsRouter.put("/questions/:id", async (req, res) => {
  try {
    await ensureQuestionsLite();
    const { id } = req.params;
    const { stem, points } = req.body ?? {};

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id FROM QuestionLite WHERE id = ? LIMIT 1`,
      id
    );
    if (!rows?.[0])
      return res.status(404).json({ error: "QUESTION_NOT_FOUND" });

    await prisma.$executeRawUnsafe(
      `UPDATE QuestionLite SET
         stem   = COALESCE(?, stem),
         points = COALESCE(?, points)
       WHERE id = ?`,
      typeof stem === "string" ? stem : null,
      Number.isFinite(points) ? Number(points) : null,
      id
    );

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** DELETE /api/questions/:id */
examsRouter.delete("/questions/:id", async (req, res) => {
  try {
    await ensureQuestionsLite();
    const { id } = req.params;
    const del = await prisma.$executeRawUnsafe(
      `DELETE FROM QuestionLite WHERE id = ?`,
      id
    );
    res.json({ ok: true, deleted: Number(del) || 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────
   TABLERO — PARTICIPANTES (usar Attempt real)
────────────────────────────────────────────────────────── */

async function ensureAttemptLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS AttemptLite (
      id TEXT PRIMARY KEY,
      examId TEXT NOT NULL,
      studentName TEXT NOT NULL,
      livesRemaining INTEGER NOT NULL DEFAULT 3,
      paused BOOLEAN NOT NULL DEFAULT 0,
      violations TEXT NOT NULL DEFAULT '[]',
      startedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finishedAt DATETIME NULL,
      FOREIGN KEY(examId) REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);
}

async function ensureEventsLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "EventsLite" (
      "id"        TEXT PRIMARY KEY,
      "attemptId" TEXT NOT NULL,
      "type"      TEXT NOT NULL,
      "meta"      TEXT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "idx_EventsLite_attempt" ON "EventsLite"("attemptId");`
  );
}

/** GET /api/exams/:code/attempts — ahora desde Attempt (real) */
examsRouter.get("/exams/:code/attempts", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const attempts = await prisma.attempt.findMany({
      where: { examId: exam.id },
      orderBy: { startAt: "desc" },
      select: {
        id: true,
        studentName: true,
        status: true,
        startAt: true,
        endAt: true,
        livesUsed: true,
      },
    });

    const maxLives = exam.lives ?? 3;
    const shaped = attempts.map((a) => ({
      id: a.id,
      studentName: a.studentName,
      startedAt: a.startAt,
      finishedAt: a.endAt,
      status: a.status,
      livesRemaining: Math.max(0, maxLives - (a.livesUsed ?? 0)),
      paused: false, // (si más adelante agregamos flag real)
      violations: "[]",
    }));

    res.json({
      exam: {
        id: exam.id,
        // @ts-ignore
        code: exam.publicCode || String(exam.id).slice(0, 6),
        isOpen: String(exam.status).toLowerCase() === "open",
      },
      attempts: shaped,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────
   LADO ALUMNO — start / paper / events / answers / submit
────────────────────────────────────────────────────────── */

/** GET /api/exams/:code/paper */
examsRouter.get("/exams/:code/paper", async (req, res) => {
  try {
    await ensureQuestionsLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, kind, stem, choices, points
       FROM QuestionLite
       WHERE examId = ?
       ORDER BY rowid ASC`,
      exam.id
    );

    const safeJSON = (v: any) => {
      try {
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    };

    const questions = (rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      stem: r.stem || "",
      choices: safeJSON(r.choices),
      points: Number(r.points ?? 1) || 1,
    }));

    res.json({
      exam: {
        title: exam.title,
        code: (exam as any).publicCode || exam.id.slice(0, 6),
      },
      questions,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** POST /api/exams/:code/attempts/start
 *  { studentName }
 *  Crea Attempt (modelo real) **y** un espejo en AttemptLite con el MISMO id.
 */
examsRouter.post("/exams/:code/attempts/start", async (req, res) => {
  try {
    const { studentName } = req.body ?? {};
    const name = String(studentName || "").trim();
    if (!name) return res.status(400).json({ error: "MISSING_NAME" });

    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    // 1) Attempt real
    const studentId = `s-${randomUUID()}`;
    const attempt = await prisma.attempt.create({
      data: {
        examId: exam.id,
        studentId,
        studentName: name,
        status: "running",
        startAt: new Date(),
        endAt: null,
        score: null,
        livesUsed: 0,
        extraTimeSecs: 0,
        questionOrder: null,
      },
      select: { id: true, studentName: true, startAt: true },
    });

    // 2) Espejo en AttemptLite con **el mismo id** (para antifraude/eventos)
    await ensureAttemptLite();
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO AttemptLite (id, examId, studentName, livesRemaining, paused, violations)
       VALUES (?, ?, ?, ?, 0, '[]')`,
      attempt.id,
      exam.id,
      name,
      (exam as any).lives ?? 3
    );

    res.json({ attempt });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** POST /api/s/attempt/:id/event { type } — ANTIFRAUDE (sincroniza Attempt real) */
examsRouter.post("/s/attempt/:id/event", async (req, res) => {
  try {
    const { type } = req.body ?? {};
    if (!type) return res.status(400).json({ error: "MISSING_TYPE" });

    await ensureAttemptLite();
    await ensureEventsLite();

    // Intento Lite (si existe)
    const lite: any[] = await prisma.$queryRawUnsafe(
      `SELECT A.id, A.examId, A.livesRemaining, A.violations, E.lives AS examLives
       FROM AttemptLite A
       JOIN "Exam" E ON E.id = A.examId
       WHERE A.id = ? LIMIT 1`,
      req.params.id
    );

    if (lite?.[0]) {
      let lives = lite[0].livesRemaining ?? 0;
      let vlist: string[] = [];
      try {
        vlist = lite[0].violations ? JSON.parse(lite[0].violations) : [];
      } catch {}
      vlist.push(String(type));
      lives = Math.max(0, lives - 1);

      await prisma.$executeRawUnsafe(
        `UPDATE AttemptLite SET violations = ?, livesRemaining = ? WHERE id = ?`,
        JSON.stringify(vlist),
        lives,
        req.params.id
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO "EventsLite" (id, attemptId, type, meta) VALUES (?, ?, ?, ?)`,
        crypto.randomUUID(),
        req.params.id,
        String(type),
        null
      );
    }

    // Attempt real
    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (attempt) {
      const exam = await prisma.exam.findUnique({
        where: { id: attempt.examId },
      });
      const maxLives = exam?.lives ?? 3;
      const newLivesUsed = Math.min((attempt.livesUsed ?? 0) + 1, maxLives);
      const remaining = Math.max(0, maxLives - newLivesUsed);

      let status = attempt.status;
      let endAt: Date | null = attempt.endAt;

      if (remaining <= 0 && status !== "finished") {
        status = "finished";
        endAt = new Date();
      }

      await prisma.attempt.update({
        where: { id: attempt.id },
        data: { livesUsed: newLivesUsed, status, endAt },
      });

      return res.json({ ok: true, livesRemaining: remaining });
    }

    // si no existía Attempt real, respondemos ok por compat
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** POST /api/s/attempt/:id/answer { questionId, value } (lite) */
examsRouter.post("/s/attempt/:id/answer", async (req, res) => {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS AnswerLite (
      id TEXT PRIMARY KEY,
      attemptId TEXT NOT NULL,
      questionId TEXT NOT NULL,
      value TEXT NULL,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (attemptId, questionId)
    );
  `);

  const { questionId, value } = req.body ?? {};
  if (!questionId) return res.status(400).json({ error: "MISSING_QUESTION" });

  const val = JSON.stringify(value ?? null);

  const existing: any[] = await prisma.$queryRawUnsafe(
    `SELECT id FROM AnswerLite WHERE attemptId = ? AND questionId = ? LIMIT 1`,
    req.params.id,
    questionId
  );
  if (existing?.[0]) {
    await prisma.$executeRawUnsafe(
      `UPDATE AnswerLite SET value = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
      val,
      existing[0].id
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO AnswerLite (id, attemptId, questionId, value)
       VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(),
      req.params.id,
      questionId,
      val
    );
  }
  res.json({ ok: true });
});

/** POST /api/attempts/:id/submit { answers:[{questionId,value}] } */
examsRouter.post("/attempts/:id/submit", async (req, res) => {
  try {
    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    // gradingMode (ExamMetaLite)
    let gradingMode: "auto" | "manual" = "auto";
    try {
      const meta: any[] = await prisma.$queryRawUnsafe(
        `SELECT gradingMode FROM ExamMetaLite WHERE examId=? LIMIT 1`,
        exam.id
      );
      gradingMode = (meta?.[0]?.gradingMode || "auto").toLowerCase() as any;
    } catch {}

    const arr = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!arr.length) return res.status(400).json({ error: "NO_ANSWERS" });

    await ensureQuestionRuntimeColumns();

    // Preguntas desde tabla real "Question" (si existe), orden por rowid
    const qs: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, kind, points, answer FROM Question WHERE examId=? ORDER BY rowid ASC`,
      exam.id
    );

    const byId = new Map(qs.map((q) => [q.id, q]));
    let totalPoints = 0;
    let score = 0;

    for (const a of arr) {
      const q = byId.get(a.questionId);
      if (!q) continue;
      const pts = Number(q.points ?? 1) || 1;
      totalPoints += pts;

      let partial: number | null = null;

      if (gradingMode === "auto") {
        switch (q.kind) {
          case "TRUE_FALSE": {
            const correct = String(q.answer ?? "").toLowerCase();
            const given = String(a.value ?? "").toLowerCase();
            partial = given === correct ? pts : 0;
            break;
          }
          case "MCQ": {
            const correct = Number(q.answer ?? -1);
            const given = Number(a.value ?? -2);
            partial = given === correct ? pts : 0;
            break;
          }
          case "SHORT": {
            const correct = String(q.answer ?? "")
              .trim()
              .toLowerCase();
            const given = String(a.value ?? "")
              .trim()
              .toLowerCase();
            partial = correct && given && correct === given ? pts : 0;
            break;
          }
          case "FIB": {
            try {
              const expected: string[] = JSON.parse(String(q.answer || "[]"));
              const given: string[] = Array.isArray(a.value) ? a.value : [];
              let ok = 0;
              expected.forEach((exp, i) => {
                if (
                  (given[i] || "").toString().trim().toLowerCase() ===
                  String(exp).trim().toLowerCase()
                )
                  ok++;
              });
              partial = expected.length ? (pts * ok) / expected.length : 0;
            } catch {
              partial = 0;
            }
            break;
          }
          default:
            partial = 0;
        }
      }

      await prisma.answer.create({
        data: {
          attemptId: attempt.id,
          questionId: q.id,
          value:
            typeof a.value === "string"
              ? a.value
              : JSON.stringify(a.value ?? null),
          score: partial,
        },
      });

      if (typeof partial === "number") score += partial;
    }

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        status: "finished",
        endAt: new Date(),
        score: gradingMode === "auto" ? score : null,
      },
    });

    res.json({
      ok: true,
      gradingMode,
      score: gradingMode === "auto" ? score : null,
      maxScore: gradingMode === "auto" ? totalPoints : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** PATCH /api/attempts/:id/publish   { score, maxScore } (manual) */
examsRouter.patch("/attempts/:id/publish", async (req, res) => {
  try {
    const data: any = {
      /* published flag si lo tuvieses */
    };
    if (req.body?.score != null) data.score = Number(req.body.score);
    // maxScore persistente no está en Attempt real; lo manejamos en la review

    const at = await prisma.attempt.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ ok: true, attemptId: at.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** GET /api/attempts/:id/review  (auto) */
examsRouter.get("/attempts/:id/review", async (req, res) => {
  try {
    const at = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!at) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    const exam = await prisma.exam.findUnique({ where: { id: at.examId } });
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    let gradingMode: "auto" | "manual" = "auto";
    try {
      const meta: any[] = await prisma.$queryRawUnsafe(
        `SELECT gradingMode FROM ExamMetaLite WHERE examId=? LIMIT 1`,
        exam.id
      );
      gradingMode = (meta?.[0]?.gradingMode || "auto").toLowerCase() as any;
    } catch {}

    const canSee = gradingMode === "auto" && at.endAt != null;
    if (!canSee) return res.status(403).json({ error: "REVIEW_NOT_AVAILABLE" });

    const qs: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, kind, stem, choices, points, answer FROM Question WHERE examId=? ORDER BY rowid ASC`,
      at.examId
    );
    const ans: any[] = await prisma.$queryRawUnsafe(
      `SELECT questionId, value, score FROM Answer WHERE attemptId=?`,
      at.id
    );
    const byQ = new Map(ans.map((a) => [a.questionId, a]));

    const questions = qs.map((q) => {
      const a = byQ.get(q.id);
      let parsedChoices = null;
      try {
        parsedChoices = q.choices ? JSON.parse(q.choices) : null;
      } catch {}
      let parsedValue: any = a?.value;
      try {
        parsedValue = JSON.parse(a?.value);
      } catch {}
      return {
        id: q.id,
        kind: q.kind,
        stem: q.stem,
        choices: parsedChoices,
        points: q.points ?? 1,
        correct: q.answer ?? null,
        given: parsedValue ?? a?.value ?? null,
        score: a?.score ?? null,
      };
    });

    const sumPoints = questions.reduce((s, q) => s + Number(q.points ?? 1), 0);

    const payload = {
      exam: { title: exam.title, code: exam.id.slice(0, 6) },
      attempt: {
        id: at.id,
        studentName: at.studentName,
        startedAt: at.startAt,
        finishedAt: at.endAt,
        score: at.score,
        maxScore: sumPoints,
        published: true,
      },
      questions,
    };

    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** HTML print de review */
examsRouter.get("/attempts/:id/review.print", async (req, res) => {
  try {
    const r = await fetch(
      `http://localhost:${process.env.PORT || 3001}/api/attempts/${
        req.params.id
      }/review`
    );
    if (!r.ok) return res.status(r.status).send(await r.text());
    const data = await r.json();

    const esc = (s: any) =>
      String(s ?? "").replace(
        /[&<>"]/g,
        (c) =>
          (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[
            c
          ])
      );

    const started = new Date(data.attempt.startedAt);
    const finished = data.attempt.finishedAt
      ? new Date(data.attempt.finishedAt)
      : null;
    const diffMs = finished ? finished.getTime() - started.getTime() : 0;
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);

    const header = `
      <div><b>Comenzado el:</b> ${esc(started.toLocaleString())}</div>
      <div><b>Estado:</b> ${finished ? "Finalizado" : "En curso"}</div>
      <div><b>Finalizado en:</b> ${
        finished ? esc(finished.toLocaleString()) : "-"
      }</div>
      <div><b>Tiempo empleado:</b> ${
        finished ? `${mins} min ${secs} s` : "-"
      }</div>
      <div><b>Puntos:</b> ${data.attempt.score ?? "-"} / ${
      data.attempt.maxScore
    }</div>
    `;

    const body = data.questions
      .map((q: any, i: number) => {
        const num = i + 1;
        const corr = q.correct;
        const given = q.given;
        const ok =
          q.kind === "MCQ" || q.kind === "TRUE_FALSE"
            ? String(given) === String(corr)
            : q.score != null && q.score >= (q.points ?? 1);

        const verdict = ok ? "Correcta" : "Incorrecta";
        const head = `Pregunta ${num} — ${verdict} — Se puntúa ${
          q.score ?? 0
        } sobre ${q.points ?? 1}`;

        const renderChoices = () => {
          if (!q.choices) return "";
          return `<ul>${q.choices
            .map((c: string, idx: number) => {
              const mark =
                String(idx) === String(corr)
                  ? "✅"
                  : String(idx) === String(given)
                  ? "❌"
                  : "⬜";
              return `<li>${mark} ${esc(c)}</li>`;
            })
            .join("")}</ul>`;
        };

        const renderFIB = () => {
          if (q.kind !== "FIB") return "";
          try {
            const expected: string[] = Array.isArray(corr)
              ? corr
              : JSON.parse(String(corr || "[]"));
            const ans: string[] = Array.isArray(given)
              ? given
              : JSON.parse(String(given || "[]"));
            return `<div style="display:flex; gap:8px; flex-wrap:wrap;">${expected
              .map((_, ix) => {
                const g = esc(ans?.[ix] ?? "");
                const e = esc(expected[ix] ?? "");
                const hit =
                  (ans?.[ix] ?? "").toString().trim().toLowerCase() ===
                  (expected[ix] ?? "").toString().trim().toLowerCase();
                return `<div style="display:flex; flex-direction:column; align-items:flex-start; border:1px solid #ddd; padding:6px; border-radius:6px;">
                  <div style="font-size:12px;opacity:.7">Casillero ${
                    ix + 1
                  }</div>
                  <div><b>${g || "—"}</b> ${
                  hit ? "✅" : "❌"
                } <span style="opacity:.7">(Correcto: ${e})</span></div>
              </div>`;
              })
              .join("")}</div>`;
          } catch {
            return "";
          }
        };

        const renderShort = () => {
          if (q.kind !== "SHORT") return "";
          return `<div style="padding:6px;border:1px solid #eee;border-radius:6px;">
          <div style="font-size:12px;opacity:.7">Tu respuesta:</div>
          <div><b>${esc(given ?? "")}</b></div>
          ${
            corr
              ? `<div style="font-size:12px;opacity:.7;margin-top:4px">Correcta: <b>${esc(
                  corr
                )}</b></div>`
              : ""
          }
        </div>`;
        };

        return `
        <div class="q">
          <div class="qtitle">${esc(head)}</div>
          <div class="stem">${esc(q.stem)}</div>
          ${renderChoices()}
          ${renderFIB()}
          ${renderShort()}
        </div>`;
      })
      .join("");

    const html = `<!doctype html>
<html lang="es">
<meta charset="utf-8"/>
<title>Revisión — ${esc(data.exam.title)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; }
  h1 { margin: 0 0 8px; }
  .exam { color:#444; margin-bottom: 12px; }
  .hdr > div { margin: 2px 0; }
  .q { border:1px solid #e5e7eb; border-radius:10px; padding:12px; margin:12px 0; }
  .qtitle { font-weight:700; margin-bottom:6px; }
  .stem { margin-bottom:6px; }
  ul { margin: 6px 0 0 18px; }
</style>
<body>
  <h1>${esc(data.exam.title)}</h1>
  <div class="exam">Alumno: <b>${esc(data.attempt.studentName)}</b></div>
  <div class="hdr">${header}</div>
  ${body}
  <script>window.print()</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** DOCX (Word) de la revisión */
examsRouter.get("/attempts/:id/review.docx", async (req, res) => {
  try {
    const r = await fetch(
      `http://localhost:${process.env.PORT || 3001}/api/attempts/${
        req.params.id
      }/review`
    );
    if (!r.ok) return res.status(r.status).send(await r.text());
    const data = await r.json();

    const started = new Date(data.attempt.startedAt);
    const finished = data.attempt.finishedAt
      ? new Date(data.attempt.finishedAt)
      : null;

    const children: Paragraph[] = [
      new Paragraph({
        text: `Revisión — ${data.exam.title}`,
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({ text: `Alumno: ${data.attempt.studentName}` }),
      new Paragraph({ text: `Comenzado: ${started.toLocaleString()}` }),
      new Paragraph({
        text: `Finalizado: ${finished ? finished.toLocaleString() : "-"}`,
      }),
      new Paragraph({
        text: `Puntos: ${data.attempt.score ?? "-"} / ${data.attempt.maxScore}`,
      }),
      new Paragraph({ text: "" }),
    ];

    data.questions.forEach((q: any, i: number) => {
      const num = i + 1;
      const head = `Pregunta ${num} — Se puntúa ${q.score ?? 0} sobre ${
        q.points ?? 1
      }`;
      children.push(
        new Paragraph({ text: head, heading: HeadingLevel.HEADING_3 })
      );
      children.push(new Paragraph({ text: q.stem || "" }));
      if (q.kind === "MCQ" && Array.isArray(q.choices)) {
        q.choices.forEach((c: string, idx: number) => {
          const mark =
            String(idx) === String(q.correct)
              ? "✅"
              : String(idx) === String(q.given)
              ? "❌"
              : "⬜";
          children.push(new Paragraph({ text: `  ${mark} ${c}` }));
        });
      } else if (q.kind === "SHORT") {
        children.push(
          new Paragraph({ text: `Tu respuesta: ${q.given ?? ""}` })
        );
        if (q.correct)
          children.push(new Paragraph({ text: `Correcta: ${q.correct}` }));
      } else if (q.kind === "FIB") {
        try {
          const exp: string[] = Array.isArray(q.correct)
            ? q.correct
            : JSON.parse(String(q.correct || "[]"));
          const gv: string[] = Array.isArray(q.given)
            ? q.given
            : JSON.parse(String(q.given || "[]"));
          exp.forEach((e: string, ix: number) => {
            const g = gv?.[ix] ?? "";
            const hit =
              (g || "").toString().trim().toLowerCase() ===
              (e || "").toString().trim().toLowerCase();
            children.push(
              new Paragraph({
                text: `Casillero ${ix + 1}: ${g} ${
                  hit ? "✅" : "❌"
                } (Correcto: ${e})`,
              })
            );
          });
        } catch {}
      }
      children.push(new Paragraph({ text: "" }));
    });

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="revision-${req.params.id}.docx"`
    );
    res.end(buffer);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────
   CONTROLES DEL TABLERO (vidas / pausa / resume / +tiempo)
────────────────────────────────────────────────────────── */

/** POST /api/attempts/:id/lives  { op: "forgive"|"inc"|"dec" }  (REAL) */
examsRouter.post("/attempts/:id/lives", async (req, res) => {
  try {
    const { op } = req.body ?? {};
    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });
    const maxLives = exam?.lives ?? 3;

    let used = attempt.livesUsed ?? 0;
    if (op === "forgive" || op === "inc") used = Math.max(0, used - 1);
    if (op === "dec") used = Math.min(maxLives, used + 1);

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { livesUsed: used },
    });

    // espejo en AttemptLite si existe
    try {
      await ensureAttemptLite();
      const row: any[] = await prisma.$queryRawUnsafe(
        `SELECT id FROM AttemptLite WHERE id = ? LIMIT 1`,
        attempt.id
      );
      if (row?.[0]) {
        await prisma.$executeRawUnsafe(
          `UPDATE AttemptLite SET livesRemaining = ? WHERE id = ?`,
          Math.max(0, maxLives - used),
          attempt.id
        );
      }
    } catch {}

    res.json({ ok: true, livesRemaining: Math.max(0, maxLives - used) });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** (Opcional) + tiempo */
examsRouter.post("/attempts/:id/extra-time", async (req, res) => {
  try {
    const add = Number(req.body?.seconds ?? 0) || 0;
    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { extraTimeSecs: Math.max(0, (attempt.extraTimeSecs ?? 0) + add) },
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** pausa/resume (best-effort en AttemptLite para compat) */
examsRouter.post("/attempts/:id/pause", async (req, res) => {
  try {
    await ensureAttemptLite();
    await prisma.$executeRawUnsafe(
      `UPDATE AttemptLite SET paused = 1 WHERE id = ?`,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
examsRouter.post("/attempts/:id/resume", async (req, res) => {
  try {
    await ensureAttemptLite();
    await prisma.$executeRawUnsafe(
      `UPDATE AttemptLite SET paused = 0 WHERE id = ?`,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────
   CHAT LITE (docente/alumno) — con broadcast y export
────────────────────────────────────────────────────────── */

async function ensureChatLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ChatLite (
      id TEXT PRIMARY KEY,
      examId TEXT NOT NULL,
      fromRole TEXT NOT NULL,
      authorName TEXT NOT NULL,
      message TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      broadcast INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(examId) REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);

  try {
    const cols: any[] = await prisma.$queryRawUnsafe(
      `PRAGMA table_info('ChatLite');`
    );
    const hasBroadcast = cols?.some((c) => String(c.name) === "broadcast");
    if (!hasBroadcast) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ChatLite ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0;`
      );
    }
  } catch {}
}

examsRouter.get("/exams/:code/chat", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const sinceIso =
      typeof req.query.since === "string" ? req.query.since : null;
    const rows: any[] = sinceIso
      ? await prisma.$queryRawUnsafe(
          `SELECT id, fromRole, authorName, message, createdAt, broadcast
           FROM ChatLite
           WHERE examId = ? AND datetime(createdAt) > datetime(?)
           ORDER BY datetime(createdAt) ASC`,
          exam.id,
          sinceIso
        )
      : await prisma.$queryRawUnsafe(
          `SELECT id, fromRole, authorName, message, createdAt, broadcast
           FROM ChatLite
           WHERE examId = ?
           ORDER BY datetime(createdAt) ASC
           LIMIT 500`,
          exam.id
        );

    res.json({ items: rows ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.post("/exams/:code/chat", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const { fromRole, authorName, message } = req.body ?? {};
    const role = String(fromRole || "").toLowerCase();
    if (!["student", "teacher"].includes(role)) {
      return res.status(400).json({ error: "INVALID_ROLE" });
    }
    const name = String(authorName || "").trim();
    const msg = String(message || "").trim();
    if (!name || !msg) return res.status(400).json({ error: "MISSING_FIELDS" });

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO ChatLite (id, examId, fromRole, authorName, message, broadcast)
       VALUES (?, ?, ?, ?, ?, 0)`,
      id,
      exam.id,
      role,
      name,
      msg
    );

    res.json({ ok: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.post("/exams/:code/chat/broadcast", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const name = String(req.body?.authorName || "Docente").trim();
    const msg = String(req.body?.message || "").trim();
    if (!msg) return res.status(400).json({ error: "MISSING_MESSAGE" });

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO ChatLite (id, examId, fromRole, authorName, message, broadcast)
       VALUES (?, ?, 'teacher', ?, ?, 1)`,
      id,
      exam.id,
      name,
      msg
    );

    res.json({ ok: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.get("/exams/:code/chat.json", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, fromRole, authorName, message, createdAt, broadcast
       FROM ChatLite
       WHERE examId = ?
       ORDER BY datetime(createdAt) ASC`,
      exam.id
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="chat-${req.params.code}.json"`
    );
    res.end(JSON.stringify(rows, null, 2));
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.get("/exams/:code/chat.csv", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, fromRole, authorName, message, createdAt, broadcast
       FROM ChatLite
       WHERE examId = ?
       ORDER BY datetime(createdAt) ASC`,
      exam.id
    );

    const header = `id,fromRole,authorName,message,createdAt,broadcast`;
    const esc = (s: any) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const csv = [header]
      .concat(
        rows.map((r) =>
          [
            r.id,
            r.fromRole,
            r.authorName,
            r.message,
            r.createdAt,
            r.broadcast ? 1 : 0,
          ]
            .map(esc)
            .join(",")
        )
      )
      .join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="chat-${req.params.code}.csv"`
    );
    res.end(csv);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.get("/exams/:code/chat.docx", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, fromRole, authorName, message, createdAt, broadcast
       FROM ChatLite
       WHERE examId = ?
       ORDER BY datetime(createdAt) ASC`,
      exam.id
    );

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              text: `Chat del examen: ${req.params.code}`,
              heading: HeadingLevel.HEADING_1,
            }),
            new Paragraph({ text: `Generado: ${new Date().toLocaleString()}` }),
            new Paragraph({ text: "" }),
            ...rows.map((r) => {
              const prefix = r.broadcast ? "📢 " : "";
              const line = `${prefix}${r.authorName} (${new Date(
                r.createdAt
              ).toLocaleString()}): ${r.message}`;
              return new Paragraph({ children: [new TextRun(line)] });
            }),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="chat-${req.params.code}.docx"`
    );
    res.end(buffer);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

examsRouter.get("/exams/:code/chat.print", async (req, res) => {
  try {
    await ensureChatLite();
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, fromRole, authorName, message, createdAt, broadcast
       FROM ChatLite
       WHERE examId = ?
       ORDER BY datetime(createdAt) ASC`,
      exam.id
    );

    const esc = (s: any) =>
      String(s ?? "").replace(
        /[&<>"]/g,
        (c) =>
          (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[
            c
          ])
      );

    const html = `<!doctype html>
<html lang="es">
<meta charset="utf-8"/>
<title>Chat ${esc(req.params.code)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; }
  h1 { margin: 0 0 4px; }
  .meta { color:#666; margin-bottom: 16px; }
  .msg { border:1px solid #eee; border-radius:8px; padding:8px 10px; margin:8px 0; }
  .hdr { font-size:12px; color:#555; margin-bottom:4px; display:flex; gap:8px; align-items:center; }
  .bc  { font-weight:700; }
  .txt { white-space: pre-wrap; }
  .foot { margin-top: 24px; color:#777; font-size: 12px; }
</style>
<body>
  <h1>Chat del examen: ${esc(req.params.code)}</h1>
  <div class="meta">Generado: ${esc(new Date().toLocaleString())}</div>
  ${rows
    .map(
      (r) => `
    <div class="msg">
      <div class="hdr">
        ${r.broadcast ? `<span class="bc">📢 Broadcast</span>` : ``}
        <span>${esc(r.authorName)}</span>
        <span>•</span>
        <span>${esc(new Date(r.createdAt).toLocaleString())}</span>
      </div>
      <div class="txt">${esc(r.message)}</div>
    </div>`
    )
    .join("")}
  <div class="foot">Export imprimible — Use "Imprimir" → "Guardar como PDF".</div>
  <script>window.print()</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────
   EXTRA: endpoints crudos que ya usabas (opcionales)
────────────────────────────────────────────────────────── */

examsRouter.get("/debug", async (_req, res) => {
  // ojo con BigInt según tu DB
  const cnt = await prisma.exam.count();
  res.json({ ok: true, exams: cnt, now: new Date().toISOString() });
});
/** GET /api/attempts/:id/summary
 * Devuelve: { title, lives, livesUsed, remaining, status, paused, secondsLeft }
 * - Usa AttemptLite (tu versión) + Exam
 * - Calcula secondsLeft si hay durationMin y startedAt
 */
examsRouter.get("/attempts/:id/summary", async (req, res) => {
  try {
    // Traigo todo de una para no depender de más consultas
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT A.id, A.examId, A.livesRemaining, A.paused, A.startedAt,
              E.durationMin, E.status, E.title, E.lives AS examLives
       FROM AttemptLite A
       JOIN "Exam" E ON E.id = A.examId
       WHERE A.id = ?
       LIMIT 1`,
      req.params.id
    );

    const A = rows?.[0];
    if (!A) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    // Vidas: en Exam está la cantidad total; en AttemptLite guardás las restantes
    const lives = Number(A.examLives ?? 3);
    const remaining = Math.max(0, Number(A.livesRemaining ?? 0));
    const livesUsed = Math.max(0, lives - remaining);

    // Timer: si hay durationMin y tengo startedAt, calculo segundos restantes
    let secondsLeft: number | null = null;
    if (A.durationMin && A.startedAt) {
      const start = new Date(A.startedAt).getTime();
      const end = start + Number(A.durationMin) * 60_000;
      secondsLeft = Math.max(0, Math.floor((end - Date.now()) / 1000));
    }

    res.json({
      title: A.title,
      lives, // total asignadas al examen
      livesUsed, // derivado
      remaining, // restantes (lo que mostrás en la UI)
      status: String(A.status || "").toLowerCase(), // open|closed|draft...
      paused: !!A.paused,
      secondsLeft, // <- clave para el timer en el front
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

examsRouter.post("/attempts/:id/antifraud", async (req, res) => {
  try {
    const type = String(req.body?.type || "violation");
    // Reusamos la misma mecánica de /s/attempt/:id/event
    const row: any[] = await prisma.$queryRawUnsafe(
      `SELECT livesRemaining, violations FROM AttemptLite WHERE id = ? LIMIT 1`,
      req.params.id
    );
    if (!row?.[0]) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    let lives = row[0].livesRemaining ?? 0;
    let vlist: string[] = [];
    try {
      vlist = row[0].violations ? JSON.parse(row[0].violations) : [];
    } catch {}

    vlist.push(type);
    lives = Math.max(0, lives - 1);

    await prisma.$executeRawUnsafe(
      `UPDATE AttemptLite SET violations = ?, livesRemaining = ? WHERE id = ?`,
      JSON.stringify(vlist),
      lives,
      req.params.id
    );

    res.json({ ok: true, livesRemaining: lives });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});
