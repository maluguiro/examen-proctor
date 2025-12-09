const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const exists = await prisma.exam.findFirst({ where: { publicCode: "MAT1" } });
  if (exists) {
    console.log("✅ Ya existe MAT1:", exists.id);
    return;
  }

  const base = {
    publicCode: "MAT1",
    title: "Examen de prueba",
    status: "open", // en DB está mapeado en minúscula
    lives: 3,
  };

  try {
    const created = await prisma.exam.create({ data: { ...base, durationMin: 60 } });
    console.log("✅ Creado con durationMin:", created.id);
  } catch {
    try {
      const created = await prisma.exam.create({ data: { ...base, durationMins: 60 } });
      console.log("✅ Creado con durationMins:", created.id);
    } catch {
      const created = await prisma.exam.create({ data: base });
      console.log("✅ Creado sin duración (no existe el campo de duración):", created.id);
    }
  }
}

main()
  .catch((e) => { console.error("❌ Error seed:", e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
