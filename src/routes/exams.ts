// api/src/routes/exams.ts

import { Router } from "express";
import { prisma } from "../prisma";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { ExamRole, Prisma } from "@prisma/client";
import { authMiddleware, optionalAuthMiddleware } from "../authMiddleware"; // Necesario para asegurar user en request si se usa en rutas protegidas explícitas

export const examsRouter = Router();

type LiteColumns = Set<string>;
const globalAny = globalThis as any;

async function getLiteColumns(tableName: string): Promise<LiteColumns> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND lower(table_name) = lower($1)
    ORDER BY ordinal_position
  `,
    tableName
  );
  return new Set((rows ?? []).map((r) => String(r.column_name)));
}

async function logLiteSchemaOnce() {
  if (globalAny.__liteSchemaLogged) return;
  globalAny.__liteSchemaLogged = true;

  try {
    const questionCols = await getLiteColumns("QuestionLite");
    const chatCols = await getLiteColumns("ExamChatLite");
    console.log("LITE_SCHEMA", {
      QuestionLite: Array.from(questionCols),
      ExamChatLite: Array.from(chatCols),
    });
  } catch (e) {
    console.error("LITE_SCHEMA_LOG_ERROR", e);
  }
}

async function repairQuestionLiteSchema() {
  const cols = await getLiteColumns("QuestionLite");

  if (cols.has("examid") && !cols.has("examId")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "QuestionLite" RENAME COLUMN examid TO "examId";`
    );
  }
  if (cols.has("createdat") && !cols.has("createdAt")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "QuestionLite" RENAME COLUMN createdat TO "createdAt";`
    );
  }
}

async function repairExamChatLiteSchema() {
  const cols = await getLiteColumns("ExamChatLite");

  if (cols.has("examid") && !cols.has("examId")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ExamChatLite" RENAME COLUMN examid TO "examId";`
    );
  }
  if (cols.has("fromrole") && !cols.has("fromRole")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ExamChatLite" RENAME COLUMN fromrole TO "fromRole";`
    );
  }
  if (cols.has("authorname") && !cols.has("authorName")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ExamChatLite" RENAME COLUMN authorname TO "authorName";`
    );
  }
  if (cols.has("createdat") && !cols.has("createdAt")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ExamChatLite" RENAME COLUMN createdat TO "createdAt";`
    );
  }
}

function logRawError(route: string, sql: string, err: any) {
  if (process.env.NODE_ENV === "production") return;
  console.error("RAW_SQL_ERROR", {
    route,
    code: err?.code ?? null,
    message: err?.message ?? String(err),
    sql,
  });
}

function respondSanitizedError(
  res: any,
  err: any,
  fallbackError = "INTERNAL_ERROR"
) {
  const message = String(err?.message || err || "");
  if (process.env.NODE_ENV !== "production") {
    console.error("SERVER_ERROR", err);
  }
  if (
    message.includes("Authentication failed") ||
    message.includes("not available") ||
    message.includes("Can't reach database server")
  ) {
    return res.status(503).json({ error: "SERVICE_UNAVAILABLE" });
  }
  return res.status(500).json({ error: fallbackError });
}

async function hasExamRole(
  exam: { id: string; ownerId: string },
  userId: string,
  roles: ExamRole[]
): Promise<boolean> {
  const member = await prisma.examMember.findFirst({
    where: { examId: exam.id, userId },
    select: { role: true },
  });

  if (member && roles.includes(member.role)) return true;

  if (roles.includes(ExamRole.OWNER) && exam.ownerId === userId) return true;

  return false;
}

/* -------------------------------------------------------------------------- */
/*                        MODIFICACIÓN DE INTENTOS (DOCENTE)                  */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/attempts/:id/mod
 * Mofidica estado de un intento: pausa, vida, tiempo extra.
 * SEGURIDAD: Solo el dueño del examen puede tocar esto.
 */
examsRouter.post("/attempts/:id/mod", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { action, seconds } = req.body || {};
  const userId = req.user?.userId; // Garantizado por authMiddleware

  console.log("MOD_ATTEMPT", { attemptId: id, userId, action });

  try {
    // 1. Buscar intento y validar que el examen sea del usuario logueado
    const attempt = await prisma.attempt.findFirst({
      where: {
        id,
        exam: {
          ownerId: userId, // 🔒 SEGURIDAD CRÍTICA
        },
      },
      include: { exam: true },
    });

    if (!attempt) {
      console.warn("MOD_ATTEMPT_NOT_FOUND", { attemptId: id, userId });
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND_OR_FORBIDDEN" });
    }

    const data: any = {};
    const maxLives = attempt.exam.lives ?? 3;

    // 2. Aplicar acción
    switch (action) {
      case "forgive_life": {
        // Restar livesUsed (equivale a devolver una vida)
        // No puede ser menor a 0
        const current = attempt.livesUsed ?? 0;
        data.livesUsed = Math.max(0, current - 1);
        break;
      }

      case "add_time": {
        // Sumar segundos a extraTimeSecs
        const toAdd = Number(seconds);
        if (!isNaN(toAdd) && toAdd > 0) {
          data.extraTimeSecs = (attempt.extraTimeSecs ?? 0) + toAdd;
        }
        break;
      }

      case "pause": {
        data.paused = true;
        break;
      }

      case "resume": {
        data.paused = false;
        break;
      }

      default:
        return res.status(400).json({ error: "INVALID_ACTION" });
    }

    // 3. Guardar cambios
    const updated = await prisma.attempt.update({
      where: { id },
      data,
    });

    // Calcular remaining para devolver al front si hace falta (aunque el front suele recargar)
    const remaining = Math.max(0, maxLives - (updated.livesUsed ?? 0));

    return res.json({
      ok: true,
      attempt: {
        ...updated,
        livesRemaining: remaining,
      },
    });
  } catch (e: any) {
    console.error("MOD_ATTEMPT_ERROR", e);
    return res.status(500).json({ error: e?.message || "INTERNAL_ERROR" });
  }
});

/* --------------------------------- HELPERS -------------------------------- */

function normalizeCode(raw: string | string[] | undefined): string {
  if (!raw) return "";
  const code = Array.isArray(raw) ? raw[0] : raw;
  return String(code || "").trim();
}

/** Busca un examen por publicCode (principal) o por id/prefijo como fallback */
async function findExamByCode(codeRaw: string) {
  const code = normalizeCode(codeRaw);
  if (!code) return null;

  // 1) publicCode exacto (caso normal: link que comparte el docente)
  const byPublic = await prisma.exam.findFirst({
    where: { publicCode: code },
  });
  if (byPublic) return byPublic;

  // 2) id exacto
  const byId = await prisma.exam.findUnique({ where: { id: code } });
  if (byId) return byId;

  // 3) prefijo de id
  const byPrefix = await prisma.exam.findFirst({
    where: { id: { startsWith: code } },
  });
  if (byPrefix) return byPrefix;

  // 4) título exacto (por si alguien usa el título como "código")
  const byTitle = await prisma.exam.findFirst({
    where: {
      title: code, // case-sensitive, suficiente para fallback
    },
  });
  if (byTitle) return byTitle;
}

/** Devuelve el objeto que espera el front docente en `/exams/:code` */
function toExamResponse(exam: any) {
  const d = (exam as any).durationMin ?? (exam as any).durationMins ?? null;

  return {
    id: exam.id,
    title: exam.title,
    status: exam.status,
    // el front docente espera durationMinutes
    durationMinutes: typeof d === "number" ? d : null,
    lives: typeof exam.lives === "number" ? exam.lives : null,
    code: exam.publicCode ?? exam.id.slice(0, 6),
  };
}

/** Devuelve el objeto meta que espera el front en `/exams/:code/meta` */
function toMetaResponse(exam: any) {
  if (!exam) return null;
  const d = exam.durationMin ?? exam.durationMins ?? null;

  return {
    examId: exam.id,
    code: exam.publicCode ?? exam.id.slice(0, 6),
    title: exam.title ?? "(sin título)",
    status: exam.status ?? "DRAFT",
    durationMinutes: typeof d === "number" ? d : null,
    lives: typeof exam.lives === "number" ? exam.lives : null,
    teacherName: exam.teacherName ?? null,
    university: exam.university ?? null,
    subject: exam.subject ?? null,
    gradingMode:
      String(exam.gradingMode || "auto").toLowerCase() === "manual"
        ? ("manual" as const)
        : ("auto" as const),
    maxScore:
      typeof exam.maxScore === "number" && !isNaN(exam.maxScore)
        ? exam.maxScore
        : 0,
    openAt: exam.openAt ?? null,
    startsAt: exam.startsAt ?? null,
    endsAt: exam.endsAt ?? null,
    closeAt: exam.endsAt ?? null,
  };
}
function formatDateTimeShort(value: any): string {
  if (!value) return "—";
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "—";

    const pad = (n: number) => String(n).padStart(2, "0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());

    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "—";
  }
}

function computeDeadline(startAt: Date, durationMins: number, extraTimeSecs: number) {
  const totalMs = durationMins * 60 * 1000 + extraTimeSecs * 1000;
  return new Date(startAt.getTime() + totalMs);
}

function isExpired(now: Date, deadline: Date) {
  return now.getTime() >= deadline.getTime();
}

async function finalizeAttemptIfExpired(attempt: any, exam: any): Promise<any> {
  if (attempt.endAt) return attempt;

  const durationMin =
    (exam as any).durationMins ?? (exam as any).durationMin ?? null;
  if (!durationMin || durationMin <= 0 || !attempt.startAt) {
    if (process.env.NODE_ENV !== "production") {
      console.log("INVALID_DURATION", {
        examId: exam?.id,
        durationMins: (exam as any)?.durationMins ?? null,
        durationMin: (exam as any)?.durationMin ?? null,
        attemptId: attempt?.id,
        status: attempt?.status,
      });
    }
    return attempt;
  }

  const extraSecs = Number(attempt.extraTimeSecs ?? 0) || 0;
  const deadline = computeDeadline(attempt.startAt, durationMin, extraSecs);
  const now = new Date();

  if (!isExpired(now, deadline)) return attempt;

  const gm = String(exam.gradingMode || "auto").toLowerCase();
  if (gm !== "manual") {
    await ensureQuestionLite();

    const qs: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
    `,
      exam.id
    );

    const storedAnswers = await prisma.answer.findMany({
      where: { attemptId: attempt.id },
      select: { id: true, questionId: true, content: true },
    });
    const byQ = new Map(storedAnswers.map((a) => [a.questionId, a]));

    let totalPoints = 0;
    let score = 0;

    for (const q of qs) {
      const pts = Number(q.points ?? 1) || 1;
      totalPoints += pts;

      let correct: any = null;
      try {
        correct = q.answer ? JSON.parse(String(q.answer)) : null;
      } catch {
        correct = null;
      }

      const kind = normalizeQuestionKind(q.kind);
      const stored = byQ.get(q.id);
      const given = unwrapAnswerContent(stored?.content ?? null).value;

      let partial: number | null = null;

      if (kind === "TRUE_FALSE") {
        const givenStr = String(given ?? "").toLowerCase();
        const corr = String(correct ?? "").toLowerCase();
        partial = givenStr === corr ? pts : 0;
      } else if (kind === "MCQ") {
        const givenNum = Number(given ?? -999);
        const corrNum = Number(correct ?? -888);
        partial = givenNum === corrNum ? pts : 0;
      } else if (kind === "SHORT_TEXT") {
        const corr = String(correct ?? "").trim().toLowerCase();
        const givenStr = String(given ?? "").trim().toLowerCase();
        partial = corr && givenStr && corr === givenStr ? pts : 0;
      } else if (kind === "FILL_IN") {
        let expected: string[] = [];
        try {
          if (Array.isArray((correct as any)?.answers)) {
            expected = (correct as any).answers.map((x: any) =>
              String(x ?? "")
            );
          }
        } catch {
          expected = [];
        }

        let givenArr: string[] = [];
        if (Array.isArray(given)) {
          givenArr = given.map((v: any) => String(v ?? ""));
        } else if (given && Array.isArray((given as any).answers)) {
          givenArr = (given as any).answers.map((v: any) => String(v ?? ""));
        }

        let ok = 0;
        expected.forEach((exp, i) => {
          if (
            (givenArr[i] || "").toString().trim().toLowerCase() ===
            String(exp).trim().toLowerCase()
          ) {
            ok++;
          }
        });
        partial = expected.length ? (pts * ok) / expected.length : 0;
      }

      if (stored) {
        await prisma.answer.update({
          where: { id: stored.id },
          data: { score: partial },
        });
      }

      if (typeof partial === "number") {
        score += partial;
      }
    }

    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        status: "submitted",
        endAt: now,
        score,
      },
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("EXPIRE_ATTEMPT auto-submitted", {
        attemptId: attempt.id,
        deadline,
      });
    }

    return updated;
  }

  const updated = await prisma.attempt.update({
    where: { id: attempt.id },
    data: {
      status: "submitted",
      endAt: now,
      score: null,
    },
  });

  if (process.env.NODE_ENV !== "production") {
    console.log("EXPIRE_ATTEMPT manual-submitted", {
      attemptId: attempt.id,
      deadline,
    });
  }

  return updated;
}

function unwrapAnswerContent(content: any) {
  if (content && typeof content === "object" && "value" in content) {
    const wrapped = content as any;
    return {
      value: wrapped.value,
      teacherFeedback:
        typeof wrapped.teacherFeedback === "string"
          ? wrapped.teacherFeedback
          : null,
    };
  }
  return { value: content, teacherFeedback: null };
}

function wrapAnswerContent(existingContent: any, teacherFeedback?: string | null) {
  const { value } = unwrapAnswerContent(existingContent);
  if (teacherFeedback === undefined) return { value, teacherFeedback: null };
  if (teacherFeedback === null) return { value, teacherFeedback: null };
  return { value, teacherFeedback };
}

const OVERALL_FEEDBACK_QID = "__overall__";

function normalizeOverallFeedback(raw: any): string | null {
  if (raw === undefined) return null;
  if (raw === null) return "";
  return String(raw);
}

function extractOverallFeedback(content: any): string | null {
  if (content && typeof content === "object") {
    const tf = (content as any).teacherFeedback;
    if (typeof tf === "string") return tf;
  }
  return null;
}

/** Asegura la tabla QuestionLite (se comparte el formato con el builder) */
async function ensureQuestionLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "QuestionLite" (
      id        TEXT PRIMARY KEY,
      "examId"  TEXT NOT NULL,
      kind      TEXT NOT NULL, -- 'MCQ' | 'TRUE_FALSE' | 'SHORT_TEXT' | 'FILL_IN'
      stem      TEXT NOT NULL, -- enunciado
      choices   TEXT,          -- JSON string (solo MCQ / TRUE_FALSE)
      answer    TEXT,          -- JSON string (respuesta correcta)
      points    INTEGER NOT NULL DEFAULT 1,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY("examId") REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);

  await repairQuestionLiteSchema();
  await logLiteSchemaOnce();
}
async function ensureExamChatTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ExamChatLite" (
      "id" TEXT PRIMARY KEY,
      "examId" TEXT NOT NULL,
      "fromRole" TEXT NOT NULL,
      "authorName" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "broadcast" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY("examId") REFERENCES "Exam"("id") ON DELETE CASCADE
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "idx_ExamChatLite_exam_created"
    ON "ExamChatLite"("examId","createdAt");
  `);

  await repairExamChatLiteSchema();
  await logLiteSchemaOnce();
}
/**
 * GET /api/exams/by-code/:code
 * Endpoint público para que el alumno busque examen por su código.
 */
examsRouter.get("/exams/by-code/:code", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "Exam not found" });
    }

    const d = (exam as any).durationMin ?? (exam as any).durationMins ?? null;

    return res.json({
      exam: {
        id: exam.id,
        title: exam.title ?? "(sin título)",
        status: exam.status ?? "DRAFT",
        durationMinutes: typeof d === "number" ? d : null,
        lives:
          typeof (exam as any).lives === "number" ? (exam as any).lives : null,
        code: exam.publicCode ?? exam.id.slice(0, 6),
      },
    });
    } catch (e: any) {
      return respondSanitizedError(res, e, "GRADING_MANUAL_EXAMS_ERROR");
    }
  });

/**
 * GET /api/exams/:code
 * Devuelve la info básica del examen para la pantalla de configuración docente.
 */
examsRouter.get("/exams/:code", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    return res.json({ exam: toExamResponse(exam) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});
/** GET /api/exams/:code/chat  (lista los últimos mensajes del examen) */
examsRouter.get("/exams/:code/chat", async (req, res) => {
  let sql = "";
  try {
    await ensureExamChatTable();

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    // Traemos hasta 100 mensajes, ordenados por fecha
    sql = `
      SELECT "id", "fromRole", "authorName", "message", "broadcast", "createdAt"
      FROM "ExamChatLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
      LIMIT 100
    `;
    const rows: any[] = await prisma.$queryRawUnsafe(
      sql,
      exam.id
    );

    const items = (rows ?? []).map((r) => ({
      id: String(r.id),
      fromRole: r.fromRole === "teacher" ? "teacher" : "student",
      authorName: String(r.authorName ?? ""),
      message: String(r.message ?? ""),
      createdAt: String(r.createdAt ?? ""),
      broadcast: r.broadcast ? 1 : 0,
    }));

    return res.json({ items });
  } catch (e: any) {
    logRawError("/api/exams/:code/chat", sql, e);
    console.error("CHAT_LIST_ERROR", e);
    return res.status(500).json({ error: e?.message || "CHAT_LIST_ERROR" });
  }
});

/**
 * PUT /api/exams/:code
 * Actualiza configuración básica (título, duración, vidas, estado abierto/cerrado).
 * El front envía algo como:
 * {
 *   isOpen: true,
 *   title?: string,
 *   durationMinutes?: number,
 *   lives?: number
 * }
 */
examsRouter.put("/exams/:code", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const body = req.body ?? {};
    const data: any = {};

    // título
    if (typeof body.title === "string" && body.title.trim()) {
      data.title = body.title.trim();
    }

    // 🔹 duración: soportamos durationMinutes, durationMin, durationMins
    const durationRaw =
      body.durationMinutes ?? body.durationMin ?? body.durationMins ?? null;
    if (durationRaw !== null && durationRaw !== undefined) {
      const v = Number(durationRaw);
      if (!Number.isNaN(v) && v >= 0) {
        const mins = Math.floor(v);
        data.durationMin = mins;
        data.durationMins = mins;
      }
    }

    // vidas
    if (body.lives !== undefined && body.lives !== null) {
      const v = Math.max(0, Math.floor(Number(body.lives) || 0));
      data.lives = v;
    }

    // gradingMode: manual | auto
    if (body.gradingMode !== undefined) {
      const gm = String(body.gradingMode || "").toLowerCase();
      data.gradingMode = gm === "manual" ? "manual" : "auto";
    }

    // abrir/cerrar examen
    if (typeof body.isOpen === "boolean") {
      data.status = (body.isOpen ? "OPEN" : "DRAFT") as any;
    }

    const updated = await prisma.exam.update({
      where: { id: exam.id },
      data,
    });

    if (process.env.NODE_ENV !== "production" && data.gradingMode) {
      console.log("EXAM_GRADINGMODE_UPDATED", {
        examId: exam.id,
        gradingMode: data.gradingMode,
      });
    }

    return res.json({ exam: toExamResponse(updated) });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/exams/:code/meta
 * Devuelve datos del docente/materia/corrección.
 */
examsRouter.get("/exams/:code/meta", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "Exam not found" });

    const meta = toMetaResponse(exam);
    return res.json(meta);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * PUT /api/exams/:code/meta
 * Actualiza datos del docente + modo de corrección + nota máxima + openAt.
 */
examsRouter.put("/exams/:code/meta", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const body = req.body ?? {};
    const data: any = {};

    if (body.teacherName !== undefined) {
      data.teacherName =
        typeof body.teacherName === "string" && body.teacherName.trim()
          ? body.teacherName.trim()
          : null;
    }

    if (body.university !== undefined) {
      data.university =
        typeof body.university === "string" && body.university.trim()
          ? body.university.trim()
          : null;
    }

    if (body.subject !== undefined) {
      data.subject =
        typeof body.subject === "string" && body.subject.trim()
          ? body.subject.trim()
          : null;
    }

    if (body.gradingMode) {
      const gm = String(body.gradingMode || "").toLowerCase();
      data.gradingMode = gm === "manual" ? "manual" : "auto";
    }

    // duración (meta): soporta durationMin/durationMins
    const durationRaw =
      body.durationMin ?? body.durationMins ?? null;
    if (durationRaw !== null && durationRaw !== undefined) {
      const v = Number(durationRaw);
      if (!Number.isNaN(v) && v >= 0) {
        const mins = Math.floor(v);
        data.durationMin = mins;
        data.durationMins = mins;
      }
    }

    if (body.maxScore !== undefined && body.maxScore !== null) {
      const v = Number(body.maxScore);
      data.maxScore = Number.isNaN(v) ? null : Math.max(0, Math.floor(v));
    }

    if (body.openAt !== undefined) {
      if (!body.openAt) {
        data.openAt = null;
      } else {
        const d = new Date(body.openAt);
        if (!isNaN(d.getTime())) {
          data.openAt = d;
        }
      }
    }

    const startsAtInput =
      body.startsAt !== undefined ? body.startsAt : body.examOpenAt;
    if (startsAtInput !== undefined) {
      if (!startsAtInput) {
        data.startsAt = null;
      } else {
        const d = new Date(startsAtInput);
        if (!isNaN(d.getTime())) {
          data.startsAt = d;
        }
      }
    }

    const endsAtInput =
      body.endsAt !== undefined ? body.endsAt : body.examCloseAt;
    if (endsAtInput !== undefined) {
      if (!endsAtInput) {
        data.endsAt = null;
      } else {
        const d = new Date(endsAtInput);
        if (!isNaN(d.getTime())) {
          data.endsAt = d;
        }
      }
    }

    const updated = await prisma.exam.update({
      where: { id: exam.id },
      data,
    });

    return res.json({ meta: toMetaResponse(updated) });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/exams/:code/attempts
 * Usado por el TABLERO del docente.
 * Devuelve intentos con vidas, pausa y violaciones (a partir de Event).
 */
examsRouter.get("/exams/:code/attempts", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const isBandeja =
      String(req.query.view || "").toLowerCase() === "bandeja";
    const allowed = await hasExamRole(
      exam,
      userId,
      isBandeja
        ? [ExamRole.OWNER, ExamRole.GRADER, ExamRole.PROCTOR]
        : [ExamRole.OWNER, ExamRole.PROCTOR]
    );
    if (!allowed) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

      const attempts = await prisma.attempt.findMany({
        where: isBandeja
          ? {
              examId: exam.id,
              endAt: { not: null },
              status: { in: ["submitted", "in_review", "graded", "finished"] },
            }
          : { examId: exam.id },
      orderBy: isBandeja ? { endAt: "desc" } : { startAt: "asc" },
      select: {
        id: true,
        studentName: true,
        livesUsed: true,
        paused: true,
        startAt: true,
        endAt: true,
        status: true,
        score: true, // 👈 NUEVO: necesario para mostrar puntaje
        extraTimeSecs: true,
      },
    });

    const normalizedAttempts = await Promise.all(
      attempts.map(async (a) => {
        if (a.endAt) return a;

        let examForExpire: any = exam as any;
        if (examForExpire?.durationMin === undefined && examForExpire?.durationMins === undefined) {
          examForExpire = await prisma.exam.findUnique({
            where: { id: exam.id },
            select: { id: true, durationMin: true, durationMins: true, gradingMode: true },
          });
        }

        if (process.env.NODE_ENV !== "production") {
          console.log("EXPIRE_CHECK", {
            examId: exam.id,
            durationMins: (examForExpire as any)?.durationMins ?? null,
            durationMin: (examForExpire as any)?.durationMin ?? null,
            gradingMode: (examForExpire as any)?.gradingMode ?? null,
            attemptId: a.id,
            status: a.status,
          });
        }

        return await finalizeAttemptIfExpired(a as any, examForExpire as any);
      })
    );

    const ids = normalizedAttempts.map((a) => a.id);
    const events = await prisma.event.findMany({
      where: { attemptId: { in: ids } },
      select: { attemptId: true, type: true, reason: true, ts: true },
      orderBy: { ts: "asc" },
    });

    // Estructura intermedia para guardar la info procesada
    interface AttemptViolations {
      reasons: string[]; // para compatibilidad con lo anterior
      count: number;
      last: string | null;
      lastTs: Date | null;
      typesMap: Map<string, number>;
    }

    const byAttempt = new Map<string, AttemptViolations>();

    for (const ev of events) {
      if (!byAttempt.has(ev.attemptId)) {
        byAttempt.set(ev.attemptId, {
          reasons: [],
          count: 0,
          last: null,
          lastTs: null,
          typesMap: new Map(),
        });
      }
      const data = byAttempt.get(ev.attemptId)!;
      const r = ev.reason || ev.type || "UNKNOWN";

      // Compatibilidad
      data.reasons.push(r);

      // Nuevos cálculos
      data.count++;
      data.last = r;
      data.lastTs = ev.ts;

      const rUpper = r.toUpperCase();
      data.typesMap.set(rUpper, (data.typesMap.get(rUpper) ?? 0) + 1);
    }

    const out = normalizedAttempts.map((a) => {
      const used = a.livesUsed ?? 0;
      const maxLives = exam.lives ?? 3;
      const remaining = Math.max(0, maxLives - used);

      const vData = byAttempt.get(a.id);
      const violationTypes: { type: string; count: number }[] = [];

      if (vData) {
        for (const [t, c] of vData.typesMap.entries()) {
          violationTypes.push({ type: t, count: c });
        }
      }

      // Cálculo de lastActivityAt robusto
      const tStart = a.startAt ? new Date(a.startAt).getTime() : 0;
      const tEnd = a.endAt ? new Date(a.endAt).getTime() : 0;
      const tEvent = vData?.lastTs ? new Date(vData.lastTs).getTime() : 0;

      const maxTs = Math.max(tStart, tEnd, tEvent);

      return {
        id: a.id,
        studentName: a.studentName || "(sin nombre)",
        livesRemaining: remaining,
        livesUsed: a.livesUsed ?? 0, // 👈 Alineado con front
        score: a.score ?? null, // 👈 Alineado con front
        paused: !!a.paused,
        status: a.status ?? "in_progress",
        violations: JSON.stringify(vData?.reasons ?? []),
        violationsCount: vData?.count ?? 0,
        lastViolationReason: vData?.last ?? null,
        violationTypes,
        // Nuevo campo
        lastActivityAt: maxTs > 0 ? new Date(maxTs).toISOString() : null,

        startedAt: a.startAt ? a.startAt.toISOString() : null,
        finishedAt: a.endAt ? a.endAt.toISOString() : null,
      };
    });

      if (String(req.query.view || "").toLowerCase() === "bandeja") {
        const items = normalizedAttempts.map((a) => ({
          id: a.id,
          studentName: a.studentName || "(sin nombre)",
          studentEmail: null,
          submittedAt: a.endAt ?? null,
          status: a.status ?? "in_progress",
          score: a.score ?? null,
        }));
        return res.json({ items });
      }

    return res.json({
      exam: {
        id: exam.id,
        title: exam.title,
        status: exam.status,
        lives: exam.lives,
        code: exam.publicCode ?? exam.id.slice(0, 6),
      },
      attempts: out,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/grading/manual-exams
 * Lista exámenes en modo corrección manual con conteos de intentos.
 */
examsRouter.get("/grading/manual-exams", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const memberships = await prisma.examMember.findMany({
      where: {
        userId,
        role: { in: [ExamRole.OWNER, ExamRole.GRADER, ExamRole.PROCTOR] },
      },
      select: {
        examId: true,
        exam: {
          select: {
            id: true,
            ownerId: true,
            publicCode: true,
            title: true,
            gradingMode: true,
          },
        },
      },
    });

    const ownedExams = await prisma.exam.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        ownerId: true,
        publicCode: true,
        title: true,
        gradingMode: true,
      },
    });

    const byId = new Map<string, typeof ownedExams[number]>();
    for (const m of memberships) byId.set(m.exam.id, m.exam);
    for (const e of ownedExams) byId.set(e.id, e);

    const manualExams = Array.from(byId.values()).filter(
      (e) => String(e.gradingMode || "").toLowerCase() === "manual"
    );

    if (!manualExams.length) {
      return res.json([]);
    }

    // Optional backfill: asegurar ExamMember OWNER para exámenes propios
    const ownedManual = manualExams.filter((e) => e.ownerId === userId);
    if (ownedManual.length) {
      await Promise.all(
        ownedManual.map((e) =>
          prisma.examMember.upsert({
            where: { examId_userId: { examId: e.id, userId } },
            update: { role: ExamRole.OWNER },
            create: { examId: e.id, userId, role: ExamRole.OWNER },
          })
        )
      );
    }

    const examIds = manualExams.map((e) => e.id);

    const submittedAgg = await prisma.attempt.groupBy({
      by: ["examId"],
      where: {
        examId: { in: examIds },
        endAt: { not: null },
      },
      _count: { _all: true },
      _max: { endAt: true },
    });

    const pendingAgg = await prisma.attempt.groupBy({
      by: ["examId"],
      where: {
        examId: { in: examIds },
        endAt: { not: null },
        OR: [
          { status: { in: ["submitted", "in_review"] } },
          { score: null },
        ],
      },
      _count: { _all: true },
    });

    const submittedByExam = new Map(
      submittedAgg.map((a) => [
        a.examId,
        {
          submittedCount: a._count._all,
          lastSubmissionAt: a._max.endAt,
        },
      ])
    );

    const pendingByExam = new Map(
      pendingAgg.map((a) => [a.examId, a._count._all])
    );

    const items = manualExams.map((exam) => {
      const submitted = submittedByExam.get(exam.id);
      return {
        code: exam.publicCode ?? exam.id.slice(0, 6),
        title: exam.title,
        pendingCount: pendingByExam.get(exam.id) ?? 0,
        submittedCount: submitted?.submittedCount ?? 0,
        lastSubmissionAt: submitted?.lastSubmissionAt ?? null,
      };
    });

    return res.json(items);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * POST /api/exams/:code/invites
 * Body: { email, role? }
 */
examsRouter.post("/exams/:code/invites", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const allowed = await hasExamRole(exam, userId, [ExamRole.OWNER]);
    if (!allowed) return res.status(403).json({ error: "FORBIDDEN" });

    const rawEmail = String(req.body?.email ?? "").trim().toLowerCase();
    if (!rawEmail) return res.status(400).json({ error: "EMAIL_REQUIRED" });

    const rawRole = String(req.body?.role ?? "GRADER").toUpperCase();
    if (rawRole !== "GRADER" && rawRole !== "PROCTOR") {
      return res.status(400).json({ error: "INVALID_ROLE" });
    }
    const role =
      rawRole === "PROCTOR" ? ExamRole.PROCTOR : ExamRole.GRADER;

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.examInvite.create({
      data: {
        examId: exam.id,
        email: rawEmail,
        role,
        tokenHash,
        expiresAt,
        invitedByUserId: userId,
      },
    });

    const baseUrl =
      process.env.FRONTEND_BASE_URL?.trim() || "http://localhost:3000";
    const inviteLink = `${baseUrl}/invite?token=${token}`;

    return res.json({ ok: true, inviteLink, expiresAt });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("INVITE_CREATE_ERROR", e);
    }
    return res.status(500).json({ error: e?.message || "INVITE_CREATE_ERROR" });
  }
});

/**
 * POST /api/invites/accept
 * Body: { token }
 */
examsRouter.post("/invites/accept", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const userEmail = String(req.user?.email ?? "").trim().toLowerCase();
    if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

    const token = String(req.body?.token ?? "").trim();
    if (!token) return res.status(400).json({ error: "TOKEN_REQUIRED" });

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const invite = await prisma.examInvite.findFirst({
      where: {
        tokenHash,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        exam: { select: { publicCode: true } },
      },
    });
    if (!invite) return res.status(404).json({ error: "INVITE_NOT_FOUND" });

    if (invite.email.trim().toLowerCase() !== userEmail) {
      return res.status(403).json({ error: "EMAIL_MISMATCH" });
    }

    await prisma.examMember.upsert({
      where: {
        examId_userId: { examId: invite.examId, userId },
      },
      update: { role: invite.role },
      create: {
        examId: invite.examId,
        userId,
        role: invite.role,
      },
    });

    await prisma.examInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    return res.json({
      ok: true,
      examCode: invite.exam.publicCode,
      role: invite.role,
    });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("INVITE_ACCEPT_ERROR", e);
    }
    return res.status(500).json({ error: e?.message || "INVITE_ACCEPT_ERROR" });
  }
});
/**
 * GET /api/exams/:code/activity.pdf
 * Genera un PDF con:
 *  - Info del examen
 *  - Intentos + resumen antifraude
 *  - Chat del examen
 */
examsRouter.get("/exams/:code/activity.pdf", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    // ---------- Intentos + eventos antifraude ----------
    const attempts = await prisma.attempt.findMany({
      where: { examId: exam.id },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        studentName: true,
        livesUsed: true,
        paused: true,
        startAt: true,
        endAt: true,
        status: true,
      },
    });

    const attemptIds = attempts.map((a) => a.id);

    const events =
      attemptIds.length > 0
        ? await prisma.event.findMany({
          where: { attemptId: { in: attemptIds } },
          select: {
            attemptId: true,
            type: true,
            reason: true,
          },
        })
        : [];

    const eventsByAttempt = new Map<
      string,
      { type: string; reason: string | null }[]
    >();

    for (const ev of events) {
      const arr = eventsByAttempt.get(ev.attemptId) ?? [];
      arr.push({
        type: ev.type,
        reason: ev.reason ?? null,
      });
      eventsByAttempt.set(ev.attemptId, arr);
    }

    const maxLives = (exam as any).lives != null ? Number(exam.lives) : 3;

    // ---------- Chat ----------
    await ensureExamChatTable();
    const chatRows: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT "id", "fromRole", "authorName", "message", "broadcast", "createdAt"
      FROM "ExamChatLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
    `,
      exam.id
    );

    // ---------- Armamos el PDF ----------
    const doc = new PDFDocument({ margin: 50 });

    const code =
      exam.publicCode ?? (exam.id ? exam.id.slice(0, 6) : String(exam.id));

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="actividad-${code}.pdf"`
    );

    // Pipea la salida al response
    (doc as any).pipe(res);

    // TÍTULO
    doc.fontSize(18).text(`Registro de actividad — ${exam.title || code}`, {
      align: "center",
    });
    doc.moveDown();

    // Info básica del examen
    doc.fontSize(12);
    doc.text(`Código: ${code}`);
    if ((exam as any).teacherName) {
      doc.text(`Docente: ${(exam as any).teacherName}`);
    }
    if ((exam as any).subject) {
      doc.text(`Materia: ${(exam as any).subject}`);
    }
    if ((exam as any).durationMinutes != null) {
      doc.text(`Duración: ${(exam as any).durationMinutes} minutos`);
    }
    doc.text(`Vidas configuradas: ${maxLives}`);
    doc.moveDown();

    // ===================== SECCIÓN INTENTOS =====================
    doc.fontSize(14).text("Intentos de alumnos", { underline: true });
    doc.moveDown(0.5);

    if (attempts.length === 0) {
      doc.fontSize(12).text("No hay intentos registrados para este examen.");
    } else {
      attempts.forEach((a, index) => {
        const used = a.livesUsed ?? 0;
        const remaining = Math.max(0, maxLives - used);
        const evs = eventsByAttempt.get(a.id) ?? [];

        doc
          .fontSize(12)
          .text(`${index + 1}. Alumno: ${a.studentName || "(sin nombre)"}`);
        doc.text(`   Estado: ${a.status ?? "in_progress"}`);
        doc.text(`   Inicio: ${formatDateTimeShort(a.startAt)}`);
        doc.text(`   Fin: ${formatDateTimeShort(a.endAt)}`);
        doc.text(`   Vidas restantes: ${remaining}`);
        if (a.paused) {
          doc.text(`   (Intento pausado)`);
        }

        if (evs.length > 0) {
          const frases = evs.map((ev) =>
            ev.reason ? `${ev.type} (${ev.reason})` : ev.type
          );
          doc.text(`   Eventos antifraude: ${frases.join(", ")}`);
        }

        doc.moveDown(0.6);
      });
    }

    // ===================== SECCIÓN CHAT =====================
    doc.addPage();
    doc.fontSize(14).text("Chat del examen", { underline: true });
    doc.moveDown(0.5);

    if (!chatRows.length) {
      doc.fontSize(12).text("No hubo mensajes en el chat.");
    } else {
      chatRows.forEach((m: any) => {
        const when = formatDateTimeShort(m.createdAt);
        const role =
          m.fromRole === "teacher"
            ? "Docente"
            : m.fromRole === "student"
              ? "Alumno"
              : String(m.fromRole || "");
        const broadcast = m.broadcast ? " · 📢 broadcast" : "";
        const author = `${m.authorName || "(sin nombre)"
          } (${role}${broadcast})`;

        doc.fontSize(11).text(`[${when}] ${author}`);
        doc.text(`   ${m.message}`);
        doc.moveDown(0.4);
      });
    }

    // Cerramos el doc
    doc.end();
  } catch (e: any) {
    console.error("ACTIVITY_PDF_ERROR", e);
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ error: e?.message || "ACTIVITY_PDF_ERROR" });
    }
  }
});

/**
 * POST /api/exams/:code/attempts/mock
 * Crea un intento "falso" para probar el tablero.
 */
examsRouter.post("/exams/:code/attempts/mock", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const name = String(req.body?.studentName || "").trim() || "Alumno demo";

    const attempt = await prisma.attempt.create({
      data: {
        examId: exam.id,
        studentId: `mock-${crypto.randomUUID()}`,
        studentName: name,
        status: "in_progress",
        startAt: new Date(),
        livesUsed: 0,
        paused: false,
        extraTimeSecs: 0,
        questionOrder: Prisma.DbNull,
      },
      select: {
        id: true,
        studentName: true,
        startAt: true,
      },
    });

    return res.json({ attempt });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});
/**
 * POST /api/exams/:code/chat
 * Body: { fromRole: 'student' | 'teacher'; authorName: string; message: string }
 */
examsRouter.post("/exams/:code/chat", async (req, res) => {
  let sql = "";
  try {
    await ensureExamChatTable();

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const { fromRole, authorName, message } = req.body ?? {};
    const role = String(fromRole || "").toLowerCase();
    const name = String(authorName || "").trim();
    const text = String(message || "").trim();

    if (!name || !text) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }
    if (role !== "student" && role !== "teacher") {
      return res.status(400).json({ error: "INVALID_ROLE" });
    }

    const id = crypto.randomUUID();

    sql = `
      INSERT INTO "ExamChatLite"
        ("id", "examId", "fromRole", "authorName", "message", "broadcast")
      VALUES ($1, $2, $3, $4, $5, 0)
    `;
    await prisma.$executeRawUnsafe(
      sql,
      id,
      exam.id,
      role,
      name,
      text
    );

    return res.json({ ok: true, id });
  } catch (e: any) {
    logRawError("/api/exams/:code/chat", sql, e);
    console.error("CHAT_SEND_ERROR", e);
    return res.status(500).json({ error: e?.message || "CHAT_SEND_ERROR" });
  }
});
/**
 * POST /api/exams/:code/chat/broadcast
 * Body: { authorName: string; message: string }
 * fromRole se fuerza a 'teacher' y broadcast = 1
 */
examsRouter.post("/exams/:code/chat/broadcast", async (req, res) => {
  let sql = "";
  try {
    await ensureExamChatTable();

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const { authorName, message } = req.body ?? {};
    const name = String(authorName || "").trim();
    const text = String(message || "").trim();

    if (!name || !text) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const id = crypto.randomUUID();

    sql = `
      INSERT INTO "ExamChatLite"
        ("id", "examId", "fromRole", "authorName", "message", "broadcast")
      VALUES ($1, $2, 'teacher', $3, $4, 1)
    `;
    await prisma.$executeRawUnsafe(
      sql,
      id,
      exam.id,
      name,
      text
    );

    return res.json({ ok: true, id });
  } catch (e: any) {
    logRawError("/api/exams/:code/chat/broadcast", sql, e);
    console.error("CHAT_BROADCAST_ERROR", e);
    return res
      .status(500)
      .json({ error: e?.message || "CHAT_BROADCAST_ERROR" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               RUTAS ALUMNO                                 */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/exams/:code/attempts/start
 * Crea un Attempt real para el alumno.
 */
// POST /api/exams/:code/attempts/start
// POST /api/exams/:code/attempts/start
examsRouter.post("/exams/:code/attempts/start", async (req, res) => {
  try {
    const { studentName, studentEmail } = req.body ?? {};
    const email = String(studentEmail || "").trim().toLowerCase();
    const name = String(studentName || "").trim();
    if (!email && !name) {
      return res.status(400).json({ error: "MISSING_NAME" });
    }

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const studentKey = email ? `email:${email}` : `name:${name}`;

    const inProgress = await prisma.attempt.findFirst({
      where: {
        examId: exam.id,
        studentId: studentKey,
        status: "in_progress",
        endAt: null,
      },
    });

    if (inProgress) {
      const maybeFinal = await finalizeAttemptIfExpired(
        inProgress as any,
        exam as any
      );
      if (maybeFinal.endAt) {
        return res
          .status(409)
          .json({ error: "ATTEMPT_ALREADY_SUBMITTED" });
      }
      return res.json({
        attempt: {
          id: inProgress.id,
          studentName: inProgress.studentName,
          startAt: inProgress.startAt,
        },
      });
    }

    const alreadySubmitted = await prisma.attempt.findFirst({
      where: {
        examId: exam.id,
        studentId: studentKey,
        OR: [
          { endAt: { not: null } },
          { status: { in: ["submitted", "in_review", "graded"] } },
        ],
      },
    });

    if (alreadySubmitted) {
      return res.status(409).json({ error: "ATTEMPT_ALREADY_SUBMITTED" });
    }

    const now = new Date();
    if (exam.startsAt instanceof Date && now < exam.startsAt) {
      return res.status(403).json({
        error: "EXAM_NOT_OPEN",
        startsAt: exam.startsAt.toISOString(),
      });
    }
    if (exam.endsAt instanceof Date && now > exam.endsAt) {
      return res.status(403).json({
        error: "EXAM_CLOSED",
        endsAt: exam.endsAt.toISOString(),
      });
    }

    const studentId = studentKey;

    const attempt = await prisma.attempt.create({
      data: {
        examId: exam.id,
        studentId,
        studentName: name || email,
        status: "in_progress", // usá el mismo string que ya venías usando
        startAt: new Date(),
        endAt: null,
        score: null,
        livesUsed: 0,
        paused: false,
        extraTimeSecs: 0,
        questionOrder: Prisma.DbNull,
      },
      select: {
        id: true,
        studentName: true,
        startAt: true,
      },
    });

    return res.json({ attempt });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/attempts/:id/summary
 * Devuelve:
 *  - remaining: vidas restantes
 *  - secondsLeft: segundos restantes de examen
 */
examsRouter.get("/attempts/:id/summary", async (req, res) => {
  try {
    let attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });

    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });

    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    let examForExpire: any = exam as any;
    if (examForExpire?.durationMin === undefined && examForExpire?.durationMins === undefined) {
      examForExpire = await prisma.exam.findUnique({
        where: { id: exam.id },
        select: { id: true, durationMin: true, durationMins: true, gradingMode: true },
      });
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("EXPIRE_CHECK", {
        examId: exam.id,
        durationMins: (examForExpire as any)?.durationMins ?? null,
        durationMin: (examForExpire as any)?.durationMin ?? null,
        gradingMode: (examForExpire as any)?.gradingMode ?? null,
        attemptId: attempt.id,
        status: attempt.status,
      });
    }

    attempt = await finalizeAttemptIfExpired(attempt as any, examForExpire as any);
    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    // VIDAS: Exam.lives - Attempt.livesUsed
    const maxLives = (exam as any).lives != null ? (exam as any).lives : 3;
    const used =
      (attempt as any).livesUsed != null ? (attempt as any).livesUsed : 0;

    const remaining = Math.max(0, maxLives - used);

    // TIEMPO
    const durationMin =
      (exam as any).durationMins ?? (exam as any).durationMin ?? null;

    let secondsLeft: number | null = null;

    if (durationMin != null && attempt.startAt) {
      const totalSecs =
        durationMin * 60 + ((attempt as any).extraTimeSecs ?? 0);

      const elapsedSecs = Math.floor(
        (Date.now() - attempt.startAt.getTime()) / 1000
      );

      secondsLeft = Math.max(0, totalSecs - elapsedSecs);
    }

    return res.json({ remaining, secondsLeft });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "SUMMARY_ERROR" });
  }
});

/**
 * PATCH /api/attempts/:attemptId/draft
 * Body: { answers: [{ questionId, value }] }
 */
examsRouter.patch("/attempts/:attemptId/draft", async (req, res) => {
  try {
    const attemptId = String(req.params.attemptId || "").trim();
    if (!attemptId) {
      return res.status(400).json({ error: "ATTEMPT_ID_REQUIRED" });
    }

    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      select: { id: true, status: true, endAt: true },
    });
    if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    if (attempt.endAt || attempt.status !== "in_progress") {
      return res.status(409).json({ error: "ATTEMPT_CLOSED" });
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!answers) {
      return res.status(400).json({ error: "ANSWERS_REQUIRED" });
    }
    if (answers.length > 200) {
      return res.status(400).json({ error: "ANSWERS_TOO_LARGE" });
    }

    for (const item of answers) {
      const questionId = String(item?.questionId || "").trim();
      if (!questionId) continue;

      const value = item?.value ?? null;
      const size = JSON.stringify(value ?? null).length;
      if (size > 20000) {
        return res.status(400).json({ error: "ANSWER_VALUE_TOO_LARGE" });
      }

      await prisma.answer.upsert({
        where: { attemptId_questionId: { attemptId, questionId } },
        update: {
          content: value === null ? Prisma.DbNull : value,
        },
        create: {
          attemptId,
          questionId,
          content: value === null ? Prisma.DbNull : value,
        },
      });
    }

    return res.json({ ok: true });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("DRAFT_SAVE_ERROR", e);
    }
    return res.status(500).json({ error: e?.message || "DRAFT_SAVE_ERROR" });
  }
});

/**
 * GET /api/attempts/:attemptId/draft
 */
examsRouter.get("/attempts/:attemptId/draft", async (req, res) => {
  try {
    const attemptId = String(req.params.attemptId || "").trim();
    if (!attemptId) {
      return res.status(400).json({ error: "ATTEMPT_ID_REQUIRED" });
    }

    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
      select: { id: true },
    });
    if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    const rows = await prisma.answer.findMany({
      where: { attemptId },
      select: { questionId: true, content: true },
    });

    const answers = rows.map((r) => ({
      questionId: r.questionId,
      value: unwrapAnswerContent(r.content).value ?? null,
    }));

    return res.json({ attemptId, answers });
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("DRAFT_LOAD_ERROR", e);
    }
    return res.status(500).json({ error: e?.message || "DRAFT_LOAD_ERROR" });
  }
});

/**
 * PATCH /api/attempts/:id/lives
 * Body: { op: "increment" | "decrement", reason?: string }
 * - "increment": le devolvés 1 vida (baja livesUsed)
 * - "decrement": le quitás 1 vida (sube livesUsed)
 */
examsRouter.patch("/attempts/:id/lives", async (req, res) => {
  try {
    const { op, reason } = req.body ?? {};

    if (op !== "increment" && op !== "decrement") {
      return res.status(400).json({ error: "INVALID_OP" });
    }

    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });

    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });

    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const maxLives =
      (exam as any).lives != null ? Number((exam as any).lives) : 3;
    let used =
      (attempt as any).livesUsed != null
        ? Number((attempt as any).livesUsed)
        : 0;

    // increment => le SUMO una vida => uso menos
    if (op === "increment") {
      used = Math.max(0, used - 1);
    }

    // decrement => le RESTO una vida => uso más
    if (op === "decrement") {
      used = Math.min(maxLives, used + 1);
    }

    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: { livesUsed: used },
    });

    const remaining = Math.max(0, maxLives - used);

    // Opcional: loguear el evento en Event, si tenés tabla de eventos
    try {
      await prisma.event.create({
        data: {
          attemptId: attempt.id,
          type: "LIVES_PATCH",
          reason:
            reason ||
            (op === "increment"
              ? "MANUAL_LIFE_INCREMENT"
              : "MANUAL_LIFE_DECREMENT"),
        },
      });
    } catch (e) {
      console.error("EVENT_LIVES_PATCH_ERROR", e);
      // No rompemos la respuesta por esto
    }

    return res.json({
      remaining, // vidas restantes (lo más útil para el front)
      used, // cuántas usó
      maxLives, // tope del examen
      attemptId: updated.id,
    });
  } catch (e: any) {
    console.error("PATCH_LIVES_ERROR", e);
    return res.status(500).json({ error: e?.message || "PATCH_LIVES_ERROR" });
  }
});

/**
 * POST /api/attempts/:id/antifraud
 *
 * Lo usa el ALUMNO cuando se detecta una violación antifraude en el front.
 * - Registra un Event (para la columna "Antifraude" del tablero)
 * - Ajusta Attempt.livesUsed
 * - Calcula vidas restantes
 * - Si se queda sin vidas, cierra el intento
 *
 * Body: { type: string, meta?: any }
 */
examsRouter.post("/attempts/:id/antifraud", async (req, res) => {
  try {
    const attemptId = req.params.id;
    const { type, meta } = req.body ?? {};

    if (!type) {
      return res.status(400).json({ error: "MISSING_TYPE" });
    }

    let rawType = String(type || "")
      .trim()
      .toLowerCase();

    // 🔴 Normalizamos cualquier variante de "fullscreen exit"
    // ej: "fullscreen-exit", "FULLSCREEN_EXIT", "fullscreen exit"
    if (rawType.includes("fullscreen") && rawType.includes("exit")) {
      rawType = "fullscreen_exit";
    }

    const normalizedType = rawType
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();

    console.log(
      "[ANTIFRAUD]",
      attemptId,
      "type recibido:",
      type,
      "normalizado:",
      normalizedType
    );

    const attempt = await prisma.attempt.findUnique({
      where: { id: attemptId },
    });

    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });

    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    // Vida máxima definida en el examen (default 3 si está null)
    const maxLives =
      (exam as any).lives != null ? Number((exam as any).lives) : 3;

    // Vidas usadas hasta ahora
    let used =
      (attempt as any).livesUsed != null
        ? Number((attempt as any).livesUsed)
        : 0;

    // Tipos que realmente descuentan vida
    const PENALTY_TYPES = new Set<string>([
      "BLUR",
      "VISIBILITY_HIDDEN",
      "COPY",
      "CUT",
      "PASTE",
      "PRINT",
      "PRINTSCREEN",
      "FULLSCREEN_EXIT",
    ]);

    const penaliza = PENALTY_TYPES.has(normalizedType);
    console.log("[ANTIFRAUD] penaliza?", penaliza);

    if (penaliza) {
      // suma 1 vida usada, sin pasarse del máximo
      used = Math.min(maxLives, used + 1);
    }

    const remaining = Math.max(0, maxLives - used);

    let status = attempt.status ?? "in_progress";
    let endAt = attempt.endAt;

    // Si se quedó sin vidas, cerramos el intento
    if (remaining === 0 && status !== "finished") {
      status = "finished";
      endAt = new Date();
    }

    // Actualizamos Attempt
    const updated = await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        livesUsed: used,
        status,
        endAt,
      },
    });

    // Registramos SIEMPRE el evento para que el tablero vea la traza
    await prisma.event.create({
      data: {
        attemptId: attempt.id,
        type: "ANTIFRAUD",
        reason: normalizedType,
        meta: meta ?? Prisma.DbNull,
      },
    });

    return res.json({
      remaining,
      used,
      maxLives,
      status: updated.status,
    });
  } catch (e: any) {
    console.error("ANTIFRAUD_ERROR", e);
    return res.status(500).json({
      error: e?.message || "ANTIFRAUD_ERROR",
    });
  }
});

/**
 * GET /api/exams/:code/paper
 * Devuelve el "paper" del examen: título + lista de preguntas desde QuestionLite.
 */
examsRouter.get("/exams/:code/paper", async (req, res) => {
  let sql = "";
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    await ensureQuestionLite();

    sql = `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
    `;
    const list: any[] = await prisma.$queryRawUnsafe(
      sql,
      exam.id
    );

    const questions = (list || []).map((q) => {
      let choices: string[] | null = null;
      try {
        choices = q.choices ? JSON.parse(String(q.choices)) : null;
      } catch {
        choices = null;
      }

      // cuántos casilleros tiene (para FILL_IN)
      let blanksCount = 0;
      try {
        const ans = q.answer ? JSON.parse(String(q.answer)) : null;
        if (ans && Array.isArray(ans.answers)) {
          blanksCount = ans.answers.length;
        }
      } catch {
        blanksCount = 0;
      }

      let kind: string = String(q.kind || "").toUpperCase();
      if (kind === "TEXT") kind = "SHORT";
      if (kind === "FILL_IN") kind = "FIB";

      return {
        id: q.id,
        kind,
        stem: q.stem,
        choices,
        points: q.points ?? 1,
        // 👇 extra para el front (opcional)
        blanksCount,
      };
    });

    return res.json({
      exam: {
        title: exam.title,
        code: exam.publicCode ?? exam.id.slice(0, 6),
      },
      questions,
    });
  } catch (e: any) {
    logRawError("/api/exams/:code/paper", sql, e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Normaliza el tipo de pregunta para no depender de variantes
function normalizeQuestionKind(kind: any): string {
  const k = String(kind || "").toUpperCase();
  if (k === "FIB") return "FILL_IN";
  if (k === "TEXT") return "SHORT_TEXT";
  return k;
}

function splitFibParts(stem: string): { parts: string[]; blanks: number } {
  const parts: string[] = [];
  const re = /\[\[(.*?)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let blanks = 0;

  while ((match = re.exec(stem)) !== null) {
    parts.push(stem.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    blanks += 1;
  }
  parts.push(stem.slice(lastIndex));

  return { parts, blanks };
}

function extractFibAnswers(raw: any): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? ""));
  if (typeof raw === "string") return [raw];
  if (raw && typeof raw === "object") {
    if (Array.isArray((raw as any).answers)) {
      return (raw as any).answers.map((x: any) => String(x ?? ""));
    }
    if (Array.isArray((raw as any).values)) {
      return (raw as any).values.map((x: any) => String(x ?? ""));
    }
  }
  return [String(raw)];
}

// Serializa el valor de respuesta para guardarlo en Answer.content
function serializeAnswerContent(kind: any, value: any): string | null {
  const k = normalizeQuestionKind(kind);

  // FILL_IN / FIB → guardamos un JSON string de un array de strings
  if (k === "FILL_IN") {
    let arr: any[] = [];

    if (Array.isArray(value)) {
      arr = value;
    } else if (value && Array.isArray((value as any).answers)) {
      arr = (value as any).answers;
    } else if (typeof value === "string" || typeof value === "number") {
      // FIX: Si viene un valor simple, lo metemos en array
      arr = [value];
    }

    const normalized = arr.map((v) => String(v ?? "").trim());
    return JSON.stringify(normalized);
  }

  // MCQ → suele ser un índice numérico, lo guardamos como string
  if (k === "MCQ") {
    if (value === null || value === undefined || value === "") return null;
    return String(value);
  }

  // TRUE_FALSE / SHORT_TEXT / otros → string plano
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * POST /api/attempts/:id/submit
 * Corrige el intento (si gradingMode = auto) y guarda respuestas en Answer.
 * Body:
 * {
 *   answers: [{ questionId, value }]
 * }
 */
examsRouter.post("/attempts/:id/submit", async (req, res) => {
  let sql = "";
  try {
    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    // gradingMode ahora viene de Exam directamente
    let gradingMode: "auto" | "manual" = "auto";
    const gm = String(exam.gradingMode || "auto").toLowerCase();
    if (gm === "manual") gradingMode = "manual";

    const arr = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!arr.length) {
      return res.status(400).json({ error: "NO_ANSWERS" });
    }

    await ensureQuestionLite();

    sql = `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
    `;
    const qs: any[] = await prisma.$queryRawUnsafe(
      sql,
      exam.id
    );

    const byId = new Map<string, any>(qs.map((q) => [q.id, q]));
    let totalPoints = 0;
    let score = 0;

    for (const a of arr) {
      const rawQid = (a as any).questionId;
      const q = byId.get(String(rawQid));
      if (!q) continue;

      const pts = Number(q.points ?? 1) || 1;
      totalPoints += pts;

      let partial: number | null = null;

      // Normalizamos el tipo de pregunta
      const kind = normalizeQuestionKind(q.kind);

      if (gradingMode === "auto") {
        let correct: any = null;

        try {
          correct = q.answer ? JSON.parse(String(q.answer)) : null;
        } catch {
          correct = null;
        }

        if (kind === "TRUE_FALSE") {
          const given = String(a.value ?? "").toLowerCase();
          const corr = String(correct ?? "").toLowerCase();
          partial = given === corr ? pts : 0;
        } else if (kind === "MCQ") {
          const given = Number(a.value ?? -999);
          const corr = Number(correct ?? -888);
          partial = given === corr ? pts : 0;
        } else if (kind === "SHORT_TEXT") {
          const corr = String(correct ?? "")
            .trim()
            .toLowerCase();
          const given = String(a.value ?? "")
            .trim()
            .toLowerCase();
          partial = corr && given && corr === given ? pts : 0;
        } else if (kind === "FILL_IN") {
          // esperamos { answers: string[] } o un array
          let expected: string[] = [];
          try {
            if (Array.isArray((correct as any)?.answers)) {
              expected = (correct as any).answers.map((x: any) =>
                String(x ?? "")
              );
            }
          } catch {
            expected = [];
          }

          let givenArr: string[] = [];
          if (Array.isArray(a.value)) {
            givenArr = a.value.map((v: any) => String(v ?? ""));
          } else if (a.value && Array.isArray((a.value as any).answers)) {
            givenArr = (a.value as any).answers.map((v: any) =>
              String(v ?? "")
            );
          }

          let ok = 0;
          expected.forEach((exp, i) => {
            if (
              (givenArr[i] || "").toString().trim().toLowerCase() ===
              String(exp).trim().toLowerCase()
            ) {
              ok++;
            }
          });

          partial = expected.length ? (pts * ok) / expected.length : 0;
        } else {
          partial = 0;
        }
      }

      // Serializamos SIEMPRE lo que vamos a guardar en Answer.content
      const storedContent = serializeAnswerContent(q.kind, a.value);

      try {
        // FIX: Usar upsert manual (findFirst + update/create) para evitar errores de duplicados
        const existingAns = await prisma.answer.findFirst({
          where: { attemptId: attempt.id, questionId: q.id },
        });

        if (existingAns) {
          await prisma.answer.update({
            where: { id: existingAns.id },
            data: {
              content: storedContent as any, // Cast explícito para Prisma JSON
              score: partial,
            },
          });
          // console.log(`[SUBMIT] Updated ans Q:${q.id}`, storedContent);
        } else {
          await prisma.answer.create({
            data: {
              attemptId: attempt.id,
              questionId: q.id,
              content: storedContent as any, // Cast explícito para Prisma JSON
              score: partial,
            },
          });
          // console.log(`[SUBMIT] Created ans Q:${q.id}`, storedContent);
        }
      } catch (err) {
        console.error("ANSWER_CREATE_ERROR (no corta el submit):", {
          err,
          attemptId: attempt.id,
          questionId: q.id,
          kind,
          rawValue: a.value,
          storedContent,
        });
        // NO cortamos el flujo aunque falle una inserción
      }

      if (typeof partial === "number") {
        score += partial;
      }
    }

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        status: "submitted",
        endAt: new Date(),
        score: gradingMode === "auto" ? score : null,
      },
    });

    return res.json({
      ok: true,
      gradingMode,
      score: gradingMode === "auto" ? score : null,
      maxScore: gradingMode === "auto" ? totalPoints : exam.maxScore ?? null,
    });
  } catch (e: any) {
    logRawError("/api/attempts/:id/submit", sql, e);
    console.error("ATTEMPT_SUBMIT_ERROR", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/attempts/:id/review
 * (versión mínima: solo disponible si gradingMode = auto y el intento terminó)
 */
examsRouter.get("/attempts/:id/review", optionalAuthMiddleware, async (req, res) => {
  let sql = "";
  try {
    const at = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });
    if (!at) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

    const exam = await prisma.exam.findUnique({
      where: { id: at.examId },
    });
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    let gradingMode: "auto" | "manual" = "auto";
    const gm = String(exam.gradingMode || "auto").toLowerCase();
    if (gm === "manual") gradingMode = "manual";

    const now = new Date();
    const hasEnded = at.endAt != null;

    // ¿la revisión ya está habilitada por fecha/hora?
    let openAtOk = true;
    if (exam.openAt instanceof Date) {
      openAtOk = exam.openAt <= now;
    }

    let teacherOverride = false;
    if (req.user?.userId) {
      const allowed = await hasExamRole(exam, req.user.userId, [
        ExamRole.OWNER,
        ExamRole.GRADER,
        ExamRole.PROCTOR,
      ]);
      teacherOverride = allowed;
    }

    const canSee = teacherOverride || (gradingMode === "auto" && hasEnded && openAtOk);

    if (!canSee) {
      // caso especial: corrección auto + intento terminado + openAt en el futuro
      if (
        gradingMode === "auto" &&
        hasEnded &&
        exam.openAt instanceof Date &&
        exam.openAt > now
      ) {
        return res.status(403).json({
          error: "¡Revision no habilitada aun!",
          openAt: exam.openAt.toISOString(),
        });
      }

      return res.status(403).json({ error: "REVIEW_NOT_AVAILABLE" });
    }

    await ensureQuestionLite();

    sql = `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE "examId" = $1
      ORDER BY "createdAt" ASC
    `;
    const qs: any[] = await prisma.$queryRawUnsafe(
      sql,
      at.examId
    );

    const ans = await prisma.answer.findMany({
      where: { attemptId: at.id },
      select: { questionId: true, content: true, score: true },
    });

    const byQ = new Map(ans.map((a) => [a.questionId, a]));

    const questions = qs.map((q) => {
      let parsedChoices: any = null;
      try {
        parsedChoices = q.choices ? JSON.parse(String(q.choices)) : null;
      } catch {
        parsedChoices = null;
      }

      let correct: any = null;
      try {
        correct = q.answer ? JSON.parse(String(q.answer)) : null;
      } catch {
        correct = null;
      }

      const a = byQ.get(q.id);
      const given = unwrapAnswerContent(a?.content ?? null).value;

      return {
        id: q.id,
        kind: q.kind,
        stem: q.stem,
        choices: parsedChoices,
        points: q.points ?? 1,
        correct,
        given,
        score: a?.score ?? null,
      };
    });

    const sumPoints = questions.reduce((s, q) => s + Number(q.points ?? 1), 0);

    return res.json({
      exam: {
        title: exam.title,
        code: exam.publicCode ?? exam.id.slice(0, 6),
      },
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
    });
  } catch (e: any) {
    logRawError("/api/attempts/:id/review", sql, e);
    return respondSanitizedError(res, e, "REVIEW_ERROR");
  }
});

/**
 * GET /api/exams/:code/attempts/:attemptId/grading
 * Corrección manual: devuelve preguntas + respuestas + puntajes docentes.
 */
  examsRouter.get(
    "/exams/:code/attempts/:attemptId/grading",
    authMiddleware,
    async (req, res) => {
      let sql = "";
    try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

      const exam = await findExamByCode(req.params.code);
      if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

      const allowed = await hasExamRole(exam, userId, [
        ExamRole.OWNER,
        ExamRole.GRADER,
        ExamRole.PROCTOR,
      ]);
      if (!allowed) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }

      const attempt = await prisma.attempt.findFirst({
        where: { id: req.params.attemptId, examId: exam.id },
      });
      if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

      await ensureQuestionLite();

      sql = `
        SELECT id, kind, stem, choices, answer, points
        FROM "QuestionLite"
        WHERE "examId" = $1
        ORDER BY "createdAt" ASC
      `;
      const qs: any[] = await prisma.$queryRawUnsafe(sql, exam.id);

      const answers = await prisma.answer.findMany({
        where: { attemptId: attempt.id },
        select: { questionId: true, content: true, score: true },
      });
      const byQ = new Map(answers.map((a) => [a.questionId, a]));

      let maxPoints = 0;
      let currentScore = 0;

          const questions = qs.map((q) => {
            let options: any = null;
            try {
              options = q.choices ? JSON.parse(String(q.choices)) : null;
            } catch {
              options = null;
            }

        let correctAnswer: any = null;
        try {
          correctAnswer = q.answer ? JSON.parse(String(q.answer)) : null;
        } catch {
          correctAnswer = null;
        }

        const max = Number(q.points ?? 1) || 1;
        maxPoints += max;

            const a = byQ.get(q.id);
            const unwrapped = unwrapAnswerContent(a?.content ?? null);
            const score = typeof a?.score === "number" ? a.score : null;
            if (typeof score === "number") currentScore += score;

            const kind = normalizeQuestionKind(q.kind);
            const fib =
              kind === "FILL_IN"
                ? (() => {
                    const prompt = String(q.stem ?? "");
                    const { parts, blanks } = splitFibParts(prompt);
                    return {
                      parts,
                      blanks,
                      correctAnswers: extractFibAnswers(correctAnswer),
                      studentAnswers: extractFibAnswers(unwrapped.value),
                    };
                  })()
                : undefined;

          const item = {
            questionId: q.id,
            type: kind,
            prompt: q.stem,
            options,
            correctAnswer,
            maxPoints: max,
            maxScore: max,
            studentAnswer: unwrapped.value ?? null,
            teacherScore: score,
            teacherFeedback: unwrapped.teacherFeedback,
            ...(fib ? { fib } : {}),
          };
          if (fib) (item as any).fibNormalized = fib;
          return item;
        });

          return res.json({
            attempt: {
              id: attempt.id,
              studentName: attempt.studentName ?? null,
              status: attempt.status ?? null,
              startedAt: attempt.startAt ?? null,
              submittedAt: attempt.endAt ?? null,
              endAt: attempt.endAt ?? null,
              score: attempt.score ?? null,
            },
            questions,
            totals: {
              maxPoints,
              currentScore,
              maxScore: maxPoints,
              totalScore: currentScore,
            },
          });
      } catch (e: any) {
        logRawError("/api/exams/:code/attempts/:attemptId/grading", sql, e);
        return respondSanitizedError(res, e, "GRADING_GET_ERROR");
      }
    }
  );

/**
 * PATCH /api/exams/:code/attempts/:attemptId/grading
 * Body: { perQuestion: [{ questionId, score, feedback? }], finalize?: boolean }
 */
  examsRouter.patch(
    "/exams/:code/attempts/:attemptId/grading",
    authMiddleware,
    async (req, res) => {
      try {
      const userId = req.user?.userId;
      if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

      const exam = await findExamByCode(req.params.code);
      if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

      const allowed = await hasExamRole(exam, userId, [
        ExamRole.OWNER,
        ExamRole.GRADER,
        ExamRole.PROCTOR,
      ]);
      if (!allowed) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }

      const attempt = await prisma.attempt.findFirst({
        where: { id: req.params.attemptId, examId: exam.id },
      });
      if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

      const body = req.body ?? {};
      const perQuestion = Array.isArray(body.perQuestion)
        ? body.perQuestion
        : null;
      if (!perQuestion) {
        return res.status(400).json({ error: "PER_QUESTION_REQUIRED" });
      }

          for (const item of perQuestion) {
            const questionId = String(item?.questionId || "").trim();
            if (!questionId) continue;

        const scoreRaw = item?.score;
        const score =
          scoreRaw === null || scoreRaw === undefined
            ? null
            : Math.max(0, Number(scoreRaw));
        if (score !== null && Number.isNaN(score)) {
          return res.status(400).json({ error: "SCORE_INVALID" });
        }

        const feedback =
          item?.feedback !== undefined ? String(item.feedback) : undefined;

        const existing = await prisma.answer.findFirst({
          where: { attemptId: attempt.id, questionId },
        });

        if (existing) {
          const data: any = {};
          if (score !== null) data.score = score;
          if (feedback !== undefined) {
            data.content = wrapAnswerContent(existing.content, feedback);
          }
          if (Object.keys(data).length > 0) {
            await prisma.answer.update({
              where: { id: existing.id },
              data,
            });
          }
        } else {
          await prisma.answer.create({
            data: {
              attemptId: attempt.id,
              questionId,
              score: score ?? null,
              content:
                feedback !== undefined
                  ? wrapAnswerContent(null, feedback)
                  : Prisma.DbNull,
            },
          });
        }
      }

      const allAnswers = await prisma.answer.findMany({
        where: { attemptId: attempt.id },
        select: { score: true },
      });
      const totalScore = allAnswers.reduce((sum, a) => {
        return sum + (typeof a.score === "number" ? a.score : 0);
      }, 0);

      const finalize = body.finalize === true;
      const dataToUpdate: any = {
        score: totalScore,
      };
      if (finalize) dataToUpdate.status = "graded";

      const updatedAttempt = await prisma.attempt.update({
        where: { id: attempt.id },
        data: dataToUpdate,
        select: { id: true, status: true, score: true },
      });

        return res.json({
          ok: true,
          attemptId: updatedAttempt.id,
          status: updatedAttempt.status,
          totalScore: updatedAttempt.score ?? null,
        });
      } catch (e: any) {
        return respondSanitizedError(res, e, "GRADING_PATCH_ERROR");
      }
    }
  );

  /**
   * GET /api/teacher/grading/attempts/:attemptId
   * Corrección manual: detalle del intento sin necesidad de code.
   */
  examsRouter.get(
    "/teacher/grading/attempts/:attemptId",
    authMiddleware,
    async (req, res) => {
      let sql = "";
      try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const attempt = await prisma.attempt.findUnique({
          where: { id: req.params.attemptId },
          include: { exam: true },
        });
        if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
        const exam = attempt.exam;
        if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

        const allowed = await hasExamRole(exam, userId, [
          ExamRole.OWNER,
          ExamRole.GRADER,
          ExamRole.PROCTOR,
        ]);
        if (!allowed) {
          return res.status(403).json({ error: "FORBIDDEN" });
        }

        await ensureQuestionLite();

        sql = `
          SELECT id, kind, stem, choices, answer, points
          FROM "QuestionLite"
          WHERE "examId" = $1
          ORDER BY "createdAt" ASC
        `;
        const qs: any[] = await prisma.$queryRawUnsafe(sql, exam.id);

        const answers = await prisma.answer.findMany({
          where: { attemptId: attempt.id },
          select: { questionId: true, content: true, score: true },
        });
        const byQ = new Map(answers.map((a) => [a.questionId, a]));
        const overallFeedback =
          extractOverallFeedback(byQ.get(OVERALL_FEEDBACK_QID)?.content) ?? null;

        let maxPoints = 0;
        let currentScore = 0;

        const questions = qs.map((q) => {
          let options: any = null;
          try {
            options = q.choices ? JSON.parse(String(q.choices)) : null;
          } catch {
            options = null;
          }

          let correctAnswer: any = null;
          try {
            correctAnswer = q.answer ? JSON.parse(String(q.answer)) : null;
          } catch {
            correctAnswer = null;
          }

          const max = Number(q.points ?? 1) || 1;
          maxPoints += max;

          const a = byQ.get(q.id);
          const unwrapped = unwrapAnswerContent(a?.content ?? null);
          const score = typeof a?.score === "number" ? a.score : null;
          if (typeof score === "number") currentScore += score;

          const kind = normalizeQuestionKind(q.kind);
          const fib =
            kind === "FILL_IN"
              ? (() => {
                  const prompt = String(q.stem ?? "");
                  const { parts, blanks } = splitFibParts(prompt);
                  return {
                    parts,
                    blanks,
                    correctAnswers: extractFibAnswers(correctAnswer),
                    studentAnswers: extractFibAnswers(unwrapped.value),
                  };
                })()
              : undefined;

            const item = {
              questionId: q.id,
              type: kind,
              prompt: q.stem,
              options,
              correctAnswer,
              maxPoints: max,
              maxScore: max,
              studentAnswer: unwrapped.value ?? null,
              teacherScore: score,
              teacherFeedback: unwrapped.teacherFeedback,
              ...(fib ? { fib } : {}),
            };
            if (fib) (item as any).fibNormalized = fib;
            return item;
          });

          return res.json({
            attempt: {
              id: attempt.id,
              studentName: attempt.studentName ?? null,
              status: attempt.status ?? null,
              startedAt: attempt.startAt ?? null,
              submittedAt: attempt.endAt ?? null,
              endAt: attempt.endAt ?? null,
              score: attempt.score ?? null,
            },
            overallFeedback,
            questions,
            totals: {
              maxPoints,
              currentScore,
              maxScore: maxPoints,
              totalScore: currentScore,
            },
          });
      } catch (e: any) {
        logRawError("/api/teacher/grading/attempts/:attemptId", sql, e);
        return respondSanitizedError(res, e, "GRADING_GET_ERROR");
      }
    }
  );

  /**
   * PATCH /api/teacher/grading/attempts/:attemptId/draft
   * Body: { perQuestion: [{ questionId, score, feedback? }], totalScore? }
   */
  examsRouter.patch(
    "/teacher/grading/attempts/:attemptId/draft",
    authMiddleware,
    async (req, res) => {
      try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const attempt = await prisma.attempt.findUnique({
          where: { id: req.params.attemptId },
          include: { exam: true },
        });
        if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
        const exam = attempt.exam;
        if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

        const allowed = await hasExamRole(exam, userId, [
          ExamRole.OWNER,
          ExamRole.GRADER,
          ExamRole.PROCTOR,
        ]);
        if (!allowed) {
          return res.status(403).json({ error: "FORBIDDEN" });
        }

        const body = req.body ?? {};
        const perQuestion = Array.isArray(body.perQuestion)
          ? body.perQuestion
          : null;
        if (!perQuestion) {
          return res.status(400).json({ error: "PER_QUESTION_REQUIRED" });
        }

        for (const item of perQuestion) {
          const questionId = String(item?.questionId || "").trim();
          if (!questionId) continue;

          const scoreRaw = item?.score;
          const score =
            scoreRaw === null || scoreRaw === undefined
              ? null
              : Math.max(0, Number(scoreRaw));
          if (score !== null && Number.isNaN(score)) {
            return res.status(400).json({ error: "SCORE_INVALID" });
          }

          const feedback =
            item?.feedback !== undefined ? String(item.feedback) : undefined;

          const existing = await prisma.answer.findFirst({
            where: { attemptId: attempt.id, questionId },
          });

          if (existing) {
            const data: any = {};
            if (score !== null) data.score = score;
            if (feedback !== undefined) {
              data.content = wrapAnswerContent(existing.content, feedback);
            }
            if (Object.keys(data).length > 0) {
              await prisma.answer.update({
                where: { id: existing.id },
                data,
              });
            }
          } else {
            await prisma.answer.create({
              data: {
                attemptId: attempt.id,
                questionId,
                score: score ?? null,
                content:
                  feedback !== undefined
                    ? wrapAnswerContent(null, feedback)
                    : Prisma.DbNull,
              },
            });
          }
        }

        if (Object.prototype.hasOwnProperty.call(body, "overallFeedback")) {
          const overallFeedbackRaw = normalizeOverallFeedback(
            body.overallFeedback
          );
          const overallFeedback = overallFeedbackRaw ?? "";
          if (overallFeedback.length > 2000) {
            return res.status(400).json({ error: "OVERALL_FEEDBACK_TOO_LARGE" });
          }

          const existingOverall = await prisma.answer.findFirst({
            where: { attemptId: attempt.id, questionId: OVERALL_FEEDBACK_QID },
          });
          if (existingOverall) {
            await prisma.answer.update({
              where: { id: existingOverall.id },
              data: {
                content: wrapAnswerContent(
                  existingOverall.content,
                  overallFeedback
                ),
                score: null,
              },
            });
          } else {
            await prisma.answer.create({
              data: {
                attemptId: attempt.id,
                questionId: OVERALL_FEEDBACK_QID,
                score: null,
                content: wrapAnswerContent(null, overallFeedback),
              },
            });
          }
        }

        const allAnswers = await prisma.answer.findMany({
          where: { attemptId: attempt.id },
          select: { score: true },
        });
        const totalScore = allAnswers.reduce((sum, a) => {
          return sum + (typeof a.score === "number" ? a.score : 0);
        }, 0);

        const updatedAttempt = await prisma.attempt.update({
          where: { id: attempt.id },
          data: { score: totalScore },
          select: { id: true, status: true, score: true },
        });

        return res.json({
          ok: true,
          attemptId: updatedAttempt.id,
          status: updatedAttempt.status,
          totalScore: updatedAttempt.score ?? null,
        });
      } catch (e: any) {
        return respondSanitizedError(res, e, "GRADING_PATCH_ERROR");
      }
    }
  );

  /**
   * POST /api/teacher/grading/attempts/:attemptId/finalize
   * Body: { perQuestion: [{ questionId, score, feedback? }] }
   */
  examsRouter.post(
    "/teacher/grading/attempts/:attemptId/finalize",
    authMiddleware,
    async (req, res) => {
      try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const attempt = await prisma.attempt.findUnique({
          where: { id: req.params.attemptId },
          include: { exam: true },
        });
        if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
        const exam = attempt.exam;
        if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

        const allowed = await hasExamRole(exam, userId, [
          ExamRole.OWNER,
          ExamRole.GRADER,
          ExamRole.PROCTOR,
        ]);
        if (!allowed) {
          return res.status(403).json({ error: "FORBIDDEN" });
        }

        const body = req.body ?? {};
        const perQuestion = Array.isArray(body.perQuestion)
          ? body.perQuestion
          : null;
        if (!perQuestion) {
          return res.status(400).json({ error: "PER_QUESTION_REQUIRED" });
        }

        for (const item of perQuestion) {
          const questionId = String(item?.questionId || "").trim();
          if (!questionId) continue;

          const scoreRaw = item?.score;
          const score =
            scoreRaw === null || scoreRaw === undefined
              ? null
              : Math.max(0, Number(scoreRaw));
          if (score !== null && Number.isNaN(score)) {
            return res.status(400).json({ error: "SCORE_INVALID" });
          }

          const feedback =
            item?.feedback !== undefined ? String(item.feedback) : undefined;

          const existing = await prisma.answer.findFirst({
            where: { attemptId: attempt.id, questionId },
          });

          if (existing) {
            const data: any = {};
            if (score !== null) data.score = score;
            if (feedback !== undefined) {
              data.content = wrapAnswerContent(existing.content, feedback);
            }
            if (Object.keys(data).length > 0) {
              await prisma.answer.update({
                where: { id: existing.id },
                data,
              });
            }
          } else {
            await prisma.answer.create({
              data: {
                attemptId: attempt.id,
                questionId,
                score: score ?? null,
                content:
                  feedback !== undefined
                    ? wrapAnswerContent(null, feedback)
                    : Prisma.DbNull,
              },
            });
            }
          }

          const hasOverallFeedback = Object.prototype.hasOwnProperty.call(
            body,
            "overallFeedback"
          );
          if (hasOverallFeedback) {
            const overallFeedbackRaw = normalizeOverallFeedback(
              body.overallFeedback
            );
            const overallFeedback = overallFeedbackRaw ?? "";
            if (overallFeedback.length > 2000) {
              return res.status(400).json({ error: "OVERALL_FEEDBACK_TOO_LARGE" });
            }

            const existingOverall = await prisma.answer.findFirst({
              where: { attemptId: attempt.id, questionId: OVERALL_FEEDBACK_QID },
            });
            if (existingOverall) {
              await prisma.answer.update({
                where: { id: existingOverall.id },
                data: {
                  content: wrapAnswerContent(
                    existingOverall.content,
                    overallFeedback
                  ),
                  score: null,
                },
              });
            } else {
              await prisma.answer.create({
                data: {
                  attemptId: attempt.id,
                  questionId: OVERALL_FEEDBACK_QID,
                  score: null,
                  content: wrapAnswerContent(null, overallFeedback),
                },
              });
            }
          }

          const allAnswers = await prisma.answer.findMany({
            where: { attemptId: attempt.id },
            select: { score: true },
          });
          const totalScore = allAnswers.reduce((sum, a) => {
            return sum + (typeof a.score === "number" ? a.score : 0);
          }, 0);

          await ensureQuestionLite();
          const maxScoreRow = await prisma.$queryRawUnsafe<{ total: number }[]>(
            `SELECT COALESCE(SUM(points),0) as total FROM "QuestionLite" WHERE "examId" = $1`,
            exam.id
          );
          const maxScore =
            Array.isArray(maxScoreRow) && maxScoreRow[0]
              ? Number(maxScoreRow[0].total ?? 0)
              : 0;

          const updatedAttempt = await prisma.attempt.update({
            where: { id: attempt.id },
            data: { score: totalScore, status: "graded" },
            select: { id: true, status: true, score: true },
          });

          return res.json({
            ok: true,
            attemptId: updatedAttempt.id,
            status: updatedAttempt.status,
            totalScore: updatedAttempt.score ?? null,
            maxScore,
          });
      } catch (e: any) {
        return respondSanitizedError(res, e, "GRADING_PATCH_ERROR");
      }
    }
  );
// DELETE /api/exams/:id
// Elimina un examen y todas sus dependencias (attempts, answers, events, messages, questions)
examsRouter.delete("/exams/:id", authMiddleware, async (req, res) => {
  const rawId = req.params.id;

  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    let exam = await prisma.exam.findUnique({
      where: { id: rawId },
    });
    if (!exam) {
      exam = await prisma.exam.findFirst({
        where: { publicCode: rawId },
      });
    }

    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const examId = exam.id;

    const ownerMember = await prisma.examMember.findFirst({
      where: { examId, userId, role: ExamRole.OWNER },
      select: { id: true },
    });

    if (exam.ownerId !== userId && !ownerMember) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    await prisma.$transaction(async (tx) => {
      // 1) Borrar invitaciones y membresías (FK RESTRICT)
      await tx.examInvite.deleteMany({ where: { examId } });
      await tx.examMember.deleteMany({ where: { examId } });

      // 2) Traer IDs de intentos de ese examen
      const attempts = await tx.attempt.findMany({
        where: { examId },
        select: { id: true },
      });
      const attemptIds = attempts.map((a) => a.id);

      // 3) Borrar dependencias de los intentos (answers, events, messages)
      if (attemptIds.length > 0) {
        await tx.answer.deleteMany({
          where: { attemptId: { in: attemptIds } },
        });

        await tx.event.deleteMany({
          where: { attemptId: { in: attemptIds } },
        });

        await tx.message.deleteMany({
          where: { attemptId: { in: attemptIds } },
        });

        await tx.attempt.deleteMany({
          where: { id: { in: attemptIds } },
        });
      }

      // 4) Borrar preguntas del examen
      await tx.question.deleteMany({
        where: { examId },
      });

      // 5) Finalmente borrar el examen
      await tx.exam.delete({
        where: { id: examId },
      });
    });

    return res.status(204).send();
  } catch (e: any) {
    console.error("DELETE_EXAM_ERROR", e);
    if (e?.code === "P2003") {
      return res.status(409).json({ error: "FK_CONSTRAINT" });
    }
    return res.status(500).json({ error: e?.message || "DELETE_EXAM_ERROR" });
  }
});

/**
 * POST /api/s/attempt/:id/event
 * Body: { type, meta? }
 * Registra una violación antifraude:
 *  - incrementa livesUsed en Attempt
 *  - calcula vidas restantes
 *  - cierra el intento si se queda sin vidas
 *  - crea un Event para que el tablero lo vea en "Antifraude"
 */
examsRouter.post("/s/attempt/:id/event", async (req, res) => {
  try {
    const { type, meta } = req.body ?? {};
    if (!type) {
      return res.status(400).json({ error: "MISSING_TYPE" });
    }

    const rawType = String(type || "").trim();
    const normalizedType = rawType
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .toUpperCase();

    const attempt = await prisma.attempt.findUnique({
      where: { id: req.params.id },
    });

    if (!attempt) {
      return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    }

    const exam = await prisma.exam.findUnique({
      where: { id: attempt.examId },
    });

    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const maxLives =
      (exam as any).lives != null ? Number((exam as any).lives) : 3;

    const prevUsed =
      (attempt as any).livesUsed != null
        ? Number((attempt as any).livesUsed)
        : 0;

    const newLivesUsed = Math.min(prevUsed + 1, maxLives);
    const remaining = Math.max(0, maxLives - newLivesUsed);

    let status = attempt.status;
    let endAt = attempt.endAt;

    if (remaining <= 0 && status !== "finished") {
      status = "finished";
      endAt = new Date();
    }

    await prisma.attempt.update({
      where: { id: attempt.id },
      data: {
        livesUsed: newLivesUsed,
        status,
        endAt,
      },
    });

    // 👇 AQUÍ ES LA CLAVE: registramos el evento para el tablero
    try {
      await prisma.event.create({
        data: {
          attemptId: attempt.id,
          type: "ANTIFRAUD",
          reason: normalizedType, // ej: BLUR, COPY, FULLSCREEN_EXIT
          meta: meta ?? Prisma.DbNull,
        },
      });
    } catch (err) {
      console.error("EVENT_ANTIFRAUD_S_ROUTE_ERROR", err);
      // no rompemos la respuesta al alumno
    }

    return res.json({
      ok: true,
      livesRemaining: remaining,
    });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "ANTIFRAUD_ERROR" });
  }
});

// GET /api/attempts/:id/review.print
// Versión HTML estilizada para imprimir/guardar como PDF.
examsRouter.get("/attempts/:id/review.print", async (req, res) => {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 3001}`;
    const id = req.params.id;

    const r = await fetch(`${baseUrl}/api/attempts/${id}/review`);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).send(text);
    }

    const review = await r.json();

    // --- DEBUG TEMPORAL (Solicitado) ---
    console.log("REVIEW JSON:", JSON.stringify(review, null, 2));
    // -----------------------------------

    const exam = review.exam || {};
    const attempt = review.attempt || {};
    const questions: any[] = Array.isArray(review.questions)
      ? review.questions
      : [];

    // ---------- HELPERS BÁSICOS ----------

    const escapeHtml = (str: any) =>
      String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    function formatDateTime(value: any) {
      if (!value) return "-";
      const d = new Date(value);
      if (isNaN(d.getTime())) return "-";
      return d.toLocaleString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }

    function formatDuration(secondsRaw: any) {
      const total = Number(secondsRaw);
      if (!isFinite(total) || total <= 0) return "-";

      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = Math.floor(total % 60);

      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
      if (minutes > 0) {
        parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
      }
      if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds} ${seconds === 1 ? "segundo" : "segundos"}`);
      }
      return parts.join(" ");
    }

    // Lógica de redondeo solicitada:
    // < 0.5 -> baja al entero
    // = 0.5 -> queda en .5
    // > 0.5 -> sube al entero
    function formatSmartScore(score: number): string {
      const integer = Math.floor(score);
      const decimal = score - integer;

      let final = integer;
      // Usamos un pequeño margen para float precision (opsional)
      if (decimal > 0.50001) {
        final += 1;
      } else if (Math.abs(decimal - 0.5) < 0.00001) {
        final += 0.5;
      }
      // si decimal < 0.5 queda en entero

      return final.toString().replace(".", ",");
    }

    // ---------- HELPERS DE EXTRACCIÓN (ROBUSTOS) ----------

    function safeJsonParse(val: any): any {
      if (typeof val !== "string") return val;
      const trimmed = val.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }

    function extractAnswersArray(raw: any): string[] {
      if (raw == null) return [];

      let v = raw;

      if (typeof v === "string") {
        const parsed = safeJsonParse(v);
        if (parsed !== v) {
          v = parsed;
        } else {
          return [v.trim()];
        }
      }

      if (Array.isArray(v)) {
        return v.map((x) => String(x ?? "").trim());
      }

      if (v && typeof v === "object") {
        if (Array.isArray((v as any).answers)) {
          return (v as any).answers.map((x: any) => String(x ?? "").trim());
        }
        if (Array.isArray((v as any).values)) {
          return (v as any).values.map((x: any) => String(x ?? "").trim());
        }
        // Fallback: tratar como mapa de valores (ej { "0": "val" })
        return Object.values(v).map((x) => String(x ?? "").trim());
      }

      return [String(v ?? "").trim()];
    }

    // ---------- RENDER FIB CON CHIPS ----------

    function renderFibStem(
      stem: string,
      student: string[],
      correct: string[]
    ): string {
      const parts: string[] = [];
      const re = /\[\[(.*?)\]\]/g;

      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let boxIndex = 0;

      const normStudent = student.map((s) => (s ?? "").toString());
      const normCorrect = correct.map((c) => (c ?? "").toString());

      while ((match = re.exec(stem)) !== null) {
        if (match.index > lastIndex) {
          parts.push(
            `<span>${escapeHtml(stem.slice(lastIndex, match.index))}</span>`
          );
        }

        const sVal = normStudent[boxIndex] ?? "";
        const cVal = normCorrect[boxIndex] ?? "";
        const sTrim = sVal.trim().toLowerCase();
        const cTrim = cVal.trim().toLowerCase();
        const isEmpty = sTrim.length === 0;
        const isCorrect = !isEmpty && cTrim.length > 0 && sTrim === cTrim;
        const cls = isEmpty
          ? "fib-input fib-empty"
          : isCorrect
          ? "fib-input fib-correct"
          : "fib-input fib-wrong";

        // Moodle style input look + estado por acierto
        parts.push(`<span class="${cls}">${escapeHtml(sVal || "")}</span>`);

        boxIndex++;
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < stem.length) {
        parts.push(`<span>${escapeHtml(stem.slice(lastIndex))}</span>`);
      }

      if (parts.length === 0) return `<span>${escapeHtml(stem)}</span>`;

      return parts.join("");
    }

    // ---------- Render por pregunta ----------

    function renderQuestionCard(q: any, idx: number): string {
      const kind = String(q.kind || "").toUpperCase();
      const stemString = q.stem ?? q.text ?? "";
      const points = Number(q.points ?? q.maxScore ?? 0) || 0;
      const scoreObtained = q.score !== null && q.score !== undefined ? Number(q.score) : 0;

      const studentArr = extractAnswersArray(q.given);
      const correctArr = extractAnswersArray(q.correct);

      // --- DEBUG GRANULAR SOLICITADO ---
      if (studentArr.length === 0 && q.given) {
        console.log(`[DEBUG] Question ${idx + 1} empty extraction. q.given:`, JSON.stringify(q.given));
      }
      // ---------------------------------

      let statusText = "Sin responder";
      let statusClass = "unanswered";

      // Determinar estado basado en puntaje
      if (studentArr.length > 0 && studentArr.some(s => s)) {
        if (scoreObtained >= points) {
          statusText = "Correcta";
          statusClass = "correct";
        } else if (scoreObtained > 0) {
          statusText = "Parcialmente correcta";
          statusClass = "incorrect"; // Usamos rojo para no complicar, o Moodle usa 'partially correct' (naranja)
        } else {
          statusText = "Incorrecta";
          statusClass = "incorrect";
        }
      } else {
        statusText = "Sin responder";
        statusClass = "unanswered";
      }

      // ------------ RENDER CONTENIDO (MCQ con opciones) ------------
      let contentHtml = "";
      let niceCorrectText = "";

      if (kind === "MCQ" || kind === "TRUE_FALSE") {
        const choices = q.choices && Array.isArray(q.choices) ? q.choices : [];

        // Preparamos texto de respuesta correcta
        const niceCorrectArr = correctArr.map(cVal => {
          // Si es un índice
          if (!isNaN(Number(cVal)) && choices[Number(cVal)]) return choices[Number(cVal)];
          // Si es "true"/"false" y no hay choices (TRUE_FALSE sin choices explícitos)
          if (kind === "TRUE_FALSE" && choices.length === 0) {
            return cVal === "true" ? "Verdadero" : "Falso";
          }
          return cVal;
        });
        niceCorrectText = niceCorrectArr.join(", ");

        const listHtml = choices.map((choiceLabel: string, i: number) => {
          const strIndex = String(i);
          const isSelected = studentArr.includes(strIndex) || studentArr.includes(choiceLabel) || studentArr.some(s => s.toLowerCase() === choiceLabel.toLowerCase());
          const isCorrectOption = correctArr.includes(strIndex) || correctArr.includes(choiceLabel) || correctArr.some(c => c.toLowerCase() === choiceLabel.toLowerCase());
          const isWrongSelected = isSelected && !isCorrectOption;

          let iconHtml = "";
          if (isSelected) {
            if (isCorrectOption) iconHtml = `<span class="feedback-icon icon-check">✔️</span>`;
            else iconHtml = `<span class="feedback-icon icon-cross">❌</span>`;
          } else if (isCorrectOption) {
            // Opción correcta NO seleccionada (Moodle a veces marca check aquí también, o solo abajo)
            // Dejamos vacío y usamos el feedback box abajo.
          }

          // Letras a, b, c...
          const letter = String.fromCharCode(97 + i); // 97 = 'a'

          const itemClass = `choice-item${isCorrectOption ? ' choice-correct' : ''}${isWrongSelected ? ' choice-wrong' : ''}`;

          return `
               <div class="${itemClass}">
                 <div class="radio-sim ${isSelected ? 'selected' : ''}"></div>
                 <div class="choice-text">
                   <strong style="margin-right:4px;">${letter}.</strong> ${escapeHtml(choiceLabel)}
                   ${iconHtml}
                 </div>
               </div>
             `;
        }).join("");

        contentHtml = `<div class="choice-list">${listHtml}</div>`;

      } else if (kind === "FIB" || kind === "FILL_IN") {
        contentHtml = `<div style="margin-bottom:16px;">${renderFibStem(stemString, studentArr, correctArr)}</div>`;
        niceCorrectText = correctArr.join(", ");
      } else {
        // SHORT TEXT u otros
        contentHtml = `<div style="padding: 10px; background:#f8f9fa; border:1px solid #dee2e6;">${escapeHtml(studentArr.join(" / ") || "")}</div>`;
        niceCorrectText = correctArr.join(", ");
      }

      return `
      <article class="moodle-card">
        <div class="info-col">
          <div class="q-no">Pregunta ${idx + 1}</div>
          <div class="q-status ${statusClass}">${escapeHtml(statusText)}</div>
          <div class="q-grade">Se puntúa ${formatSmartScore(scoreObtained)} sobre ${points}</div>
        </div>

        <div class="content-col">
          <div class="q-stem">${escapeHtml(stemString)}</div>
          ${contentHtml}
          
          <div class="feedback-box">
             La respuesta correcta es: ${escapeHtml(niceCorrectText)}
          </div>
        </div>
      </article>
      `;
    }

    const questionsHtml = questions
      .map((q, idx) => renderQuestionCard(q, idx))
      .join("\n");

    // ---------- Datos encabezado ----------

    const title = exam.title || "Examen";
    const studentName = attempt.studentName || attempt.student || "Alumno";

    const startedAt = attempt.startedAt || attempt.started_at;
    const finishedAt = attempt.finishedAt || attempt.finished_at;

    let durationSeconds = attempt.durationSeconds;
    if (
      (durationSeconds == null || !isFinite(Number(durationSeconds))) &&
      startedAt &&
      finishedAt
    ) {
      const t1 = new Date(startedAt).getTime();
      const t2 = new Date(finishedAt).getTime();
      if (isFinite(t1) && isFinite(t2) && t2 > t1) {
        durationSeconds = Math.round((t2 - t1) / 1000);
      }
    }

    const score = attempt.score ?? review.totalScore ?? 0;
    const maxScore = attempt.maxScore ?? review.maxScore ?? 0;

    const status =
      finishedAt || attempt.completedAt || attempt.completed_at
        ? "Finalizado"
        : "En curso";

    // Calcular porcentaje
    let percentage = "0";
    if (maxScore > 0) {
      percentage = ((score / maxScore) * 100).toFixed(0); // Sin decimales o 1 decimal
    }

    const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Revisión — ${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    body { background: #fff; color: #333; padding: 20px; font-size: 14px; }
    .page { max-width: 900px; margin: 0 auto; }
    
    .main-title { font-size: 24px; font-weight: normal; margin-bottom: 5px; color: #333; }
    .sub-title { font-size: 18px; font-weight: normal; margin-bottom: 20px; color: #555; }

    .generaltable {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .generaltable th, .generaltable td {
      padding: 8px 12px;
      border-top: 1px solid #dee2e6;
      text-align: left;
      vertical-align: top;
    }
    .generaltable th {
      background-color: #f8f9fa;
      width: 160px;
      font-weight: bold;
      text-align: right;
      color: #333;
    }
    .generaltable tr:last-child {
      border-bottom: 1px solid #dee2e6;
    }
    .actions-row { margin-bottom: 30px; }
    
    .print-button {
      background-color: #0f6cbf;
      color: white;
      text-decoration: none;
      padding: 8px 14px;
      border-radius: 4px;
      border: none;
      font-size: 14px;
      cursor: pointer;
    }
    .print-button:hover { background-color: #0d5ca0; }

    .section-title { font-size: 18px; color: #C02424; margin-bottom: 15px; font-weight: normal; border-bottom: 1px solid #dee2e6; padding-bottom: 5px; }
    
    .questions-list { display: flex; flex-direction: column; gap: 15px; }
    
    /* Existing styles that were kept or modified */
    .moodle-card {
      display: flex;
      flex-direction: row;
      background: #fff;
      border: 1px solid #ced4da;
      margin-bottom: 24px;
      padding: 0;
    }
    .info-col {
      width: 140px;
      min-width: 140px;
      background: #f8f9fa;
      border-right: 1px solid #ced4da;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .q-no { font-size: 16px; font-weight: bold; color: #DC3545; margin-bottom: 4px; }
    .q-status { font-size: 13px; font-weight: bold; margin-bottom: 4px; display: block; }
    .q-status.correct { color: #0f5132; }
    .q-status.incorrect { color: #842029; }
    .q-status.unanswered { color: #842029; }
    
    .q-grade { font-size: 11px; color: #495057; line-height: 1.3; margin-top: 8px; border-top: 1px solid #dee2e6; padding-top: 4px; }

    .content-col {
      flex: 1;
      padding: 24px 32px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .q-stem { font-size: 15px; margin-bottom: 20px; color: #212529; font-weight: 500; }
    
    .choice-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
    .choice-item { display: flex; align-items: flex-start; gap: 12px; font-size: 14px; position: relative; }
    .radio-sim {
      width: 16px; height: 16px; border: 1px solid #adb5bd; border-radius: 50%;
      flex-shrink: 0; margin-top: 2px; display: flex; align-items: center; justify-content: center;
    }
    .radio-sim.selected::after {
      content: ''; width: 8px; height: 8px; background: #212529; border-radius: 50%;
    }
    .choice-text { line-height: 1.4; color: #212529; display: flex; align-items: center; gap: 8px;}
    .feedback-icon { font-size: 16px; line-height: 1; }
    .icon-check { color: #198754; font-weight: bold; }
    .icon-cross { color: #dc3545; font-weight: bold; }

    .feedback-box {
      margin-top: 20px;
      background: #fdfdfe; /* light background */
      border: 1px solid #e9ecef;
      color: #72500d; /* yellowish/brown text */
      background-color: #fff3cd; /* Moodle yellow */
      border-color: #ffecb5;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 13px;
    }
    .fib-input {
      display: inline-block; padding: 4px 8px; border: 1px solid #ced4da;
      background: #fff; min-width: 80px; text-align: center; border-radius: 2px;
      font-weight: 500; margin: 0 4px; color: #212529;
    }
    .fib-correct { border-color: #198754; background: #e9f7ef; color: #0f5132; }
    .fib-wrong { border-color: #dc3545; background: #fce8ea; color: #842029; }
    .fib-empty { border-color: #ced4da; background: #f8f9fa; color: #6c757d; }
    .choice-correct .choice-text { color: #198754; }
    .choice-correct .radio-sim { border-color: #198754; }
    .choice-wrong .choice-text { color: #dc3545; }
    @media print {
      body { background: #fff; padding: 0; }
      .page { box-shadow: none; border: none; padding: 0; max-width: none; }
      .print-button { display: none; }
      .moodle-card { break-inside: avoid; border: 1px solid #000; }
      .info-col { background: #f8f9fa !important; -webkit-print-color-adjust: exact; }
      .feedback-box { background: #fff3cd !important; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="page">
    <h2 class="main-title">Revisión — ${escapeHtml(title)}</h2>
    <h3 class="sub-title">Alumno: ${escapeHtml(studentName)}</h3>

    <table class="generaltable">
      <tbody>
        <tr>
          <th scope="row">Comenzado el</th>
          <td>${escapeHtml(formatDateTime(startedAt))}</td>
        </tr>
        <tr>
          <th scope="row">Estado</th>
          <td>${escapeHtml(status)}</td>
        </tr>
        <tr>
          <th scope="row">Finalizado en</th>
          <td>${escapeHtml(formatDateTime(finishedAt))}</td>
        </tr>
        <tr>
          <th scope="row">Tiempo empleado</th>
          <td>${escapeHtml(formatDuration(durationSeconds))}</td>
        </tr>
        <tr>
          <th scope="row">Calificación</th>
          <td><b>${formatSmartScore(score)}</b> de ${maxScore} (${percentage}%)</td>
        </tr>
      </tbody>
    </table>

    <div class="actions-row">
      <button class="print-button" onclick="window.print()">
        DESCARGAR PDF
      </button>
    </div>

    <h2 class="section-title">Detalle por pregunta</h2>
    <section class="questions-list">
      ${questionsHtml}
    </section>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err: any) {
    console.error("REVIEW_PRINT_ERROR", err);
    return res.status(500).send("Error generando la revisión para impresión.");
  }
});
