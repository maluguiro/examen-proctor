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
