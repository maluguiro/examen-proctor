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
