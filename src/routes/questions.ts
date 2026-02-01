import { Router } from "express";
import { prisma } from "../prisma";
import crypto from "crypto";

export const questionsRouter = Router();

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

/** Asegura que exista la tabla QuestionLite (sin Prisma) */
async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "QuestionLite" (
      id TEXT PRIMARY KEY,
      "examId" TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 'MCQ' | 'TRUE_FALSE' | 'SHORT_TEXT' | 'FILL_IN'
      stem TEXT NOT NULL,            -- enunciado
      choices TEXT,                  -- JSON string (solo MCQ / TRUE_FALSE)
      answer TEXT,                   -- JSON string (respuesta correcta o forma de corregir)
      points INTEGER NOT NULL DEFAULT 1,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- índices útiles
      FOREIGN KEY("examId") REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);

  await repairQuestionLiteSchema();
  await logLiteSchemaOnce();
}

/** Resuelve un examen por publicCode / id / prefijo / título */
async function resolveExamId(codeRaw: string): Promise<{ id: string } | null> {
  const code = String(codeRaw || "").trim();
  if (!code) return null;

  // por publicCode exacto
  let rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE "publicCode" = $1 LIMIT 1`,
    code
  );
  if (rows?.[0]) return rows[0];

  // por id exacto
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE id = $1 LIMIT 1`,
    code
  );
  if (rows?.[0]) return rows[0];

  // por prefijo de id
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE id LIKE $1 LIMIT 1`,
    `${code}%`
  );
  if (rows?.[0]) return rows[0];

  // por título exacto (case-insensitive)
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE LOWER(title) = LOWER($1) LIMIT 1`,
    code
  );
  if (rows?.[0]) return rows[0];

  return null;
}

/** Listar preguntas de un examen */
questionsRouter.get("/exams/:code/questions", async (req, res) => {
  try {
    await ensureTable();
    const exam = await resolveExamId(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const list = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, "examId", kind, stem, choices, answer, points, "createdAt"
       FROM "QuestionLite"
       WHERE "examId" = $1
       ORDER BY "createdAt" ASC`,
      exam.id
    );

    // Parseo JSON de convenience
    const data = (list || []).map((q) => ({
      ...q,
      choices: q.choices ? JSON.parse(q.choices) : null,
      answer: q.answer ? JSON.parse(q.answer) : null,
    }));

    res.json({ items: data });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Crear pregunta (MCQ, TRUE_FALSE, etc.) */
questionsRouter.post("/exams/:code/questions", async (req, res) => {
  try {
    await ensureTable();
    const exam = await resolveExamId(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const { kind, stem, choices, answer, points = 1 } = req.body ?? {};
    if (!kind || !stem?.trim())
      return res.status(400).json({ error: "FALTAN_CAMPOS" });

    // Validaciones picantes pero simples
    let choicesStr: string | null = null;
    let answerStr: string | null = null;

    if (kind === "MCQ") {
      if (!Array.isArray(choices) || choices.length < 2)
        return res.status(400).json({ error: "MCQ_REQUIERE_CHOICES" });
      // answer puede ser índice o array de índices (soporta multiple correctas)
      if (answer === undefined || answer === null)
        return res.status(400).json({ error: "MCQ_REQUIERE_ANSWER" });

      choicesStr = JSON.stringify(choices);
      answerStr = JSON.stringify(answer);
    } else if (kind === "TRUE_FALSE") {
      // choices fijo
      choicesStr = JSON.stringify(["Verdadero", "Falso"]);
      if (typeof answer !== "boolean")
        return res.status(400).json({ error: "TRUE_FALSE_REQUIERE_BOOLEAN" });
      answerStr = JSON.stringify(answer);
    } else if (kind === "SHORT_TEXT") {
      // respuesta de referencia (string) opcional
      answerStr = answer != null ? JSON.stringify(String(answer)) : null;
    } else if (kind === "FILL_IN") {
      // estructura libre: p. ej. { answers: ["animal","fiel","amable"], blanks: 3 }
      // guardamos lo que nos mande el front en answer
      answerStr = answer != null ? JSON.stringify(answer) : null;

      // 💥 y también guardamos el banco de palabras (correctas + distractoras)
      if (choices != null) {
        choicesStr = JSON.stringify(choices);
      }
    } else {
      return res.status(400).json({ error: "KIND_NO_SOPORTADO" });
    }

    const id = crypto.randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "QuestionLite" (id, examId, kind, stem, choices, answer, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      id,
      exam.id,
      kind,
      stem.trim(),
      choicesStr,
      answerStr,
      Number(points) || 1
    );

    const row = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, "examId", kind, stem, choices, answer, points, "createdAt"
       FROM "QuestionLite" WHERE id = $1`,
      id
    );

    const q = row?.[0];
    if (!q) return res.status(500).json({ error: "NO_INSERTADO" });

    res.json({
      ...q,
      choices: q.choices ? JSON.parse(q.choices) : null,
      answer: q.answer ? JSON.parse(q.answer) : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Editar pregunta */
questionsRouter.put("/questions/:id", async (req, res) => {
  try {
    await ensureTable();
    const { id } = req.params;
    const { stem, choices, answer, points } = req.body ?? {};

    const rows = await prisma.$executeRawUnsafe(
      `UPDATE "QuestionLite"
       SET stem = COALESCE($1, stem),
           choices = COALESCE($2, choices),
           answer = COALESCE($3, answer),
           points = COALESCE($4, points)
       WHERE id = $5`,
      stem != null ? String(stem).trim() : null,
      choices != null ? JSON.stringify(choices) : null,
      answer != null ? JSON.stringify(answer) : null,
      Number.isFinite(points) ? Number(points) : null,
      id
    );

    const row = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, "examId", kind, stem, choices, answer, points, "createdAt"
       FROM "QuestionLite" WHERE id = $1`,
      id
    );
    const q = row?.[0];
    if (!q) return res.status(404).json({ error: "QUESTION_NOT_FOUND" });

    res.json({
      ...q,
      choices: q.choices ? JSON.parse(q.choices) : null,
      answer: q.answer ? JSON.parse(q.answer) : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Borrar pregunta */
questionsRouter.delete("/questions/:id", async (req, res) => {
  try {
    await ensureTable();
    const { id } = req.params;
    const rows = await prisma.$executeRawUnsafe(
      `DELETE FROM "QuestionLite" WHERE id = $1`,
      id
    );
    res.json({ ok: true, deleted: rows });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
