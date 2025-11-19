import { Router } from "express";
export const events = Router();

// Memoria simple de eventos por examen (en prod usar Redis/DB)
const roomEvents = new Map<string, Array<any>>(); // key: examId

export function publishEvent(examId: string, evt: any) {
  const arr = roomEvents.get(examId) ?? [];
  arr.push(evt);
  // conservar 1 minuto para no crecer infinito
  const cutoff = Date.now() - 60_000;
  roomEvents.set(
    examId,
    arr.filter((e) => e.ts >= cutoff)
  );
}

// Long-polling: el front pregunta por eventos nuevos desde 'since'
events.get("/:examId", async (req, res) => {
  const { examId } = req.params;
  const since = Number(req.query.since ?? 0);

  let tries = 0;
  while (tries < 25) {
    // ~12.5s total con sleeps de 500ms
    const arr = roomEvents.get(examId) ?? [];
    const out = arr.filter((e) => e.ts > since);
    if (out.length) return res.json({ events: out, now: Date.now() });
    await new Promise((r) => setTimeout(r, 500));
    tries++;
  }
  res.json({ events: [], now: Date.now() });
});
