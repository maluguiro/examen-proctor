import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-123";

// Extendemos Request para incluir user
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                email: string;
                role: string;
            };
        }
    }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
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
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        };
        next();
    } catch (err) {
        res.status(401).json({ error: "INVALID_OR_EXPIRED_TOKEN" });
        return;
    }
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
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
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        req.user = {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        };
    } catch (err) {
        // Token inválido: igual dejamos pasar como anónimo
    }
    next();
}
