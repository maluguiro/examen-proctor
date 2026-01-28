"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attempts = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const events_1 = require("./events");
exports.attempts = (0, express_1.Router)();
/**
 * PATCH /api/attempts/:id/lives
 * Docente perdona/descuenta vida. Máximo = Exam.lives
 */
exports.attempts.patch("/:id/lives", async (req, res) => {
    const { id } = req.params;
    const { op, reason } = req.body;
    const att = await prisma_1.prisma.attempt.findUnique({
        where: { id },
        include: { exam: true },
    });
    if (!att)
        return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    let newLives = att.livesUsed + (op === "increment" ? 1 : -1);
    if (newLives < 0)
        newLives = 0;
    // 👉 límite superior según Exam.lives (no maxLives)
    if (newLives > att.exam.lives)
        newLives = att.exam.lives;
    const updated = await prisma_1.prisma.attempt.update({
        where: { id },
        data: { livesUsed: newLives },
    });
    await (0, events_1.publishEvent)(att.examId, {
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
exports.attempts.post("/:id/events", async (req, res) => {
    const { id } = req.params;
    let { type } = req.body;
    if (!type)
        return res.status(400).json({ error: "Missing type" });
    type = String(type).trim().toUpperCase();
    const attempt = await prisma_1.prisma.attempt.findUnique({
        where: { id },
        select: { id: true, examId: true, livesUsed: true, status: true },
    });
    if (!attempt)
        return res.status(404).json({ error: "ATTEMPT_NOT_FOUND" });
    // 🔹 NUEVO: Si el intento ya no está en progreso, ignoramos el evento
    // para no descontar vidas ni registrar fraude post-entregado.
    if (attempt.status !== "in_progress") {
        return res.json({
            livesLeft: attempt.livesUsed,
            status: attempt.status,
            autoSubmitted: attempt.status === "SUBMITTED" || attempt.livesUsed === 0,
            ignored: true,
        });
    }
    const exam = await prisma_1.prisma.exam.findUnique({
        where: { id: attempt.examId },
        select: { lives: true, status: true },
    });
    if (!exam)
        return res.status(404).json({ error: "EXAM_NOT_FOUND" });
    const isOpen = String(exam.status).toUpperCase() === "OPEN";
    if (!isOpen)
        return res.status(403).json({ error: "EXAM_CLOSED" });
    const PENALTY = new Set([
        "BLUR",
        "VISIBILITY_HIDDEN",
        "COPY",
        "PASTE",
        "CONTEXT_MENU",
        "FULLSCREEN_EXIT",
    ]);
    let lives = attempt.livesUsed;
    if (PENALTY.has(type)) {
        lives = Math.max(lives - 1, 0);
        await prisma_1.prisma.attempt.update({
            where: { id: attempt.id },
            data: { livesUsed: lives },
        });
        await (0, events_1.publishEvent)(attempt.examId, {
            type: "LIFE_LOST",
            attemptId: attempt.id,
            lives,
            reason: type,
            ts: Date.now(),
        });
    }
    const autoSubmitted = lives === 0;
    if (autoSubmitted) {
        await prisma_1.prisma.attempt.update({
            where: { id: attempt.id },
            data: { status: "SUBMITTED", endedAt: new Date() },
        });
        await (0, events_1.publishEvent)(attempt.examId, {
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
