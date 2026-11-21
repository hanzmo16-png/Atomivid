<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ATOMIVID — Política obligatoria de costos y despliegues (para todo agente)

Antes de cualquier tarea, lee y cumple [`docs/politicas/costos-y-despliegues.md`](docs/politicas/costos-y-despliegues.md). Rige desde el 2026-11-02 hasta nueva instrucción expresa del propietario (Hans). Resumen que no sustituye al documento:

- Prioridad: **calidad > seguridad > estabilidad > control de costos > velocidad**. Ahorrar nunca justifica quitar una protección, desactivar CI obligatoria ni saltarse pruebas.
- Presupuesto por defecto: **USD 0**. Sin autorización específica, para el PR o SHA concreto, no se hace nada de esto: APIs de IA pagadas, servicios o planes nuevos, pruebas con gasto, merge, despliegue a producción, secretos, migraciones, escrituras en Supabase de producción, ni borrar datos, objetos, episodios o registros de gasto. Una autorización anterior no es un permiso general.
- **Primero en local, después un solo push.** Revisa el código, encuentra la causa raíz, corrige del todo, prueba en local (gratis) y agrupa los cambios relacionados. Está prohibido empujar pequeños commits remotos hasta que la CI salga verde. Cada push a una rama con previews de Vercel es una compilación facturable.
- Vercel no sustituye a las pruebas locales: nada de previews de rutina ni de despliegues para comprobar cambios triviales. Como mucho, una preview final cuando haga falta validar algo visual.
- Nunca se desactiva la CI obligatoria. Tampoco se cambia la configuración productiva de Vercel sin autorización: los cambios de configuración se proponen en `docs/propuestas/`.
- Toda entrega técnica reporta: archivos, SHA exacto, pruebas y resultados, número de pushes y compilaciones, previews, despliegues y costo. El costo se separa en conocido y estimado, y se escribe «costo no verificado» cuando no hay factura que lo respalde.
