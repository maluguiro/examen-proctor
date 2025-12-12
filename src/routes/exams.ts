// api/src/routes/exams.ts

import { Router } from "express";
import { prisma } from "../prisma";
import crypto from "crypto";
import PDFDocument from "pdfkit"; // 👈 NUEVO

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
async function ensureExamChatTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ExamChatLite" (
      "id" TEXT PRIMARY KEY,
      "examId" TEXT NOT NULL,
      "fromRole" TEXT NOT NULL,
      "authorName" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "broadcast" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY("examId") REFERENCES "Exam"("id") ON DELETE CASCADE
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "idx_ExamChatLite_exam_created"
    ON "ExamChatLite"("examId","createdAt");
  `);
}
/**
 * GET /api/exams
 * Lista exámenes, opcionalmente filtrando por teacherName y/o subject.
 * Ejemplo:
 *   GET /api/exams?teacherName=Gomez
 */
examsRouter.get("/exams", async (req, res) => {
  try {
    const teacherNameRaw = String(req.query.teacherName ?? "").trim();
    const subjectRaw = String(req.query.subject ?? "").trim();

    const where: any = {};

    if (teacherNameRaw) {
      where.teacherName = {
        contains: teacherNameRaw,
        mode: "insensitive",
      };
    }

    if (subjectRaw) {
      where.subject = {
        contains: subjectRaw,
        mode: "insensitive",
      };
    }

    const exams = await prisma.exam.findMany({
      where,
      orderBy: {
        createdAt: "desc", // si por alguna razón no existe, podés cambiarlo a id
      },
    });

    const items = exams.map((e: any) => ({
      id: e.id,
      code: e.publicCode ?? e.id.slice(0, 6),
      title: e.title ?? "(sin título)",
      subject: e.subject ?? null,
      teacherName: e.teacherName ?? null,
      status: e.status ?? "DRAFT",
      openAt: e.openAt ? e.openAt.toISOString() : null,
      createdAt: e.createdAt ? e.createdAt.toISOString() : null,
    }));

    return res.json({ exams: items });
  } catch (e: any) {
    console.error("LIST_EXAMS_ERROR", e);
    return res.status(500).json({ error: e?.message || "LIST_EXAMS_ERROR" });
  }
});

/* -------------------------------------------------------------------------- */
/*                               RUTAS DOCENTE                                */
/* -------------------------------------------------------------------------- */

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
        lives: typeof (exam as any).lives === "number" ? (exam as any).lives : null,
        code: exam.publicCode ?? exam.id.slice(0, 6),
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
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
  try {
    await ensureExamChatTable();

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    // Traemos hasta 100 mensajes, ordenados por fecha
    const rows: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, fromRole, authorName, message, broadcast, createdAt
      FROM "ExamChatLite"
      WHERE examId = ?
      ORDER BY createdAt ASC
      LIMIT 100
    `,
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

    // 🔹 duración: soportamos durationMinutes o durationMin
    if (body.durationMinutes !== undefined && body.durationMinutes !== null) {
      const v = Number(body.durationMinutes);
      if (!Number.isNaN(v) && v >= 0) {
        const mins = Math.floor(v);
        data.durationMin = mins;
        data.durationMins = mins;
      }
    } else if (body.durationMin !== undefined && body.durationMin !== null) {
      const v = Number(body.durationMin);
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

    // abrir/cerrar examen
    if (typeof body.isOpen === "boolean") {
      data.status = (body.isOpen ? "OPEN" : "DRAFT") as any;
    }

    const updated = await prisma.exam.update({
      where: { id: exam.id },
      data,
    });

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
        endAt: true,
        status: true,
        score: true, // 👈 NUEVO: necesario para mostrar puntaje
      },
    });

    const ids = attempts.map((a) => a.id);
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

    const out = attempts.map((a) => {
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
        score: a.score ?? null,      // 👈 Alineado con front
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
      SELECT id, fromRole, authorName, message, broadcast, createdAt
      FROM "ExamChatLite"
      WHERE examId = ?
      ORDER BY createdAt ASC
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
 * POST /api/exams/:code/chat
 * Body: { fromRole: 'student' | 'teacher'; authorName: string; message: string }
 */
examsRouter.post("/exams/:code/chat", async (req, res) => {
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

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "ExamChatLite"
        (id, examId, fromRole, authorName, message, broadcast)
      VALUES (?, ?, ?, ?, ?, 0)
    `,
      id,
      exam.id,
      role,
      name,
      text
    );

    return res.json({ ok: true, id });
  } catch (e: any) {
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

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "ExamChatLite"
        (id, examId, fromRole, authorName, message, broadcast)
      VALUES (?, ?, 'teacher', ?, ?, 1)
    `,
      id,
      exam.id,
      name,
      text
    );

    return res.json({ ok: true, id });
  } catch (e: any) {
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
    const { studentName } = req.body ?? {};
    const name = String(studentName || "").trim();
    if (!name) {
      return res.status(400).json({ error: "MISSING_NAME" });
    }

    const exam = await findExamByCode(req.params.code);
    if (!exam) {
      return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    }

    const studentId = `s-${crypto.randomUUID()}`;

    const attempt = await prisma.attempt.create({
      data: {
        examId: exam.id,
        studentId,
        studentName: name,
        status: "in_progress", // usá el mismo string que ya venías usando
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

    // VIDAS: Exam.lives - Attempt.livesUsed
    const maxLives = (exam as any).lives != null ? (exam as any).lives : 3;
    const used =
      (attempt as any).livesUsed != null ? (attempt as any).livesUsed : 0;

    const remaining = Math.max(0, maxLives - used);

    // TIEMPO
    const durationMin =
      (exam as any).durationMin ?? (exam as any).durationMins ?? null;

    let secondsLeft: number | null = null;

    if (durationMin != null && attempt.startAt) {
      const totalSecs =
        durationMin * 60 + ((attempt as any).extraTimeSecs ?? 0);

      const elapsedSecs = Math.floor(
        (Date.now() - attempt.startAt.getTime()) / 1000
      );

      secondsLeft = Math.max(0, totalSecs - elapsedSecs);
    }

    // Si se quedó sin tiempo y aún no está marcado como terminado, lo cerramos
    if (secondsLeft === 0 && attempt.status !== "finished") {
      await prisma.attempt.update({
        where: { id: attempt.id },
        data: {
          status: "finished",
          endAt: new Date(),
        },
      });
    }

    return res.json({ remaining, secondsLeft });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "SUMMARY_ERROR" });
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
        meta: meta ?? null,
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
  try {
    const exam = await findExamByCode(req.params.code);
    if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

    await ensureQuestionLite();

    const list: any[] = await prisma.$queryRawUnsafe(
      `
      SELECT id, kind, stem, choices, answer, points
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

      try {
        await prisma.answer.create({
          data: {
            attemptId: attempt.id,
            questionId: q.id,
            content: typeof a.value === "string" ? a.value : a.value ?? null,
            score: partial,
          },
        });
      } catch (err) {
        console.error("ANSWER_CREATE_ERROR (no corta el submit):", err);
        // No rompemos el flujo si falla la FK:
        // igual seguimos sumando el puntaje y cerramos el intento.
      }

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

    const now = new Date();
    const hasEnded = at.endAt != null;

    // ¿la revisión ya está habilitada por fecha/hora?
    let openAtOk = true;
    if (exam.openAt instanceof Date) {
      openAtOk = exam.openAt <= now;
    }

    const canSee = gradingMode === "auto" && hasEnded && openAtOk;

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
          meta: meta ?? null,
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

/**
 * GET /api/attempts/:id/review.print
 * Versión HTML simple para imprimir/guardar como PDF.
 */
examsRouter.get("/attempts/:id/review.print", async (req, res) => {
  try {
    const r = await fetch(
      `http://localhost:${process.env.PORT || 3001}/api/attempts/${req.params.id
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
