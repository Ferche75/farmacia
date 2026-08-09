# Notas para migrar a Supabase propio

Objetivo de este archivo: que armar/migrar el proyecto en tu Supabase no pierda nada de lo que ya se decidió o construyó, sea que el proyecto que uses ahora sea el definitivo o uno de prueba que después se reemplace.

## Estado actual

- Proyecto de Supabase: **conectado** (2026-08-06). Project ref `yrjxhwcreklmyzfazdfr`. URL y anon key viven en `apps/admin/.env.local` y `apps/conteo/.env.local` (gitignorados); la service_role key solo en `apps/admin/.env.local`, sin cablear a ningún código todavía. El conector MCP de Supabase de este entorno sigue sin autorizar — la conexión se hace vía las apps (Supabase Auth/REST) y, para migraciones, vía SQL Editor o el CLI con la contraseña de la DB.
- Auth confirmado funcionando: email+contraseña habilitado. **`mailer_autoconfirm: false`** — al crear usuarios de prueba en Supabase Studio, tildar "Auto Confirm User" o van a quedar sin poder loguearse hasta confirmar el mail.
- Migración de Fase 0 (`supabase/migrations/20260806000000_tenancy.sql`: empresas, sucursales, perfiles, perfiles_sucursal + RLS) escrita y lista — se aplica a mano desde el SQL Editor de Supabase Studio (decisión del usuario: no compartir la contraseña de la DB, así que no se aplicó vía CLI). Falta confirmar que se corrió.
- Código del monorepo (Fase 0: dos apps Next.js + `packages/db` + login) ya armado y verificado con `pnpm build`/`pnpm lint` en ambas apps.
- El esquema completo vive versionado como código en `spec-farmacias-completo.md` sección 4, y se corrige en `decisiones.md`. Las migraciones reales van a `/supabase/migrations` — esa carpeta es la fuente de verdad portable: se puede aplicar a cualquier proyecto Supabase nuevo sin perder nada, siempre que esté versionada en el repo (git; todavía no se hizo el primer commit).

## Checklist para cuando conectes tu proyecto de Supabase

**Antes de correr la primera migración:**
- [ ] Confirmar región del proyecto (afecta latencia desde Bolivia)
- [ ] Habilitar extensión `pg_trgm` (usada por el índice de búsqueda de nombre)
- [ ] Confirmar que `gen_random_uuid()` está disponible (por defecto en Postgres 13+ de Supabase; si no, habilitar `pgcrypto`)
- [ ] Guardar `SUPABASE_URL` y las keys (`anon`, `service_role`) en un `.env` que NO se commitea — anotar dónde queda guardado ese archivo fuera del repo (ej. gestor de contraseñas) para no perderlo si se reinstala el entorno

**Auth:**
- [ ] Configurar email + contraseña como método (según CONTEXTO.md)
- [ ] Revisar si se necesita confirmación de email obligatoria o no (afecta el alta de operarios)
- [ ] Definir expiración de sesión/JWT razonable para uso en celular todo el día

**Storage:**
- [ ] Crear el bucket para fotos de desconocidos
- [ ] Policies de bucket que respeten `empresa_id/conteo_id/` — sin esto, una empresa podría leer fotos de otra vía Storage aunque la tabla `desconocidos` tenga RLS
- [ ] Límite de tamaño de archivo acorde a la compresión de Fase 4 (1280px, calidad 0.8)

**RLS (auditar tabla por tabla antes de dar por cerrada la Fase 1):**
- [ ] Todas las tablas con `empresa_id` tienen policy activa (regla 7 de CONTEXTO.md)
- [ ] Las funciones `SECURITY DEFINER` (`buscar_producto`, `registrar_escaneos_batch`, `resumen_conteo`) tienen `SET search_path = ''` y filtran campos por rol en el propio código de la función, no solo confían en RLS
- [ ] Probado con dos empresas de prueba que ninguna ve datos de la otra (esto ya está en el checklist de Fase 7 del spec original, pero conviene repetirlo apenas se tenga el primer Supabase real, no solo al final)

**n8n / Gemini:**
- [ ] Guardar la API key de Gemini fuera del repo
- [ ] Definir un secreto compartido para el webhook de n8n → Supabase, para que no cualquiera pueda disparar el flujo de IA o inyectar respuestas falsas en `desconocidos`

## Si en algún momento se migra de un proyecto Supabase a otro (ej. de prueba → producción)

1. Las migraciones de `/supabase/migrations` se re-aplican tal cual sobre el proyecto nuevo (son la fuente de verdad del esquema).
2. Lo que NO viaja solo con las migraciones y hay que migrar a mano:
   - Datos ya cargados (catálogo, empresas, conteos históricos) → `pg_dump` / `pg_restore` o export CSV tabla por tabla
   - Archivos en Storage (fotos de desconocidos) → copiar bucket a bucket
   - Usuarios de Auth → no se pueden copiar contraseñas hasheadas entre proyectos sin exportación especial; probablemente haya que re-invitar usuarios o usar la función de migración de Auth de Supabase
   - Secrets y configuración de n8n (URLs de webhook cambian si cambia el proyecto)
3. Antes de cortar el proyecto viejo, correr el checklist de Fase 7 completo en el nuevo.
