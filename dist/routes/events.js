"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.events = void 0;
exports.publishEvent = publishEvent;
const express_1 = require("express");
exports.events = (0, express_1.Router)();
// Memoria simple de eventos por examen (en prod usar Redis/DB)
const roomEvents = new Map(); // key: examId
function publishEvent(examId, evt) {
    const arr = roomEvents.get(examId) ?? [];
    arr.push(evt);
    // conservar 1 minuto para no crecer infinito
    const cutoff = Date.now() - 60000;
    roomEvents.set(examId, arr.filter((e) => e.ts >= cutoff));
}
// Long-polling: el front pregunta por eventos nuevos desde 'since'
exports.events.get("/:examId", async (req, res) => {
    const { examId } = req.params;
    const since = Number(req.query.since ?? 0);
    let tries = 0;
    while (tries < 25) {
        // ~12.5s total con sleeps de 500ms
        const arr = roomEvents.get(examId) ?? [];
        const out = arr.filter((e) => e.ts > since);
        if (out.length)
            return res.json({ events: out, now: Date.now() });
        await new Promise((r) => setTimeout(r, 500));
        tries++;
    }
    res.json({ events: [], now: Date.now() });
});
