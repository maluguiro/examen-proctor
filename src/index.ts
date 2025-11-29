// api/src/index.ts
import express from "express";
import cors from "cors";
import "dotenv/config";

import { examsRouter } from "./routes/exams";
import { questionsRouter } from "./routes/questions";
import { prisma } from "./prisma";
import { ExamStatus } from "@prisma/client";

const app = express();
app.use(cors());
app.use(express.json());

// ---- helpers para crear examen ----
function randomCode(len = 6) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len)
    .toUpperCase();
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
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ✅ LISTA BÁSICA DE EXÁMENES
//    GET /api/exams
app.get("/api/exams", async (_req, res) => {
  try {
    const items = await prisma.exam.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        publicCode: true,
        durationMinutes: true,
        lives: true,
      },
    });

    const shaped = items.map((e) => ({
      ...e,
      code: e.publicCode || String(e.id).slice(0, 6),
      durationMins: e.durationMinutes ?? 0,
    }));

    res.json(shaped);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ✅ CREAR EXAMEN
//    POST /api/exams
//    body: { title, lives?, durationMins? }
app.post("/api/exams", async (req, res) => {
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

    if (!title?.trim()) {
      return res.status(400).json({ error: "FALTA_TITULO" });
    }

    const ownerId = process.env.DEFAULT_OWNER_ID || "docente-local";
    const code6 = await generateUniquePublicCode();

    const exam = await prisma.exam.create({
      data: {
        title: title.trim(),
        status: ExamStatus.DRAFT,
        lives: Number(lives) || 3,
        durationMinutes: Number(durationMin ?? durationMins ?? 0) || null,
        ownerId,
        publicCode: code6,
      },
      select: {
        id: true,
        title: true,
        status: true,
        lives: true,
        durationMinutes: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        publicCode: true,
      },
    });

    res.json({
      ...exam,
      code: exam.publicCode || String(exam.id).slice(0, 6),
      durationMins: exam.durationMinutes ?? 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// 👉 RESTO DE RUTAS (tablero, intents, review, etc.)
app.use("/api", examsRouter);
app.use("/api", questionsRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});
