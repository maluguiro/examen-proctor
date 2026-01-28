"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
// C:\Users\Malena\examen-proctor\api\src\prisma.ts
const client_1 = require("@prisma/client");
// Evitar crear múltiples instancias en dev con ts-node-dev
const globalForPrisma = global;
exports.prisma = globalForPrisma.prisma ??
    new client_1.PrismaClient({
        log: ["error", "warn"], // podés agregar "query" si querés ver las queries
    });
if (process.env.NODE_ENV !== "production")
    globalForPrisma.prisma = exports.prisma;
