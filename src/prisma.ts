// C:\Users\Malena\examen-proctor\api\src\prisma.ts
import dotenv from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

// Cargar env antes de instanciar Prisma (soporta ejecuciones desde root o /Backend)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL missing. Check Backend/.env and how you start the server."
  );
}

let dbUrl: URL;
try {
  dbUrl = new URL(process.env.DATABASE_URL);
} catch {
  throw new Error("DATABASE_URL invalid. Check format (postgresql://...).");
}

if (!dbUrl.username) {
  throw new Error(
    "DATABASE_URL missing username (Neon user). This leads to Prisma 'not available' credentials."
  );
}
if (!dbUrl.hostname) {
  throw new Error("DATABASE_URL missing hostname.");
}

if (process.env.NODE_ENV !== "production") {
  console.log("[DB]", {
    host: dbUrl.hostname,
    db: dbUrl.pathname,
    hasUser: !!dbUrl.username,
  });
}

// Evitar crear múltiples instancias en dev con ts-node-dev
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"], // podés agregar "query" si querés ver las queries
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
