# ProctorEtic Backend - Reglas para Codex

## Cómo trabajar
- Primero: plan breve + endpoints/archivos que se tocarán.
- Después: aplicar cambios SOLO si se pidió explícitamente "aplicar".

## Restricciones (muy importante)
- NO refactorizar.
- NO cambiar Prisma schema ni migraciones salvo pedido explícito.
- NO cambiar contratos de endpoints existentes sin avisar.
- Cambios pequeños: máximo 3 archivos por tarea.

## Validación obligatoria
- Si hay tests: correrlos.
- Si no hay tests: asegurar que compila/levanta y que el endpoint responde.

## Entregables
- Diff mínimo.
- Cómo probar el endpoint (curl o pasos).
