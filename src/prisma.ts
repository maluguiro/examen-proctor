// C:\Users\Malena\examen-proctor\api\src\prisma.ts
import { PrismaClient } from "@prisma/client";

// Evitar crear múltiples instancias en dev con ts-node-dev
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"], // podés agregar "query" si querés ver las queries
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;