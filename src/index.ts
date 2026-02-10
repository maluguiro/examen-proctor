// Servidor principal del sistema de exámenes con proctor antifraude.
// api/src/index.ts
import express from "express";
import cors from "cors";
import "dotenv/config";
import crypto from "crypto";
import "dotenv/config";

// Importamos nuevas rutas
import { authRouter } from "./routes/auth";
import { teacherRouter } from "./routes/teacher";
import { authMiddleware } from "./authMiddleware";

import { examsRouter } from "./routes/exams";
import { questionsRouter } from "./routes/questions";
import { prisma } from "./prisma";
import { ExamRole, ExamStatus } from "@prisma/client";

const app = express();
const allowedOrigins = new Set<string>(["http://localhost:3000"]);
if (process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .forEach((origin) => allowedOrigins.add(origin));
}
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("CORS_NOT_ALLOWED"));
    },
  })
);
app.use(express.json());

// Compat: puente /auth/* -> /api/auth/*
app.use("/auth", (req, res) => {
  const target = "/api" + req.originalUrl;
  return res.redirect(307, target);
});

// Montamos AUTH y TEACHER
app.use("/api/auth", authRouter);
app.use("/api/teacher", authMiddleware, teacherRouter);

// ---- helpers para crear examen ----
function randomCode(len = 6) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len)
    .toUpperCase();
}
async function generateExamPublicCode(): Promise<string> {
  while (true) {
    // Código de 6 caracteres en HEX, tipo "A3F9C1"
    const code = crypto.randomBytes(3).toString("hex").toUpperCase();

    const exists = await prisma.exam.findFirst({
      where: { publicCode: code },
    });

    if (!exists) return code;
  }
}

async function generateUniquePublicCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomCode(6);
    const clash = await prisma.exam.findFirst({
      where: { publicCode: code },
    });
    if (!clash) return code;
  }
  return randomCode(6);
}

// ✅ HEALTHCHECK
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ CREAR EXAMEN
//    POST /api/exams
//    body: { title, lives?, durationMins? }
// body: { title, lives?, durationMins? }
// GET /api/exams
app.get("/api/exams", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "NO_TOKEN_PROVIDED" });
    }

    const items = await prisma.exam.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
                role: {
                  in: [ExamRole.OWNER, ExamRole.GRADER, ExamRole.PROCTOR],
                },
              },
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        publicCode: true,
        // 👇 solo estos dos, que sí existen en el modelo Exam
        durationMin: true,
        durationMins: true,
        lives: true,
        university: true,
        subject: true,
      },
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("EXAMS_LIST_SCOPE", { userId, count: items.length });
    }

    // Adaptamos lo que viene de la DB al formato que espera el frontend
    const shaped = items.map((e) => {
      const durationRaw = e.durationMin ?? e.durationMins ?? null;
      const durationMinutes =
        typeof durationRaw === "number" ? durationRaw : null;

      return {
        id: e.id,
        title: e.title,
        status: e.status,
        createdAt: e.createdAt,
        code: e.publicCode ?? e.id.slice(0, 6),
        // 👇 este nombre sí lo usamos hacia el front
        durationMinutes,
        lives: e.lives,
        university: e.university ?? null,
        subject: e.subject ?? null,
      };
    });

    res.json(shaped);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});
// ✅ CREAR EXAMEN
//    POST /api/exams
//    body: { title, lives?, durationMinutes?, userSubject?, userUniversity? }
//    Requiere AUTH. Usa el userId como ownerId.
app.post("/api/exams", authMiddleware, async (req, res) => {
  try {
    const body = req.body ?? {};

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "NO_TOKEN_PROVIDED" });
    }

    const rawTitle = body.title ?? "";
    const title = String(rawTitle).trim();

    if (!title) {
      return res.status(400).json({ error: "FALTA_TITULO" });
    }

    const rawLives = body.lives;
    const lives =
      rawLives === undefined || rawLives === null
        ? 3
        : Math.max(0, Math.floor(Number(rawLives) || 0));

    // Soportamos varios nombres de campo para duración
    const rawDuration =
      body.durationMinutes ?? body.durationMin ?? body.durationMins ?? null;

    const durationMin =
      rawDuration == null
        ? null
        : Math.max(0, Math.floor(Number(rawDuration) || 0));

    // Auth: Si hay usuario logueado, lo usamos como owner
    const ownerId = userId;
    const teacherName: string | null = null;

    // Campos adicionales (university, subject)
    const university =
      body.university !== undefined && body.university !== null
        ? String(body.university).trim() || null
        : null;
    const subjectRaw =
      body.subject !== undefined && body.subject !== null
        ? body.subject
        : body.userSubject;
    const subject =
      subjectRaw !== undefined && subjectRaw !== null
        ? String(subjectRaw).trim() || null
        : null;

    const publicCode = await generateExamPublicCode();

    const exam = await prisma.exam.create({
      data: {
        title,
        status: "DRAFT",
        lives,
        durationMin,
        durationMins: durationMin,
        ownerId,
        publicCode,
        university,
        subject,
        teacherName,
      },
    });

    try {
      await prisma.examMember.upsert({
        where: { examId_userId: { examId: exam.id, userId } },
        create: {
          examId: exam.id,
          userId,
          role: ExamRole.OWNER,
        },
        update: { role: ExamRole.OWNER },
      });
    } catch (e) {
      console.error("CREATE_EXAM_MEMBER_ERROR", e);
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("EXAM_CREATED", { examId: exam.id, ownerId });
    }

    const durationRaw2 = exam.durationMin ?? exam.durationMins ?? null;
    const durationMinutes =
      typeof durationRaw2 === "number" ? durationRaw2 : null;

    return res.json({
      id: exam.id,
      title: exam.title,
      status: exam.status,
      createdAt: exam.createdAt,
      code: exam.publicCode ?? exam.id.slice(0, 6),
      durationMinutes,
      lives: exam.lives,
    });
  } catch (e: any) {
    console.error("CREATE_EXAM_ERROR", e);
    return res.status(500).json({ error: e?.message || "CREATE_EXAM_ERROR" });
  }
});

// 👉 RESTO DE RUTAS (tablero, intents, review, etc.)
app.use("/api", examsRouter);
app.use("/api", questionsRouter);

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});
