// api/src/routes/exams.ts

import { Router } from "express";
import { prisma } from "../prisma";
import crypto from "crypto";

export const examsRouter = Router();

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
  return {
    id: exam.id,
    title: exam.title,
    status: exam.status, // ExamStatus enum -> front lo muestra como string
    durationMinutes:
      typeof exam.durationMinutes === "number" ? exam.durationMinutes : null,
    lives: typeof exam.lives === "number" ? exam.lives : null,
    code: exam.publicCode ?? exam.id.slice(0, 6),
  };
}

/** Devuelve el objeto meta que espera el front en `/exams/:code/meta` */
function toMetaResponse(exam: any) {
  if (!exam) return null;
  return {
    examId: exam.id,
    teacherName: exam.teacherName ?? null,
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
  };
}

/** Asegura la tabla QuestionLite (se comparte el formato con el builder) */
async function ensureQuestionLite() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "QuestionLite" (
      id        TEXT PRIMARY KEY,
      examId    TEXT NOT NULL,
      kind      TEXT NOT NULL, -- 'MCQ' | 'TRUE_FALSE' | 'SHORT_TEXT' | 'FILL_IN'
      stem      TEXT NOT NULL, -- enunciado
      choices   TEXT,          -- JSON string (solo MCQ / TRUE_FALSE)
      answer    TEXT,          -- JSON string (respuesta correcta)
      points    INTEGER NOT NULL DEFAULT 1,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(examId) REFERENCES "Exam"(id) ON DELETE CASCADE
    );
  `);
}

/* -------------------------------------------------------------------------- */
/*                               RUTAS DOCENTE                                */
/* -------------------------------------------------------------------------- */

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
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const body = req.body ?? {};
    const data: any = {};

    if (typeof body.title === "string" && body.title.trim()) {
      data.title = body.title.trim();
    }

    // Soportamos tanto durationMinutes nuevo como durationMin viejo (por compat)
    if (body.durationMinutes !== undefined && body.durationMinutes !== null) {
      const v = Number(body.durationMinutes);
      if (!Number.isNaN(v) && v >= 0) data.durationMinutes = Math.floor(v);
    } else if (body.durationMin !== undefined && body.durationMin !== null) {
      const v = Number(body.durationMin);
      if (!Number.isNaN(v) && v >= 0) data.durationMinutes = Math.floor(v);
    }

    if (body.lives !== undefined && body.lives !== null) {
      const v = Math.max(0, Math.floor(Number(body.lives) || 0));
      data.lives = v;
    }

    if (typeof body.isOpen === "boolean") {
      data.status = (body.isOpen ? "OPEN" : "DRAFT") as any;
    }

    const updated = await prisma.exam.update({
      where: { id: exam.id },
      data,
    });

    return res.json({ exam: toExamResponse(updated) });
  } catch (e: any) {
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
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const meta = toMetaResponse(exam);
    return res.json({ meta });
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
examsRouter.get("/exams/:code/attempts", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const attempts = await prisma.attempt.findMany({
      where: { examId: exam.id },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        studentName: true,
        livesUsed: true,
        paused: true,
        startAt: true,
      },
    });

    const ids = attempts.map((a) => a.id);
    const events = await prisma.event.findMany({
      where: { attemptId: { in: ids } },
      select: { attemptId: true, type: true, reason: true },
    });

    const byAttempt = new Map<string, string[]>();
    for (const ev of events) {
      const arr = byAttempt.get(ev.attemptId) ?? [];
      arr.push(ev.reason || ev.type || "UNKNOWN");
      byAttempt.set(ev.attemptId, arr);
    }

    const out = attempts.map((a) => {
      const used = a.livesUsed ?? 0;
      const maxLives = exam.lives ?? 3;
      const remaining = Math.max(0, maxLives - used);
      const vio = byAttempt.get(a.id) ?? [];
      return {
        id: a.id,
        studentName: a.studentName || "(sin nombre)",
        livesRemaining: remaining,
        paused: !!a.paused,
        violations: JSON.stringify(vio),
        startedAt: a.startAt.toISOString(),
      };
    });

    return res.json({ attempts: out });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
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
        questionOrder: null,
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

/* -------------------------------------------------------------------------- */
/*                               RUTAS ALUMNO                                 */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/exams/:code/attempts/start
 * Crea un Attempt real para el alumno.
 */
examsRouter.post("/exams/:code/attempts/start", async (req, res) => {
  try {
    const { studentName } = req.body ?? {};
    const name = String(studentName || "").trim();
    if (!name) return res.status(400).json({ error: "MISSING_NAME" });

    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    const studentId = `s-${crypto.randomUUID()}`;
    const attempt = await prisma.attempt.create({
      data: {
        examId: exam.id,
        studentId,
        studentName: name,
        status: "in_progress",
        startAt: new Date(),
        endAt: null,
        score: null,
        livesUsed: 0,
        paused: false,
        extraTimeSecs: 0,
        questionOrder: null,
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
 * GET /api/exams/:code/paper
 * Devuelve el "paper" del examen: título + lista de preguntas desde QuestionLite.
 */
examsRouter.get("/exams/:code/paper", async (req, res) => {
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    await ensureQuestionLite();

    const list: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, kind, stem, choices, points
      FROM "QuestionLite"
      WHERE examId = ?
      ORDER BY createdAt ASC
    `,
      exam.id
    );

    const questions = (list || []).map((q) => {
      let choices: string[] | null = null;
      try {
        choices = q.choices ? JSON.parse(String(q.choices)) : null;
      } catch {
        choices = null;
      }
      // Mapeo mínimo viable a lo que espera el front s/[code]/page.tsx
      let kind: string = String(q.kind || "").toUpperCase();
      if (kind === "TEXT") kind = "SHORT";
      if (kind === "FILL_IN") kind = "FIB";

      return {
        id: q.id,
        kind,
        stem: q.stem,
        choices,
        points: q.points ?? 1,
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
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * POST /api/attempts/:id/submit
 * Corrige el intento (si gradingMode = auto) y guarda respuestas en Answer.
 * Body:
 * {
 *   answers: [{ questionId, value }]
 * }
 */
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

    // gradingMode ahora viene de Exam directamente
    let gradingMode: "auto" | "manual" = "auto";
    const gm = String(exam.gradingMode || "auto").toLowerCase();
    if (gm === "manual") gradingMode = "manual";

    const arr = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!arr.length) return res.status(400).json({ error: "NO_ANSWERS" });

    await ensureQuestionLite();

    const qs: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE examId = ?
      ORDER BY createdAt ASC
    `,
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
        const kind = String(q.kind || "").toUpperCase();
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
          if (corr && given && corr === given) partial = pts;
          else partial = 0;
        } else if (kind === "FILL_IN") {
          // esperamos { answers: string[] }
          let expected: string[] = [];
          try {
            if (Array.isArray(correct?.answers)) {
              expected = correct.answers.map((x: any) => String(x ?? ""));
            }
          } catch {
            expected = [];
          }
          const givenArr: string[] = Array.isArray(a.value)
            ? a.value.map((v: any) => String(v ?? ""))
            : [];
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

      await prisma.answer.create({
        data: {
          attemptId: attempt.id,
          questionId: q.id,
          content: a.value ?? null,
          isCorrect:
            gradingMode === "auto" && typeof partial === "number"
              ? partial >= (q.points ?? 1)
              : null,
          score:
            gradingMode === "auto" && typeof partial === "number"
              ? partial
              : null,
          timeSpentMs: 0,
        },
      });

      if (typeof partial === "number") score += partial;
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
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/attempts/:id/review
 * (versión mínima: solo disponible si gradingMode = auto y el intento terminó)
 */
examsRouter.get("/attempts/:id/review", async (req, res) => {
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

    const canSee = gradingMode === "auto" && at.endAt != null;
    if (!canSee) return res.status(403).json({ error: "REVIEW_NOT_AVAILABLE" });

    await ensureQuestionLite();

    const qs: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, kind, stem, choices, answer, points
      FROM "QuestionLite"
      WHERE examId = ?
      ORDER BY createdAt ASC
    `,
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
      const given = a?.content ?? null;

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
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * GET /api/attempts/:id/review.print
 * Versión HTML simple para imprimir/guardar como PDF.
 */
examsRouter.get("/attempts/:id/review.print", async (req, res) => {
  try {
    const r = await fetch(
      `http://localhost:${process.env.PORT || 3001}/api/attempts/${
        req.params.id
      }/review`
    );
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).send(text);
    }

    const data: any = await r.json();

    const esc = (s: any) =>
      String(s ?? "").replace(/[&<>"]/g, (c) => {
        return (
          {
            "&": "&",
            "<": "<",
            ">": ">",
            '"': '"',
          } as any
        )[c];
      });

    const started = new Date(data.attempt.startedAt);
    const finished = data.attempt.finishedAt
      ? new Date(data.attempt.finishedAt)
      : null;
    const diffMs = finished ? finished.getTime() - started.getTime() : 0;
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);

    const header = `
Alumno: ${esc(data.attempt.studentName)}

Comenzado el: ${esc(started.toLocaleString())}

Estado: ${finished ? "Finalizado" : "En curso"}

Finalizado en: ${finished ? esc(finished.toLocaleString()) : "-"}

Tiempo empleado: ${finished ? `${mins} min ${secs} s` : "-"}

Puntos: ${data.attempt.score ?? "-"} / ${data.attempt.maxScore}
`;

    const body = data.questions
      .map((q: any, i: number) => {
        const num = i + 1;
        return `
Pregunta ${num}
${esc(q.stem)}

Puntos: ${q.points ?? 1}
Tu respuesta: ${esc(
          typeof q.given === "string"
            ? q.given
            : JSON.stringify(q.given ?? null)
        )}
Correcta: ${esc(
          typeof q.correct === "string"
            ? q.correct
            : JSON.stringify(q.correct ?? null)
        )}

`;
      })
      .join("");

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Revisión — ${esc(data.exam.title)}</title>
</head>
<body>
  <h1>Revisión — ${esc(data.exam.title)}</h1>
  <pre>${esc(header)}</pre>
  <hr />
  <pre>${esc(body)}</pre>
</body>
</html>
`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (e: any) {
    return res.status(500).send(e?.message || String(e));
  }
});
