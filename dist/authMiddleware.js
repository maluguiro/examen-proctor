"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.optionalAuthMiddleware = optionalAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-123";
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).json({ error: "NO_TOKEN_PROVIDED" });
        return; // explícitamente retornamos void
    }
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
        res.status(401).json({ error: "INVALID_TOKEN_FORMAT" });
        return;
    }
    const token = parts[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        };
        next();
    }
    catch (err) {
        res.status(401).json({ error: "INVALID_OR_EXPIRED_TOKEN" });
        return;
    }
}
function optionalAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    // Si no hay token, dejamos pasar (req.user será undefined)
    if (!authHeader) {
        return next();
    }
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
        // Si el formato es malo pero opcional, ¿ignoramos o fallamos?
        // Comúnmente se ignora y se trata como anónimo
        return next();
    }
    const token = parts[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        };
    }
    catch (err) {
        // Token inválido: igual dejamos pasar como anónimo
    }
    next();
}
