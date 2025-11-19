import { Router } from "express";
import { prisma } from "../prisma";
import crypto from "crypto";

export const questionsRouter = Router();

/** Asegura que exista la tabla QuestionLite (sin Prisma) */
async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "QuestionLite" (
      id TEXT PRIMARY KEY,
      examId TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 'MCQ' | 'TRUE_FALSE' | 'SHORT_TEXT' | 'FILL_IN'
      stem TEXT NOT NULL,            -- enunciado
      choices TEXT,                  -- JSON string (solo MCQ / TRUE_FALSE)
      answer TEXT,                   -- JSON string (respuesta correcta o forma de corregir)
      points INTEGER NOT NULL DEFAULT 1,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- índices útiles
      FOREIGN KEY(examId) REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);
}

/** Resuelve un examen por publicCode / id / prefijo / título */
async function resolveExamId(codeRaw: string): Promise<{ id: string } | null> {
  const code = String(codeRaw || "").trim();
  if (!code) return null;

  // por publicCode exacto
  let rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE publicCode = ? LIMIT 1`,
    code
  );
  if (rows?.[0]) return rows[0];

  // por id exacto
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE id = ? LIMIT 1`,
    code
  );
  if (rows?.[0]) return rows[0];

  // por prefijo de id
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE id LIKE ? LIMIT 1`,
    `${code}%`
  );
  if (rows?.[0]) return rows[0];

  // por título exacto (case-insensitive)
  rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Exam" WHERE LOWER(title) = LOWER(?) LIMIT 1`,
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
      `SELECT id, examId, kind, stem, choices, answer, points, createdAt
       FROM "QuestionLite"
       WHERE examId = ?
       ORDER BY createdAt ASC`,
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
      // estructura libre: p. ej. { blanks: 2, answers: ["x","y"] }
      answerStr = answer != null ? JSON.stringify(answer) : null;
    } else {
      return res.status(400).json({ error: "KIND_NO_SOPORTADO" });
    }

    const id = crypto.randomUUID();

    await prisma.$executeRawUnsafe(
      `INSERT INTO "QuestionLite" (id, examId, kind, stem, choices, answer, points)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      exam.id,
      kind,
      stem.trim(),
      choicesStr,
      answerStr,
      Number(points) || 1
    );

    const row = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, examId, kind, stem, choices, answer, points, createdAt
       FROM "QuestionLite" WHERE id = ?`,
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
       SET stem = COALESCE(?, stem),
           choices = COALESCE(?, choices),
           answer = COALESCE(?, answer),
           points = COALESCE(?, points)
       WHERE id = ?`,
      stem != null ? String(stem).trim() : null,
      choices != null ? JSON.stringify(choices) : null,
      answer != null ? JSON.stringify(answer) : null,
      Number.isFinite(points) ? Number(points) : null,
      id
    );

    const row = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, examId, kind, stem, choices, answer, points, createdAt
       FROM "QuestionLite" WHERE id = ?`,
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
      `DELETE FROM "QuestionLite" WHERE id = ?`,
      id
    );
    res.json({ ok: true, deleted: rows });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
