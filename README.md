# Cancha · Backend

API REST del MVP: NestJS + Mongoose + MongoDB. Monolito modular con autenticación JWT y
autorización por propiedad del torneo.

```
PUBLIC READ  +  AUTHENTICATED WRITE  +  TOURNAMENT OWNERSHIP
```

## Requisitos

- Node.js 20.19+ / 22.12+ y npm
- MongoDB del `docker-compose.yml` de la raíz (`docker compose up -d`). **No** hace falta instalar MongoDB.

## Uso

```bash
cp .env.example .env
# genera dos secretos distintos y pégalos en JWT_ACCESS_SECRET / JWT_REFRESH_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npm install
npm run seed         # datos demo + organizador demo (idempotente)
npm run start:dev    # http://localhost:3000/api
```

| Script               | Qué hace                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `npm run start:dev`  | API en modo watch                                                         |
| `npm run build`      | Compila a `dist/`                                                         |
| `npm run start:prod` | Ejecuta `dist/main.js`                                                    |
| `npm run seed`       | Borra y recrea la base de desarrollo con la demo                          |
| `npm run test`       | Tests unitarios + integración (MongoDB en memoria, no usa Docker)         |
| `npm run test:unit`  | Solo unitarios (cálculos de tabla/goleadores)                             |
| `npm run test:e2e`   | Solo integración HTTP (aceptación, autenticación, autorización, rate limit) |
| `npm run lint`       | oxlint                                                                    |

- API: `http://localhost:3000/api`
- Swagger: `http://localhost:3000/api/docs` (botón **Authorize** → pega el `accessToken` de `/auth/login`).
  JSON en `/api/docs-json`. Deshabilitado con `NODE_ENV=production`.
- Health: `GET /api/health` → `{ "status": "ok", "database": "up" }` (503 si MongoDB no responde)

### Usuario demo (SOLO DESARROLLO)

`npm run seed` crea dos organizadores con contraseña `Demo12345`:
**`demo@cancha.local`** (organizador A: ligas de Mazatlán, custodio de sus equipos y jugadores) y
**`organizador2@cancha.local`** (organizador B: Liga Cancún 2027), para probar la propiedad entre
dos usuarios reales. Credenciales públicas: nunca uses el seed en producción (el
script se niega con `NODE_ENV=production` o contra un host no local).

### Variables de entorno

| Variable                      | Ejemplo                                                        | Uso                                                            |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `PORT`                        | `3000`                                                         | Puerto HTTP                                                    |
| `MONGODB_URI`                 | `mongodb://localhost:27017/football_app?directConnection=true` | Conexión (replica set `rs0` del compose)                       |
| `FRONTEND_URL`                | `http://localhost:5173`                                        | Origen(es) CORS con credenciales, separados por coma. Nunca `*` |
| `NODE_ENV`                    | `development`                                                  | `development` / `production` / `test`                          |
| `JWT_ACCESS_SECRET`           | *(aleatorio)*                                                  | Firma del access token                                         |
| `JWT_ACCESS_EXPIRES_IN`       | `15m`                                                          | Vida del access token                                          |
| `JWT_REFRESH_SECRET`          | *(aleatorio, distinto)*                                        | Firma del refresh token                                        |
| `JWT_REFRESH_EXPIRES_IN`      | `7d`                                                           | Vida del refresh token / sesión (se renueva al rotar)          |
| `AUTH_THROTTLE_LIMIT`         | `10`                                                           | Intentos de login/registro por IP y ventana                    |
| `AUTH_REFRESH_THROTTLE_LIMIT` | `60`                                                           | Refrescos por IP y ventana                                     |
| `AUTH_THROTTLE_TTL`           | `60`                                                           | Ventana del rate limit (segundos)                              |

Se validan al arrancar. Siempre: secretos JWT obligatorios y distintos entre sí. En producción,
además: ≥ 32 caracteres y sin `change-me`, o el proceso no arranca.

## Arquitectura

```
src/
  main.ts / setup.ts        bootstrap; setup.ts (prefijo, cookies, CORS, pipes, Swagger) lo comparten los tests
  app.module.ts             Config + Mongoose + módulos + JwtAuthGuard global
  config/                   validación de variables de entorno
  common/
    authorization/          OwnershipService: políticas de escritura reutilizables
    …                       enums, paginación, validadores, filtro de errores Mongo, utilidades
  modules/
    auth/                   register/login/refresh/logout, JwtStrategy, guard, @Public, @CurrentUser, AuthSession
    users/                  User + UsersService (Argon2id)
    tournaments/            torneos + inscripciones (TournamentTeam)
    teams/                  equipos
    players/                jugadores + membresías (TeamMembership)
    matches/                partidos + captura de resultado (PlayerMatchStats)
    statistics/             tabla, goleadores, estadísticas del jugador (derivadas)
    health/
  seed/                     generador demo + script de carga
test/                       integración HTTP contra MongoDB en memoria
```

- **Controller**: HTTP, DTOs, status codes. **Service**: reglas de negocio. **Mongoose**: persistencia.
- Cada módulo registra (`forFeature`) los modelos que necesita leer, en lugar de importar services
  de otros módulos: evita dependencias circulares.
- Proyecto ESM generado por Nest CLI 12 (Vitest + oxlint como herramientas estándar).

## Autenticación

### User ≠ Player

- **User** es una cuenta que inicia sesión (hoy, siempre un organizador).
- **Player** es una identidad deportiva. Existe aunque la persona nunca cree una cuenta: el
  organizador registra jugadores, y sus partidos construyen su historial.

Mezclarlos obligaría a que cada jugador tuviera cuenta para existir, o a que una cuenta
"poseyera" un historial que pertenece a los torneos. En el futuro un User podrá **reclamar** un
Player (User → Player); no está implementado.

### Flujo

```
POST /auth/register | /auth/login
   → body:   { user, accessToken, expiresIn }        access token (15 min) → memoria del frontend
   → cookie: cancha_rt=<refresh token>               HttpOnly; SameSite=Lax; Path=/api/auth; Secure en prod

Peticiones protegidas → Authorization: Bearer <accessToken>

Access token caduca → 401 → POST /auth/refresh (la cookie viaja sola)
   → nuevo access token + NUEVO refresh token (rotación); el anterior deja de servir

Recarga de página (F5) → el access token en memoria se pierde → POST /auth/refresh → GET /auth/me

POST /auth/logout      → revoca la sesión de la cookie y la borra
POST /auth/logout-all  → revoca todas las sesiones del usuario (Bearer)
```

| Endpoint                 | Auth           | Respuesta                                             |
| ------------------------ | -------------- | ----------------------------------------------------- |
| `POST /auth/register`    | público        | 201 `{ user, accessToken, expiresIn }` + cookie · 409 email existente |
| `POST /auth/login`       | público        | 200 igual · 401 `Invalid credentials` (mismo mensaje si falla email o contraseña) |
| `POST /auth/refresh`     | cookie         | 200 igual (rotado) · 401 sin cookie / inválida / rotada / revocada |
| `POST /auth/logout`      | cookie         | 204 (idempotente)                                     |
| `POST /auth/logout-all`  | Bearer         | 204                                                   |
| `GET /auth/me`           | Bearer         | `{ id, email, firstName, lastName, role, createdAt }` |

### Decisiones

- **Contraseñas**: Argon2id (parámetros por defecto de la librería, alineados con OWASP). Mínimo 8
  caracteres, máximo 128, sin reglas de composición. `passwordHash` es `select: false` y ninguna
  respuesta lo incluye (verificado en tests). Si el email no existe también se ejecuta una
  verificación Argon2 contra un hash ficticio, para no revelar por tiempo qué emails existen.
- **Email**: `trim` + minúsculas + índice único.
- **Access token**: JWT HS256 con solo `sub` (userId) y `role`. No se consulta la base en cada
  petición: tras un logout sigue siendo válido hasta que caduca (≤ 15 min).
- **Refresh token**: JWT HS256 con `sub`, `sid` (id de sesión) y un `jti` aleatorio, firmado con
  otro secreto. En MongoDB (`auth_sessions`) solo se guarda su **SHA-256** (el token es aleatorio y
  de alta entropía, así que no necesita un hash lento). Las sesiones caducadas las borra un índice TTL.
- **Rotación y robo**: cada refresh sustituye el hash de la sesión (actualización condicional, así
  que dos refresh simultáneos no pueden ganar ambos). Si reaparece un token ya rotado:
  - dentro de 30 s → 401 sin más (típico de dos pestañas refrescando a la vez);
  - después → se asume robo y **se revoca la sesión** completa.
- **Por qué cookie HttpOnly + token en memoria**: el refresh token (el secreto de larga vida) no es
  accesible desde JS, así que un XSS no puede robarlo; el access token dura 15 min y no se persiste.
  Nada de tokens en `localStorage`.
- **CSRF**: la cookie solo viaja a `/api/auth/*` y con `SameSite=Lax`, por lo que otro sitio no
  puede provocar un `POST` con ella; además CORS solo acepta `FRONTEND_URL` con credenciales, y los
  endpoints de datos exigen el header `Authorization`, que un formulario ajeno no puede enviar.
  Requisito de despliegue: frontend y API en el **mismo sitio** (p. ej. `app.cancha.mx` y
  `api.cancha.mx`); si estuvieran en dominios distintos habría que usar `SameSite=None; Secure`
  y añadir protección CSRF explícita.
- **Rate limit** (`@nestjs/throttler`, en memoria, por IP): login/registro 10/min y refresh 60/min
  (cada carga de página hace un refresh, así que un límite bajo expulsaría a usuarios legítimos).
  Con varias instancias del API haría falta un storage compartido (p. ej. Redis) y, detrás de un
  proxy, configurar `trust proxy` para que la IP sea la del cliente.

## Autorización: rutas públicas y protegidas

Un `JwtAuthGuard` **global** exige JWT en todas las rutas; las de lectura se marcan con `@Public()`.
Si alguien olvida el decorador, la ruta queda protegida, no abierta.

**Públicas (sin cuenta)** — toda la lectura del producto:
`GET /tournaments[/:id]`, `/tournaments/:id/{standings,top-scorers,matches,teams}`, `/tournament-teams`,
`/teams[/:id]`, `/teams/:id/{profile,matches,roster,memberships}`, `/players[/:id]`, `/players/:id/{profile,stats,matches,memberships}`,
`/memberships`, `/matches[/:id]`, `/matches/:id/stats`, `/player-match-stats`, `/health`.

**Datos personales en respuestas públicas (política V1: minimizar; puede haber menores).** Todo
jugador que sale por una ruta pública pasa por `publicPlayer()` (`common/utils/public.ts`, lista
blanca): nombre, posición, foto y **edad derivada**; nunca `birthDate`, contacto, cuenta ni
custodio. La fecha exacta solo la recibe el custodio de la ficha: `GET /admin/players` (en filas con
`canEdit`) y las respuestas de `POST`/`PATCH /players`. Probado en `player-profile.e2e-spec.ts`.

**Perfil del jugador.** `GET /players/:id/profile` es el agregado público (fuente de verdad) de la
página del jugador: carrera, participaciones actuales (plural: activas en torneos no finalizados),
competiciones (torneo → equipos), historial por año, forma y 5 partidos recientes; solo partidos
FINISHED. 5 consultas indexadas, independientes del tamaño del historial. Contrato y decisiones en
`docs/player-profile-v1-backend-gaps.md`. `GET /players/:id/matches?page&limit` pagina en la base.

**Perfil del equipo.** `GET /teams/:id/profile` es el agregado público del equipo: balance histórico
(solo FINISHED, como local o visitante), participaciones actuales, competiciones, plantillas SIEMPRE
por torneo (no existe plantilla global), goleadores con este equipo (nunca goles de carrera), partidos
recientes y próximos, historial por año y `honors` verificables (campeón de liga solo con tabla final
completa y sin empate). 10 consultas indexadas fijas. `GET /teams/:id` agrupa sus plantillas actuales
por torneo (`currentRosters`). Contrato y decisiones en `docs/team-profile-v1-backend-gaps.md`.

**Protegidas (Bearer)** — todo `POST`/`PATCH`/`PUT`/`DELETE`, más:
`GET /admin/tournaments` (mis torneos), `GET /admin/teams`, `GET /admin/players` (los que participan en mis torneos + fichas que registré, con `canEdit`),
`GET /auth/me`, `POST /auth/logout-all`.

### Ownership

Tener un JWT válido **no** permite modificar cualquier cosa. Las reglas viven en un único
`OwnershipService` (`common/authorization`) que los services llaman antes de escribir; devuelve el
recurso o lanza 404/403/409, así que no hay `if (organizerId !== user.id)` repartidos por controllers.

| Recurso / acción                                              | Quién puede                                            |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Crear torneo                                                  | Cualquier organizador; `organizerId` = usuario del JWT |
| Editar datos y configuración / borrar torneo                  | Su organizador (el estado NO se cambia por PATCH)      |
| Iniciar (`POST /start`) y finalizar (`POST /finish`) torneo   | Su organizador                                         |
| Crear / renombrar / borrar jornadas, generar calendario        | El organizador del torneo                              |
| Inscribir / dar de baja equipos en un torneo                  | El organizador del torneo (cualquier equipo existente) |
| Crear / editar / borrar / mover partido                       | El organizador del torneo (`Match → Tournament → organizerId`); moverlo exige serlo también del destino |
| Capturar o corregir resultado y estadísticas                  | El organizador del torneo del partido                  |
| Crear equipo / jugador                                        | Cualquier organizador; queda como `createdBy` (auditoría) |
| Editar ficha global del equipo                                | OWNER (todo) · MANAGER (logo, colores, ciudad) · custodio `createdBy` solo si el equipo no tiene OWNER |
| Borrar equipo (solo sin historia)                             | OWNER · custodio sin OWNER                             |
| Ver administradores / agregar o quitar MANAGER                | OWNER y MANAGER ven · solo OWNER administra (`/teams/:id/admins`, `/managers`) |
| Plantilla GLOBAL del equipo (alta / baja / historial)         | OWNER o MANAGER (nunca `createdBy` ni el organizador). Ver `../docs/global-team-roster-v1.md` |
| Asignar el primer OWNER                                       | Solo mecanismo interno: `npm run team:assign-owner` (sin endpoint) |
| Editar / borrar ficha de jugador                              | Quien la registró (`createdBy`), hasta Player claim   |
| Registrar / mover / dar de baja a un jugador en un torneo (`PUT`/`DELETE /tournaments/:id/players/:playerId`) | El organizador de ESE torneo (cualquier jugador existente) |

- Organizar un torneo no da ningún permiso sobre la identidad global de sus equipos, ni ser OWNER
  de un equipo da permisos sobre torneos ajenos. Detalle: `../docs/team-ownership-v1.md`.
- `organizerId` nunca se acepta del cliente: el DTO no lo declara y `forbidNonWhitelisted` responde
  400 si alguien lo envía. Conocer un ObjectId ajeno no sirve de nada: 403.
- Recurso inexistente → 404; existente pero ajeno → 403; torneo finalizado → 409; actividad
  deportiva en un torneo sin iniciar → 409.

### Ciclo de vida del torneo e inmutabilidad

`DRAFT → ACTIVE → FINISHED`. Un torneo se crea en `DRAFT` (o `ACTIVE`); después el estado solo
cambia con acciones explícitas y condicionadas al estado actual (`findOneAndUpdate` por estado,
sin carreras):

- `POST /tournaments/:id/start`: `DRAFT → ACTIVE` (409 en cualquier otro estado).
- `POST /tournaments/:id/finish` `{ allowPendingMatches?: boolean }`: `ACTIVE → FINISHED`. Si
  quedan partidos `SCHEDULED`/`LIVE`/`POSTPONED` y no se confirma, 409 con el recuento
  (`summary`). Devuelve `{ tournament, summary }`. No borra ni modifica nada.
- `FINISHED` es terminal en Alpha 0.1: no se reabre.

**DRAFT = preparación, no competición.** En `DRAFT` se configura el torneo (datos, puntuación),
se inscriben/retiran equipos, se arman plantillas, se crean jornadas, se genera el calendario y se
programan/reprograman partidos (incluido posponer o cancelar). Lo que implica que un partido se
jugó exige `ACTIVE` y responde **409** en `DRAFT`: capturar resultado (`PUT /matches/:id/result`,
único camino a `PlayerMatchStats`), poner un partido `LIVE` (al crearlo o por `PATCH`),
`PATCH { status: FINISHED }`, o mover a un torneo sin iniciar un partido en juego. Un partido con
marcador o estadísticas no cambia de torneo ni de equipos. Lo aplica el backend
(`assertStarted`, dentro de la transacción de la escritura); la UI solo lo refleja. Probado con
peticiones directas en `hardening.e2e-spec.ts`.

**Concurrencia: cerrojo lógico por torneo.** Las reglas que leen antes de escribir (equipo
repetido en jornada, pendientes al finalizar, calendario sin historia, jornada vacía al borrarla,
equipo sin partidos al retirarlo…) se ejecutan dentro de `OwnershipService.inTournament()`: una
transacción cuyo primer paso incrementa `Tournament.writeSeq` con la condición "no finalizado".
Dos escrituras del mismo torneo no pueden confirmarse a la vez: la segunda recibe un
`WriteConflict` y el driver la reintenta (con backoff) ya viendo lo que hizo la primera. `finish`
cuenta los pendientes y cambia el estado en esa misma transacción, así que ninguna escritura
deportiva puede entrar entre la comprobación y el `FINISHED`. Coste: las escrituras de UN torneo
se serializan (irrelevante con un organizador por torneo); torneos distintos no se bloquean.
Los tests de `hardening.e2e-spec.ts` fuerzan el intercalado y fallan si se quita el cerrojo.

**Torneo finalizado = historial inmutable.** `OwnershipService.tournament()` y `.match()` son la
puerta de TODAS las escrituras deportivas y responden **409** si el torneo está finalizado:
datos/configuración/borrado del torneo, inscripciones, plantillas (alta, dorsal, cambio de equipo,
baja), jornadas, calendario, partidos (crear, editar, estado, borrar), resultados y
`PlayerMatchStats`. Además, borrar la ficha de un jugador o equipo que forma parte de un torneo
finalizado → 409. Las lecturas públicas no cambian. Probado con peticiones directas en
`torneo-real.e2e-spec.ts`.

**Team y Player son identidades globales.** `createdBy` es solo *quién creó la ficha*, no su dueño
deportivo: sirve para auditoría y para decidir quién edita los datos maestros (nombre, fecha de
nacimiento, posición, foto/escudo) hasta que existan claim/moderación. No decide dónde puede jugar:
- Cualquier organizador puede inscribir un equipo existente en **su** torneo y capturar a sus
  jugadores en **sus** partidos. Esas estadísticas pertenecen a su torneo y se suman al historial
  global del jugador (probado en `authorization.e2e-spec.ts`).
- Nadie puede alterar la historia de torneos ajenos: resultados y `PlayerMatchStats` solo se
  escriben a través de partidos, y los partidos solo los toca el organizador de su torneo.
- La participación Player ↔ Team (`TeamMembership`) vive **dentro de un torneo** (`tournamentId`) y
  la administra su organizador. Un jugador puede estar activo a la vez en varios torneos, con equipos
  y organizadores distintos (fútbol amateur real); dentro de un torneo, con un solo equipo. Registrarlo
  en tu torneo nunca cierra ni modifica sus participaciones en torneos ajenos.
- Borrar una ficha que ya participa en torneos de otro organizador → 409 (destruiría su historia).
- Probado en `shared-identity.e2e-spec.ts` y `authorization.e2e-spec.ts`.

| Concepto                          | Dónde vive                                         |
| --------------------------------- | -------------------------------------------------- |
| Quién inició sesión               | `User` (JWT)                                       |
| Quién administra el torneo        | `Tournament.organizerId`                           |
| Quién creó la ficha               | `Team.createdBy` / `Player.createdBy`              |
| Dónde participa un equipo         | `TournamentTeam` (torneo ↔ equipo)                 |
| Dónde juega un jugador            | `TeamMembership` (jugador ↔ equipo ↔ torneo)       |
| Qué hizo en un partido            | `PlayerMatchStats` (→ `Match` → `Tournament`)      |

No hay staff por torneo: `organizerId` es el único administrador.

## Modelo de dominio

```
User ─(organizerId)─< Tournament ─< TournamentTeam >─ Team
                      Tournament ─< TeamMembership >─ Team, Player   (participación en ESE torneo)
                      Tournament ─< Round (number) ┄┄ Match.round   (jornada: organización deportiva)
                      Tournament ─< Match ─< PlayerMatchStats >─ Player
User ─(createdBy)─ ─ ─ Team / Player        (custodio de la ficha, no propietario de su historia)
User ─< AuthSession                          (refresh token hasheado, rotación, revocación)
```

| Colección            | Campos clave                                                                                   | Índices                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `users`              | email, passwordHash (oculto), firstName, lastName, role                                        | **único** email                                                                                      |
| `auth_sessions`      | userId, refreshTokenHash, previousTokenHash, rotatedAt, expiresAt, revokedAt, userAgent        | userId+revokedAt; **TTL** expiresAt                                                                  |
| `tournaments`        | name, format, category, startDate, endDate?, status, venue?, settings, **organizerId**         | status+startDate; organizerId+startDate                                                              |
| `rounds`             | tournamentId, number (1–99), name?, date? (referencia)                                         | **único** tournamentId+number                                                                        |
| `tournament_teams`   | tournamentId, teamId, createdAt                                                                | **único** tournamentId+teamId; teamId                                                                |
| `teams`              | name, shortName, logoUrl?, colors, city?, createdBy                                            | name; createdBy+name                                                                                 |
| `players`            | firstName, lastName, birthDate?, position, photoUrl?, createdBy                                | searchName; lastName+firstName; createdBy+lastName                                                   |
| `team_memberships`   | playerId, teamId, tournamentId, jerseyNumber?, startDate, endDate?, active                     | **único** tournamentId+playerId (si active); **único** tournamentId+teamId+jerseyNumber (si active); playerId+startDate; teamId+active |
| `matches`            | tournamentId, round, homeTeamId, awayTeamId, date, time, venue?, status, homeScore, awayScore  | tournamentId+date+time; status+date; homeTeamId+date; awayTeamId+date                                |
| `player_match_stats` | matchId, playerId, teamId, played, goals, assists, yellowCards, redCards                        | **único** matchId+playerId; playerId; teamId                                                         |

Enums: `ORGANIZER` (rol), `GOALKEEPER | DEFENDER | MIDFIELDER | FORWARD`, `FOOTBALL_7 | FOOTBALL_11`,
`DRAFT | ACTIVE | FINISHED`, `SCHEDULED | LIVE | FINISHED | POSTPONED | CANCELLED`, `LEAGUE` (sistema).

`Tournament.settings = { system: 'LEAGUE', pointsForWin, pointsForDraw, pointsForLoss }` (enteros
0–10, victoria > empate ≥ derrota; por defecto 3/1/0). Los torneos anteriores sin `settings` se
leen como 3/1/0.

**Jornadas.** `Round` se identifica por `(tournamentId, number)` y `Match.round` guarda ese número:
es la referencia a la jornada, no una segunda fuente de verdad (el número no se renumera y el
backend crea el registro al programar, mover o generar partidos). Así los datos existentes siguen
siendo válidos sin migrar `Match`. Una jornada solo se borra vacía (nunca arrastra partidos).

**Reglas de partido.** Local ≠ visitante; ambos inscritos; **un equipo no juega dos partidos
vigentes (no cancelados) en la misma jornada** (409). Estados por PATCH: sin resultado
`SCHEDULED ↔ POSTPONED` (reprogramar con nueva fecha/hora, mismo partido), `→ LIVE`,
`→ CANCELLED` y vuelta a `SCHEDULED`; `FINISHED` solo con `PUT /result` (también desde
`POSTPONED`); un partido con marcador o estadísticas no pasa a `SCHEDULED`/`POSTPONED`/`CANCELLED`
(409). Solo `FINISHED` cuenta en la tabla.

## Endpoints de datos

Listados paginados → `{ data: [...], meta: { page, limit, total, totalPages } }`
(`page` = 1 y `limit` = 20 por defecto, máximo 100). Los ids son strings (`id`, sin `_id`).

```
GET    /tournaments?status=           GET /admin/tournaments          GET /tournaments/:id
POST   /tournaments                   PATCH /tournaments/:id          DELETE /tournaments/:id
POST   /tournaments/:id/start         POST /tournaments/:id/finish { allowPendingMatches? }
GET    /tournaments/:id/summary       (recuento de partidos por estado)
GET    /tournaments/:id/standings     GET /tournaments/:id/top-scorers?limit=
GET    /tournaments/:id/structure     (público: fases, grupos, cuadro, siguiente fase, campeón)
POST   /tournaments/:id/phases/advance { startDate, daysBetweenRounds?, firstKickoff?,
                                        minutesBetweenMatches?, venue?, tiebreaks?: [{ scope, order }] }
GET    /tournaments/:id/matches       GET /tournaments/:id/teams
POST   /tournaments/:tournamentId/teams/:teamId      DELETE (misma ruta)
GET    /tournament-teams?tournamentId=&teamId=

GET    /teams?search=&tournamentId=   GET /admin/teams                GET /teams/:id (ficha + roster + torneos + partidos)
POST   /teams                         PATCH /teams/:id                DELETE /teams/:id
GET    /teams/:id/roster              GET /teams/:id/memberships
GET    /teams/:id/admins              (OWNER/MANAGER)  POST /teams/:id/managers { userId | email }  (OWNER)
DELETE /teams/:id/managers/:userId    (OWNER, baja lógica)
GET    /teams/:id/global-roster?status=active|inactive|all   (OWNER/MANAGER; plantilla GLOBAL, no la de torneos)
POST   /teams/:id/global-roster { playerId }   DELETE /teams/:id/global-roster/:playerId   (OWNER/MANAGER)

GET    /players?search=&teamId=       GET /admin/players              GET /players/:id (+ membresía actual e historial)
POST   /players                       PATCH /players/:id              DELETE /players/:id
GET    /players/:id/stats             GET /players/:id/matches        GET /players/:id/memberships
GET    /tournaments/:id/players?teamId=            (participantes del torneo)
PUT    /tournaments/:id/players/:playerId          { teamId, jerseyNumber?, startDate? }   DELETE (misma ruta)
GET    /memberships?playerId=&teamId=&tournamentId=&active=

GET    /rounds?tournamentId=          GET /tournaments/:id/rounds
PUT    /tournaments/:id/rounds/:number             { name?, date? }  (crea o renombra, idempotente)
DELETE /tournaments/:id/rounds/:number             (solo jornadas vacías)
POST   /tournaments/:id/schedule      { startDate, legs?: 1|2, daysBetweenRounds?, firstKickoff?,
                                        minutesBetweenMatches?, venue?, replaceExisting?,
                                        seeding?: teamId[], groups?: teamId[][] }

GET    /matches?tournamentId=&teamId=&status=        GET /matches/:id (+ playerStats)
POST   /matches                       PATCH /matches/:id              DELETE /matches/:id
PUT    /matches/:id/result            GET /matches/:id/stats          GET /player-match-stats?…
```

Captura de resultado:

```json
PUT /api/matches/:id/result
{
  "homeScore": 3,
  "awayScore": 2,
  "status": "FINISHED",
  "penalties": null,
  "playerStats": [
    { "playerId": "…", "teamId": "…", "goals": 2, "assists": 0, "yellowCards": 1, "redCards": 0, "played": true }
  ]
}
```

Códigos: `200`, `201`, `204`, `400` validación o regla de negocio, `401` sin sesión/credenciales,
`403` recurso de otro organizador, `404`, `409` conflicto (duplicado, borrado que rompería historia,
dorsal ocupado), `429` rate limit, `503` health sin MongoDB.

## Otras decisiones

### Captura de resultado transaccional

`PUT /matches/:id/result` valida todo antes de escribir y luego, en **una transacción**, actualiza
marcador/estado, borra las estadísticas previas del partido e inserta las nuevas. Nunca queda un
partido con estadísticas a medias y una corrección no duplica registros. Por eso MongoDB corre como
replica set de un nodo (las transacciones no existen en un `mongod` standalone). El cambio de
equipo de un jugador también es transaccional.

Reglas: jugador una sola vez; `teamId` local o visitante; el jugador pertenece a ese equipo
(membresía activa o vigente en la fecha del partido); `played: false` ⇒ todo en cero;
**goles individuales de un equipo ≤ su marcador** (la diferencia son autogoles o goles sin autor).

### Estadísticas derivadas

Tabla, goleadores y totales del jugador no se persisten: se calculan con funciones puras
(`statistics/calculations.ts`) a partir de partidos `FINISHED` y participaciones `played: true`.
Puntos de `Tournament.settings` (3/1/0 por defecto); orden **puntos → diferencia de goles → goles
a favor**.

### Generación de calendario

`POST /tournaments/:id/schedule` genera la liga (método del círculo, `rounds/round-robin.ts`,
probado para 2–12 equipos): todos contra todos, cada pareja una vez por vuelta, nadie juega dos
veces por jornada, descanso con número impar, segunda vuelta con localías invertidas. Equipos en
orden por nombre (determinista). 409 si hay partidos jugados/en juego (nunca se regenera un
calendario con historia) o si hay partidos programados sin `replaceExisting: true`. Borrado del
calendario anterior + creación de jornadas y partidos en **una transacción** (replica set): un
fallo a mitad no deja nada a medias (probado inyectando un fallo). Al regenerar, las jornadas se
recrean (se pierden sus nombres).

### Formatos de competición

`settings.system`: `LEAGUE` (liga clásica, sin cambios respecto a V1), `KNOCKOUT`,
`GROUPS_KNOCKOUT` y `LEAGUE_PLAYOFFS`. Un formato es una secuencia de fases (liga, grupos,
eliminatoria) guardada en `Tournament.phases`; cada partido lleva `stage { phase, group, tie }` y,
en el partido que cierra una llave igualada, `penalties`. El cuadro se deriva de los partidos
(`competition/bracket.ts`), las rondas siguientes se crean al conocerse los ganadores y el campeón
sale siempre de la estructura real (final ganada, o liga completa con el primero sin empate).
Todas las escrituras usan el lock por torneo. Detalle: `../docs/competition-formats-v1.md`.

### Borrados

Sin soft delete; se rechaza con 409 lo que destruiría historia (jugador con partidos, equipo con
partidos o jugadores, torneo con partidos, partido con resultado — márcalo `CANCELLED`).

### Fechas

Fechas puras (`birthDate`, `startDate`, `endDate`, fecha del partido) son strings `YYYY-MM-DD`
validadas contra el calendario y **nunca se convierten a `Date`** (sin desfases de zona horaria).
La hora del partido es `HH:mm` local. `createdAt`/`updatedAt` son timestamps UTC.

### Validación y exposición de datos

`ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`): campos no declarados →
400 (mass assignment imposible: ni `organizerId`, ni `role`, ni `totalGoals`). `IsObjectIdPipe` en
todos los `:id`. Body JSON ≤ 100 kB. Errores de Mongo traducidos a 400/409 sin detalles internos; los
500 no exponen stack traces.

## Tests

- `calculations.spec.ts` — tabla, desempates, goleadores, totales.
- `acceptance.e2e-spec.ts` — flujo completo torneo → resultado → tabla/perfil, corrección, transferencia.
- `auth.e2e-spec.ts` — registro, email duplicado (409), login correcto/incorrecto (401 genérico),
  sin JWT / JWT falsificado (401), `/auth/me`, claims mínimos, access token expirado renovado con
  refresh, rotación (el anterior deja de valer), detección de reutilización, logout y logout-all
  invalidan el refresh, cookie `HttpOnly`/`SameSite=Lax`, `passwordHash` nunca en respuestas y
  guardado como Argon2id.
- `authorization.e2e-spec.ts` — organizadores A y B: cada uno edita lo suyo y recibe 403 en lo
  ajeno (torneo, inscripciones, partidos, mover partido, resultados, fichas de equipo/jugador,
  transferencias); `organizerId` del cliente rechazado; `/admin/tournaments` solo propios; 401 sin
  token en toda escritura; toda la lectura pública responde 200 sin cuenta; equipo global usado en
  torneo ajeno suma al historial del jugador.
- `throttle.e2e-spec.ts` — 429 tras exceder login y refresh, con límites independientes.
- `shared-identity.e2e-spec.ts` — Player/Team globales reutilizados entre organizadores.
- `round-robin.spec.ts` — algoritmo de liga exhaustivo (2–12 equipos, una y dos vueltas).
- `torneo-real.e2e-spec.ts` — ciclo de vida, finalizar con/sin pendientes, torneo FINISHED
  inmutable con peticiones directas (partidos, resultados, estadísticas, equipos, plantillas,
  jornadas, calendario, fichas), jornadas (equipo repetido, inscritos, 403), calendario (par/impar,
  una/dos vueltas, regeneración segura, atomicidad), POSTPONED/CANCELLED, puntuación 2/1/0 y
  desempates, regresión cross-organizer.

### Probar la autenticación a mano

```bash
A=http://localhost:3000/api
curl -c jar -X POST $A/auth/login -H 'content-type: application/json' \
     -d '{"email":"demo@cancha.local","password":"Demo12345"}'        # guarda la cookie en ./jar
TOKEN=...   # accessToken de la respuesta
curl $A/auth/me -H "Authorization: Bearer $TOKEN"
curl $A/admin/tournaments -H "Authorization: Bearer $TOKEN"
curl -b jar -c jar -X POST $A/auth/refresh                           # rota la cookie
curl -b jar -c jar -X POST $A/auth/logout                            # 204; el refresh anterior ya no sirve
```

## Limitaciones actuales

- Un solo rol (`ORGANIZER`) y un único administrador por torneo; sin staff/capturistas.
- Sin recuperación de contraseña, verificación de email, 2FA ni login social.
- Sin reclamo de perfiles, moderación ni fusión de fichas duplicadas (homónimos: cada Player es su propio ObjectId).
- Access token válido hasta su expiración tras un logout (15 min máx.).
- Rate limit en memoria: no se comparte entre instancias.
- La tabla del frontend (modo real) viene de `GET /standings`; pero el panel aún descarga
  colecciones completas (partidos, estadísticas, plantillas) y calcula goleadores y perfiles en
  cliente. Sin paginación/consultas por torneo hasta tener datos reales de uso.
- `FINISHED` congela todo, incluidos errores tipográficos (nombre, sede). Separar "metadata
  editable" de "historial deportivo inmutable" queda para después del piloto.
- Backend y frontend no están dockerizados (solo MongoDB).
- Formatos: sin mejores terceros, sin gol de visitante, sin partido por el tercer lugar, sin
  sorteo de grupos en la UI (reparto por orden alfabético o `groups` explícito por API). El modo
  mock del frontend solo simula la liga clásica.
