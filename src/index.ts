// api/src/index.ts
import express from "express";
import cors from "cors";
import "dotenv/config";
import { examsRouter } from "./routes/exams";
import { questionsRouter } from "./routes/questions"; // 👈 nuevo

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api", examsRouter);
app.use("/api", questionsRouter); // 👈 monta las rutas de preguntas

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
});
