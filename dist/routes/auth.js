"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
exports.authRouter = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-123";
/**
 * POST /api/auth/register
 * Body: { email, password, name }
 */
exports.authRouter.post("/register", async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ error: "MISSING_FIELDS" });
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        // Verificar existencia
        const existing = await prisma_1.prisma.user.findUnique({
            where: { email: normalizedEmail },
        });
        if (existing) {
            return res.status(400).json({ error: "EMAIL_ALREADY_EXISTS" });
        }
        // Hash password
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        // Crear User + TeacherProfile
        const user = await prisma_1.prisma.user.create({
            data: {
                email: normalizedEmail,
                role: "teacher",
                name: String(name).trim(),
                passwordHash,
                teacherProfile: {
                    create: {
                        fullName: String(name).trim(),
                        institutions: [], // array vacío inicial
                    },
                },
            },
        });
        // Generar JWT
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
        return res.status(201).json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            },
        });
    }
    catch (error) {
        console.error("REGISTER_ERROR", error);
        return res.status(500).json({ error: error?.message || "INTERNAL_ERROR" });
    }
});
/**
 * POST /api/auth/login
 * Body: { email, password }
 */
exports.authRouter.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "MISSING_FIELDS" });
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        // Buscar usuario
        const user = await prisma_1.prisma.user.findUnique({
            where: { email: normalizedEmail },
        });
        if (!user || !user.passwordHash) {
            return res.status(401).json({ error: "INVALID_CREDENTIALS" });
        }
        // Comparar password
        const valid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: "INVALID_CREDENTIALS" });
        }
        // Generar JWT
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            },
        });
    }
    catch (error) {
        console.error("LOGIN_ERROR", error);
        return res.status(500).json({ error: error?.message || "INTERNAL_ERROR" });
    }
});
