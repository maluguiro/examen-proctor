import { Router } from "express";
import { prisma } from "../prisma";
// authMiddleware se aplica en index.ts antes de llamar a este router, 
// así que aquí ya tenemos req.user asegurado.
// Pero si queremos ser explícitos: se puede importar tipos si hace falta.

export const teacherRouter = Router();
type InstitutionInput = {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    subjects?: unknown;
};

type SubjectInput = {
    id?: unknown;
    name?: unknown;
};

function makeId(prefix: string) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now()}_${rand}`;
}

function normalizeInstitutions(input: unknown) {
    if (!Array.isArray(input)) return [];

    const institutions: any[] = [];
    const seenInstitutions = new Set<string>();

    for (const raw of input) {
        const inst = (raw ?? {}) as InstitutionInput;
        const name = typeof inst.name === "string" ? inst.name.trim() : "";
        if (!name) continue;

        const nameKey = name.toLowerCase();
        if (seenInstitutions.has(nameKey)) continue;
        seenInstitutions.add(nameKey);

        const subjectsRaw = inst.subjects;
        const subjectsArray = Array.isArray(subjectsRaw) ? subjectsRaw : [];
        const subjects: any[] = [];
        const seenSubjects = new Set<string>();

        for (const s of subjectsArray) {
            const subj = (s ?? {}) as SubjectInput;
            const subjName =
                typeof subj.name === "string" ? subj.name.trim() : "";
            if (!subjName) continue;

            const subjKey = subjName.toLowerCase();
            if (seenSubjects.has(subjKey)) continue;
            seenSubjects.add(subjKey);

            subjects.push({
                id:
                    typeof subj.id === "string" && subj.id.trim()
                        ? subj.id.trim()
                        : makeId("subj"),
                name: subjName,
            });
        }

        institutions.push({
            id:
                typeof inst.id === "string" && inst.id.trim()
                    ? inst.id.trim()
                    : makeId("inst"),
            name,
            kind: inst.kind,
            subjects,
        });
    }

    return institutions;
}

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

        const normalizedInstitutions = normalizeInstitutions(
            (profile as any).institutions
        );

        const currentInstitutions = Array.isArray((profile as any).institutions)
            ? (profile as any).institutions
            : [];
        const currentStr = JSON.stringify(currentInstitutions);
        const normalizedStr = JSON.stringify(normalizedInstitutions);

        if (currentStr !== normalizedStr) {
            try {
                profile = await prisma.teacherProfile.update({
                    where: { userId },
                    data: { institutions: normalizedInstitutions },
                });
            } catch (e) {
                console.error("NORMALIZE_PROFILE_ERROR", e);
            }
        }

        return res.json({
            profile: {
                ...profile,
                institutions: normalizedInstitutions,
            },
        });
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
            const normalizedInstitutions = normalizeInstitutions(institutions);
            dataToUpdate.institutions = normalizedInstitutions;
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

        const normalizedInstitutions = normalizeInstitutions(
            (updated as any).institutions
        );

        return res.json({
            profile: {
                ...updated,
                institutions: normalizedInstitutions,
            },
        });
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
            const normalizedInstitutions = normalizeInstitutions(institutions);
            data.institutions = normalizedInstitutions;
        }

        // Se asume que el perfil existe (creado al registrarse o en GET previo)
        const updated = await prisma.teacherProfile.update({
            where: { userId },
            data,
        });

        const normalizedInstitutions = normalizeInstitutions(
            (updated as any).institutions
        );

        return res.json({
            profile: {
                ...updated,
                institutions: normalizedInstitutions,
            },
        });
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
                startsAt: e.startsAt ?? null,
                endsAt: e.endsAt ?? null,
                openAt: e.openAt ?? null,
                gradingMode: e.gradingMode,
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

/**
 * POST /api/teacher/exams/claim-legacy
 * Reclama exámenes legacy (ownerId = "docente-local") sin membresías.
 * Dev-only + ENABLE_LEGACY_CLAIM=true
 */
teacherRouter.post("/exams/claim-legacy", async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });

        if (process.env.NODE_ENV === "production" || process.env.ENABLE_LEGACY_CLAIM !== "true") {
            return res.status(404).json({ error: "NOT_FOUND" });
        }

        const legacy = await prisma.exam.findMany({
            where: {
                ownerId: "docente-local",
                members: { none: {} },
            },
            select: { id: true },
        });

        const examIds = legacy.map((e) => e.id);
        if (examIds.length === 0) {
            return res.json({ claimed: 0, examIds: [] });
        }

        const claimed = await prisma.$transaction(async (tx) => {
            const update = await tx.exam.updateMany({
                where: { id: { in: examIds }, ownerId: "docente-local" },
                data: { ownerId: userId },
            });

            await tx.examMember.createMany({
                data: examIds.map((id) => ({
                    examId: id,
                    userId,
                    role: "OWNER",
                })),
                skipDuplicates: true,
            });

            return update.count;
        });

        if (process.env.NODE_ENV !== "production") {
            console.log("LEGACY_CLAIM", {
                userId,
                claimed,
                examIdsCount: examIds.length,
            });
        }

        return res.json({ claimed, examIds });
    } catch (err: any) {
        console.error("CLAIM_LEGACY_EXAMS_ERROR", err);
        return res.status(500).json({ error: err?.message || "INTERNAL_ERROR" });
    }
});



