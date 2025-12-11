import { Router } from "express";
import { prisma } from "../lib/prisma";
import { publishEvent } from "./events";

export const attempts = Router();

/**
 * PATCH /api/attempts/:id/lives
 * Docente perdona/descuenta vida. Máximo = Exam.lives
 */
attempts.patch("/:id/lives", async (req, res) => {
  const { id } = req.params;
  const { op, reason } = req.body as {
    op: "increment" | "decrement";
    reason?: string;
  };

  const att = await prisma.attempt.findUnique({
    where: { id },
    include: { Exam: true },
  });
  if (!att) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

  let newLives = att.lives + (op === "increment" ? 1 : -1);
  if (newLives < 0) newLives = 0;
  // 👉 límite superior según Exam.lives (no maxLives)
  if (newLives > att.Exam.lives) newLives = att.Exam.lives;

  const updated = await prisma.attempt.update({
    where: { id },
    data: { lives: newLives },
  });

  await publishEvent(att.examId, {
    type: op === "increment" ? "LIFE_FORGIVEN" : "LIFE_LOST",
    attemptId: id,
    lives: newLives,
    reason: reason ?? null,
    ts: Date.now(),
  });

  res.json({ attempt: updated });
});

/**
 * POST /api/attempts/:id/events
 * Alumno envía evento antifraude. Resta vida si corresponde.
 */
attempts.post("/:id/events", async (req, res) => {
  const { id } = req.params;
  let { type } = req.body as { type: string };
  if (!type) return res.status(400).json({ error: "Missing type" });
  type = String(type).trim().toUpperCase();

  const attempt = await prisma.attempt.findUnique({
    where: { id },
    select: { id: true, examId: true, lives: true, status: true },
  });
  if (!attempt) return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });

  // 🔹 NUEVO: Si el intento ya no está en progreso, ignoramos el evento
  // para no descontar vidas ni registrar fraude post-entregado.
  if (attempt.status !== "in_progress") {
    return res.json({
      livesLeft: attempt.lives,
      status: attempt.status,
      autoSubmitted: attempt.status === "SUBMITTED" || attempt.lives === 0,
      ignored: true,
    });
  }

  const exam = await prisma.exam.findUnique({
    where: { id: attempt.examId },
    select: { lives: true, status: true },
  });
  if (!exam) return res.status(404).json({ error: "EXAM_NOT_FOUND" });

  const isOpen = String(exam.status).toUpperCase() === "OPEN";
  if (!isOpen) return res.status(403).json({ error: "EXAM_CLOSED" });

  const PENALTY = new Set([
    "BLUR",
    "VISIBILITY_HIDDEN",
    "COPY",
    "PASTE",
    "CONTEXT_MENU",
    "FULLSCREEN_EXIT",
  ]);

  let lives = attempt.lives;
  if (PENALTY.has(type)) {
    lives = Math.max(lives - 1, 0);
    await prisma.attempt.update({ where: { id: attempt.id }, data: { lives } });
    await publishEvent(attempt.examId, {
      type: "LIFE_LOST",
      attemptId: attempt.id,
      lives,
      reason: type,
      ts: Date.now(),
    });
  }

  const autoSubmitted = lives === 0;
  if (autoSubmitted) {
    await prisma.attempt.update({
      where: { id: attempt.id },
      data: { status: "SUBMITTED", endedAt: new Date() } as any,
    });
    await publishEvent(attempt.examId, {
      type: "AUTO_SUBMITTED",
      attemptId: attempt.id,
      lives,
      ts: Date.now(),
    });
  }

  res.json({
    livesLeft: lives,
    status: autoSubmitted ? "SUBMITTED" : attempt.status,
    autoSubmitted,
  });
});
