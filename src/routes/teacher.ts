import { Router } from "express";
import { prisma } from "../prisma";
// authMiddleware se aplica en index.ts antes de llamar a este router, 
// así que aquí ya tenemos req.user asegurado.
// Pero si queremos ser explícitos: se puede importar tipos si hace falta.

export const teacherRouter = Router();

/**
 * GET /api/teacher/profile
 * Devuelve el perfil del docente logueado.
 * (Si no existe, lo crea al vuelo)
 */
teacherRouter.get("/profile", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        let profile = await prisma.teacherProfile.findUnique({
            where: { userId },
        });

        if (!profile) {
            // Intenta obtener nombre del user, si lo tenemos en el token o DB
            // Para simplificar, usamos lo del token si está, o buscamos user
            const user = await prisma.user.findUnique({ where: { id: userId } });
            const initialName = user?.name || "Docente sin nombre";

            profile = await prisma.teacherProfile.create({
                data: {
                    userId,
                    fullName: initialName,
                    institutions: [],
                },
            });
        }

        return res.json({ profile });
    } catch (err: any) {
        console.error("GET_PROFILE_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});

/**
 * PUT /api/teacher/profile
 * Body: { fullName, institutions }
 */
teacherRouter.put("/profile", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const { fullName, institutions } = req.body;
        const dataToUpdate: any = {};

        if (fullName !== undefined) {
            dataToUpdate.fullName = String(fullName).trim();
        }

        if (institutions !== undefined) {
            // Se podría validar estructura, por ahora confiamos sea array
            if (!Array.isArray(institutions)) {
                return res.status(400).json({ error: "INSTITUTIONS_MUST_BE_ARRAY" });
            }
            dataToUpdate.institutions = institutions;
        }

        // Upsert para asegurar
        const updated = await prisma.teacherProfile.upsert({
            where: { userId },
            create: {
                userId,
                fullName: dataToUpdate.fullName || "Docente",
                institutions: dataToUpdate.institutions || [],
            },
            update: dataToUpdate,
        });

        return res.json({ profile: updated });
    } catch (err: any) {
        console.error("UPDATE_PROFILE_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});

/**
 * PATCH /api/teacher/profile
 * Actualización parcial del perfil.
 * Protegido por autenticación (userId en req.user).
 */
teacherRouter.patch("/profile", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const { fullName, institutions } = req.body;
        const data: any = {};

        if (fullName !== undefined) {
            data.fullName = String(fullName).trim();
        }
        if (institutions !== undefined) {
            // Validación básica de array
            if (!Array.isArray(institutions)) {
                return res.status(400).json({ error: "INSTITUTIONS_MUST_BE_ARRAY" });
            }
            data.institutions = institutions;
        }

        // Se asume que el perfil existe (creado al registrarse o en GET previo)
        const updated = await prisma.teacherProfile.update({
            where: { userId },
            data,
        });

        return res.json({ profile: updated });
    } catch (err: any) {
        console.error("PATCH_PROFILE_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});

/**
 * GET /api/teacher/calendar
 * Devuelve el calendario (events + tasks) del docente logueado.
 */
teacherRouter.get("/calendar", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const calendar = await prisma.teacherCalendar.findUnique({
            where: { teacherId: userId },
        });

        if (!calendar) {
            return res.json({ events: [], tasks: [] });
        }

        return res.json({
            events: Array.isArray(calendar.events) ? calendar.events : [],
            tasks: Array.isArray(calendar.tasks) ? calendar.tasks : [],
        });
    } catch (err: any) {
        console.error("GET_TEACHER_CALENDAR_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});

/**
 * PUT /api/teacher/calendar
 * Body: { events, tasks }
 */
teacherRouter.put("/calendar", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const { events, tasks } = req.body;

        if (!Array.isArray(events)) {
            return res.status(400).json({ error: "EVENTS_MUST_BE_ARRAY" });
        }
        if (!Array.isArray(tasks)) {
            return res.status(400).json({ error: "TASKS_MUST_BE_ARRAY" });
        }

        const calendar = await prisma.teacherCalendar.upsert({
            where: { teacherId: userId },
            create: {
                teacherId: userId,
                events,
                tasks,
            },
            update: {
                events,
                tasks,
            },
        });

        return res.json({
            events: Array.isArray(calendar.events) ? calendar.events : [],
            tasks: Array.isArray(calendar.tasks) ? calendar.tasks : [],
        });
    } catch (err: any) {
        console.error("PUT_TEACHER_CALENDAR_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});

/**
 * GET /api/teacher/exams
 * Lista los exámenes creados por el docente logueado.
 */
teacherRouter.get("/exams", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        const exams = await prisma.exam.findMany({
            where: { ownerId: userId },
            orderBy: { createdAt: "desc" },
        });

        const shaped = exams.map((e) => {
            const durationRaw = e.durationMin ?? e.durationMins ?? null;
            const durationMinutes = typeof durationRaw === "number" ? durationRaw : null;
            return {
                id: e.id,
                title: e.title,
                status: e.status,
                createdAt: e.createdAt,
                code: e.publicCode ?? e.id.slice(0, 6),
                durationMinutes,
                lives: e.lives,
                // Campos nuevos
                university: e.university,
                subject: e.subject,
                teacherName: e.teacherName,
            };
        });

        return res.json({ exams: shaped });
    } catch (err: any) {
        console.error("GET_TEACHER_EXAMS_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});
