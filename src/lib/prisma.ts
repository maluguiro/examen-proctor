import "dotenv/config"; // 👈 carga .env en runtime
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
