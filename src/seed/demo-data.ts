/**
 * Datos demo. Se generan de forma determinista (PRNG con semilla fija) para que
 * cada "restablecer" produzca exactamente el mismo universo, y para que los
 * resultados y las estadísticas individuales sean coherentes por construcción:
 * cada gol del marcador tiene un goleador del equipo correspondiente.
 */
/*
 * Copia del generador de mocks del frontend (front/src/mocks/seed.ts), para que la demo con
 * backend real muestre exactamente los mismos organizadores, equipos, jugadores y resultados.
 * Mantiene el mismo PRNG y el mismo orden de llamadas: no reordenar. Al cambiar el generador
 * del frontend, vuelve a copiarlo aquí.
 * Usa claves legibles ("team-halcones", "p-009", "u-organizer"); seed.ts las convierte en ObjectId.
 */
type ID = string
type ISODate = string
type PlayerPosition = 'GK' | 'DEF' | 'MID' | 'FWD'
type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled'
interface TournamentSettings { system: 'league'; points: { win: number; draw: number; loss: number } }
const defaultSettings = (): TournamentSettings => ({ system: 'league', points: { win: 3, draw: 1, loss: 0 } })
interface Ts { createdAt: string; updatedAt: string }
interface User { id: ID; firstName: string; lastName: string; email: string; role: 'ORGANIZER' }
interface Player extends Ts { id: ID; firstName: string; lastName: string; birthDate: ISODate | null; position: PlayerPosition; photoUrl: string | null; userId: ID | null; createdBy?: ID | null }
interface TeamMembership extends Ts { id: ID; playerId: ID; teamId: ID; tournamentId: ID; shirtNumber: number | null; startDate: ISODate; endDate: ISODate | null; status: 'active' | 'ended' }
interface Team extends Ts { id: ID; name: string; shortName: string; logoUrl: string | null; colors: { primary: string; secondary: string }; city: string | null; createdBy?: ID | null }
interface Tournament extends Ts { id: ID; name: string; modality: 'F7' | 'F11'; category: string; startDate: ISODate; endDate: ISODate | null; status: 'draft' | 'active' | 'finished'; venue: string | null; settings: TournamentSettings; organizerId?: ID }
interface TournamentTeam { id: ID; tournamentId: ID; teamId: ID; joinedAt: string }
interface Match extends Ts { id: ID; tournamentId: ID; round: number; homeTeamId: ID; awayTeamId: ID; date: ISODate; time: string; venue: string | null; status: MatchStatus; homeScore: number | null; awayScore: number | null }
interface PlayerMatchStats { id: ID; matchId: ID; playerId: ID; teamId: ID; goals: number; assists: number; yellowCards: number; redCards: number }

function parseISODate(value: ISODate): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}
function toISODate(date: Date): ISODate {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * Credenciales de la autenticación mock (VITE_USE_MOCKS=true). SOLO DEMO: se guardan en el
 * navegador en texto plano y separadas de User (un User nunca contiene su contraseña).
 * Con backend real las contraseñas viven únicamente en el servidor (hash Argon2id).
 */
export interface MockCredential {
  userId: ID
  email: string
  password: string
}

export interface MockDatabase {
  version: number
  users: User[]
  credentials: MockCredential[]
  players: Player[]
  teams: Team[]
  memberships: TeamMembership[]
  tournaments: Tournament[]
  tournamentTeams: TournamentTeam[]
  matches: Match[]
  playerMatchStats: PlayerMatchStats[]
}

export const SEED_VERSION = 3
const CREATED = '2026-10-01T12:00:00.000Z'
const ts = { createdAt: CREATED, updatedAt: CREATED }

// ─── PRNG ───────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Catálogo fijo ──────────────────────────────────────────────────────────

/** Organizador A: dueño de las ligas de Mazatlán. */
export const MOCK_ORGANIZER_A = 'u-organizer'
/** Organizador B: dueño de la liga de Cancún. */
export const MOCK_ORGANIZER_B = 'u-organizer-2'
const ORGANIZER_ID = MOCK_ORGANIZER_A

/** Usuarios demo documentados en el README (solo desarrollo). */
export const DEMO_PASSWORD = 'Demo12345'

const TEAM_DEFS: { id: ID; name: string; shortName: string; colors: [string, string]; strength: number }[] = [
  { id: 'team-halcones', name: 'Halcones FC', shortName: 'HAL', colors: ['#0f766e', '#facc15'], strength: 1.35 },
  { id: 'team-tigres', name: 'Tigres FC', shortName: 'TIG', colors: ['#ea580c', '#1f2937'], strength: 1.25 },
  { id: 'team-real', name: 'Real Mazatlán', shortName: 'RMZ', colors: ['#1d4ed8', '#f8fafc'], strength: 1.1 },
  { id: 'team-atlas', name: 'Atlas FC', shortName: 'ATL', colors: ['#b91c1c', '#111827'], strength: 1.0 },
  { id: 'team-olas', name: 'Deportivo Olas', shortName: 'OLA', colors: ['#0284c7', '#e0f2fe'], strength: 0.85 },
  { id: 'team-venados', name: 'Venados del Puerto', shortName: 'VEN', colors: ['#7c2d12', '#fbbf24'], strength: 0.8 },
]

/** Plantilla tipo Fútbol 7: posición + dorsal. */
const ROSTER_TEMPLATE: { position: PlayerPosition; number: number }[] = [
  { position: 'GK', number: 1 },
  { position: 'GK', number: 12 },
  { position: 'DEF', number: 2 },
  { position: 'DEF', number: 4 },
  { position: 'DEF', number: 5 },
  { position: 'MID', number: 6 },
  { position: 'MID', number: 8 },
  { position: 'MID', number: 10 },
  { position: 'FWD', number: 9 },
  { position: 'FWD', number: 11 },
]

const FIRST_NAMES = [
  'Luis', 'Carlos', 'Jorge', 'Miguel', 'José', 'Juan', 'Alejandro', 'Diego', 'Fernando', 'Ricardo',
  'Eduardo', 'Andrés', 'Sergio', 'Iván', 'Héctor', 'Raúl', 'Emilio', 'Óscar', 'Daniel', 'Rodrigo',
  'Mauricio', 'Adrián', 'Kevin', 'Brandon', 'Ángel', 'Julio', 'Mario', 'Tomás', 'Sebastián', 'Gael',
  'Santiago', 'Iker', 'Leonardo', 'Arturo', 'Rubén', 'Marco', 'Omar', 'Hugo', 'César', 'Ernesto',
]
const LAST_NAMES = [
  'García', 'Hernández', 'López', 'Martínez', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Flores',
  'Torres', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Reyes', 'Ortiz', 'Gutiérrez', 'Castillo',
  'Vargas', 'Romero', 'Mendoza', 'Ruiz', 'Álvarez', 'Chávez', 'Osuna', 'Lizárraga', 'Tirado', 'Beltrán',
  'Zamudio', 'Aguilar', 'Salazar', 'Medina', 'Rojas', 'Valdez', 'Ibarra', 'Quintero', 'Félix', 'Lerma',
]

/** Jugadores con identidad fija (para que la demo tenga protagonistas). */
const FEATURED: Record<string, { firstName: string; lastName: string; birthDate: ISODate; star: number }> = {
  'team-halcones:FWD:9': { firstName: 'Pablo', lastName: 'Hipólito', birthDate: '2001-04-18', star: 2.6 },
  'team-tigres:MID:10': { firstName: 'Carlos', lastName: 'Hernández', birthDate: '1998-09-02', star: 2.0 },
  'team-real:FWD:9': { firstName: 'Iker', lastName: 'Lizárraga', birthDate: '2004-01-27', star: 2.2 },
  'team-atlas:FWD:11': { firstName: 'Brandon', lastName: 'Osuna', birthDate: '2003-06-11', star: 1.8 },
}

const VENUES = ['Unidad Deportiva Benito Juárez · Cancha 1', 'Unidad Deportiva Benito Juárez · Cancha 2', 'Complejo Sábalo Country']
const MATCH_TIMES = ['18:00', '19:30', '21:00']

// ─── Generación ─────────────────────────────────────────────────────────────

export function createSeed(): MockDatabase {
  const rand = mulberry32(20270116)
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!
  const weighted = <T>(items: { item: T; weight: number }[]): T | undefined => {
    const total = items.reduce((s, i) => s + i.weight, 0)
    if (total <= 0) return undefined
    let r = rand() * total
    for (const i of items) {
      r -= i.weight
      if (r <= 0) return i.item
    }
    return items[items.length - 1]?.item
  }

  // Usuarios: dos organizadores. Ninguno es un Player (User ≠ Player).
  const users: User[] = [
    { id: MOCK_ORGANIZER_A, firstName: 'Laura', lastName: 'Méndez', email: 'demo@cancha.local', role: 'ORGANIZER' },
    { id: MOCK_ORGANIZER_B, firstName: 'Mariana', lastName: 'Ríos', email: 'organizador2@cancha.local', role: 'ORGANIZER' },
  ]
  const credentials: MockCredential[] = users.map((u) => ({ userId: u.id, email: u.email, password: DEMO_PASSWORD }))

  const teams: Team[] = TEAM_DEFS.map((t) => ({
    id: t.id,
    name: t.name,
    shortName: t.shortName,
    logoUrl: null,
    colors: { primary: t.colors[0], secondary: t.colors[1] },
    city: 'Mazatlán, Sin.',
    createdBy: ORGANIZER_ID,
    ...ts,
  }))

  // Jugadores + plantillas de club. Las participaciones (TeamMembership) se crean POR TORNEO.
  const players: Player[] = []
  const memberships: TeamMembership[] = []
  const squads = new Map<ID, { playerId: ID; number: number }[]>()
  const addToSquad = (teamId: ID, playerId: ID, number: number) =>
    squads.set(teamId, [...(squads.get(teamId) ?? []), { playerId, number }])
  /** Participación de un jugador con un equipo dentro de un torneo. */
  const register = (tournamentId: ID, teamId: ID, playerId: ID, number: number, startDate: ISODate) =>
    memberships.push({
      id: `tm-${tournamentId}-${playerId}`,
      playerId,
      teamId,
      tournamentId,
      shirtNumber: number,
      startDate,
      endDate: null,
      status: 'active',
      ...ts,
    })
  const registerSquads = (tournamentId: ID, teamIds: ID[], startDate: ISODate) => {
    for (const teamId of teamIds) {
      for (const { playerId, number } of squads.get(teamId) ?? []) register(tournamentId, teamId, playerId, number, startDate)
    }
  }
  const star = new Map<ID, number>()
  const usedNames = new Set<string>()
  let playerSeq = 0

  for (const team of TEAM_DEFS) {
    for (const slot of ROSTER_TEMPLATE) {
      playerSeq++
      const id = `p-${String(playerSeq).padStart(3, '0')}`
      const featured = FEATURED[`${team.id}:${slot.position}:${slot.number}`]
      let firstName = featured?.firstName ?? ''
      let lastName = featured?.lastName ?? ''
      if (!featured) {
        do {
          firstName = pick(FIRST_NAMES)
          lastName = `${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`
        } while (usedNames.has(`${firstName} ${lastName}`) || lastName.split(' ')[0] === lastName.split(' ')[1])
      }
      usedNames.add(`${firstName} ${lastName}`)

      const year = 1990 + Math.floor(rand() * 17)
      const month = 1 + Math.floor(rand() * 12)
      const day = 1 + Math.floor(rand() * 28)
      const randomBirth = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

      players.push({
        id,
        firstName,
        lastName,
        // Algunos jugadores no registraron su fecha de nacimiento.
        birthDate: featured?.birthDate ?? (rand() < 0.15 ? null : randomBirth),
        position: slot.position,
        photoUrl: null,
        userId: null,
        createdBy: ORGANIZER_ID,
        ...ts,
      })
      star.set(id, featured?.star ?? 0.7 + rand() * 0.8)
      addToSquad(team.id, id, slot.number)
    }
  }

  // Transferencia: Diego jugó la Copa Invierno con Tigres (#14) y el Apertura con Halcones (#7).
  // Es el MISMO Player en ambos torneos; cambia su participación, no su identidad.
  playerSeq++
  const transferId = `p-${String(playerSeq).padStart(3, '0')}`
  players.push({
    id: transferId,
    firstName: 'Diego',
    lastName: 'Ramírez Tirado',
    birthDate: '1999-11-30',
    position: 'MID',
    photoUrl: null,
    userId: null,
    createdBy: ORGANIZER_ID,
    ...ts,
  })
  star.set(transferId, 1.6)
  const rosterAt = (tournamentId: ID, teamId: ID): Player[] =>
    memberships
      .filter((m) => m.tournamentId === tournamentId && m.teamId === teamId && m.status === 'active')
      .map((m) => players.find((p) => p.id === m.playerId)!)

  // Torneos.
  const tournaments: Tournament[] = [
    {
      id: 't-apertura-2027',
      name: 'Liga Mazatlán Apertura 2027',
      modality: 'F7',
      category: 'Libre varonil',
      startDate: '2027-01-16',
      endDate: '2027-03-20',
      status: 'active',
      venue: 'Unidad Deportiva Benito Juárez',
      settings: defaultSettings(),
      organizerId: ORGANIZER_ID,
      ...ts,
    },
    {
      id: 't-copa-invierno-2026',
      name: 'Copa Puerto Invierno 2026',
      modality: 'F7',
      category: 'Libre varonil',
      startDate: '2026-11-07',
      endDate: '2026-11-21',
      status: 'finished',
      venue: 'Complejo Sábalo Country',
      settings: defaultSettings(),
      organizerId: ORGANIZER_ID,
      ...ts,
    },
    {
      id: 't-veteranos-2027',
      name: 'Liga Veteranos Fútbol 11 · Primavera 2027',
      modality: 'F11',
      category: 'Veteranos +35',
      startDate: '2027-04-10',
      endDate: null,
      status: 'draft',
      venue: null,
      settings: defaultSettings(),
      organizerId: ORGANIZER_ID,
      ...ts,
    },
  ]

  const tournamentTeams: TournamentTeam[] = []
  const enroll = (tournamentId: ID, teamIds: ID[]) =>
    teamIds.forEach((teamId) =>
      tournamentTeams.push({ id: `tt-${tournamentId}-${teamId}`, tournamentId, teamId, joinedAt: CREATED }),
    )
  enroll('t-apertura-2027', TEAM_DEFS.map((t) => t.id))
  enroll('t-copa-invierno-2026', TEAM_DEFS.slice(0, 4).map((t) => t.id))

  // Participaciones por torneo (mismo orden que antes: plantilla y después Diego).
  registerSquads('t-copa-invierno-2026', TEAM_DEFS.slice(0, 4).map((t) => t.id), '2026-11-07')
  register('t-copa-invierno-2026', 'team-tigres', transferId, 14, '2026-11-07')
  registerSquads('t-apertura-2027', TEAM_DEFS.map((t) => t.id), '2027-01-16')
  register('t-apertura-2027', 'team-halcones', transferId, 7, '2027-01-16')

  const matches: Match[] = []
  const playerMatchStats: PlayerMatchStats[] = []
  const strength = new Map(TEAM_DEFS.map((t) => [t.id, t.strength]))

  const goalsFor = (attack: number, defense: number): number => {
    // Distribución de Poisson aproximada.
    const lambda = 1.9 * (attack / defense)
    const L = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= rand()
    } while (p > L)
    return Math.min(k - 1, 7)
  }

  const SCORE_WEIGHT: Record<PlayerPosition, number> = { GK: 0, DEF: 0.6, MID: 2, FWD: 4 }
  const ASSIST_WEIGHT: Record<PlayerPosition, number> = { GK: 0.1, DEF: 1, MID: 3.5, FWD: 2 }

  const playTeam = (matchId: ID, tournamentId: ID, teamId: ID, goals: number) => {
    // Convocados: la plantilla menos 0–2 ausencias (nunca el portero titular).
    const roster = rosterAt(tournamentId, teamId)
    const absences = Math.floor(rand() * 3)
    const lineup = [...roster]
    for (let i = 0; i < absences; i++) {
      const candidates = lineup.filter((p, idx) => idx > 0 && p.position !== 'GK')
      const out = pick(candidates)
      lineup.splice(lineup.indexOf(out), 1)
    }

    const rows = new Map<ID, PlayerMatchStats>(
      lineup.map((p) => [
        p.id,
        { id: `pms-${matchId}-${p.id}`, matchId, playerId: p.id, teamId, goals: 0, assists: 0, yellowCards: 0, redCards: 0 },
      ]),
    )

    for (let g = 0; g < goals; g++) {
      const scorer = weighted(lineup.map((p) => ({ item: p, weight: SCORE_WEIGHT[p.position] * star.get(p.id)! })))!
      rows.get(scorer.id)!.goals++
      if (rand() < 0.7) {
        const assistant = weighted(
          lineup.filter((p) => p.id !== scorer.id).map((p) => ({ item: p, weight: ASSIST_WEIGHT[p.position] * star.get(p.id)! })),
        )
        if (assistant) rows.get(assistant.id)!.assists++
      }
    }

    for (const row of rows.values()) {
      if (rand() < 0.11) row.yellowCards = 1
      if (rand() < 0.015) row.redCards = 1
    }
    playerMatchStats.push(...rows.values())
  }

  /** Round robin (método del círculo). Devuelve pares por jornada. */
  const roundRobin = (teamIds: ID[]): [ID, ID][][] => {
    const ids = [...teamIds]
    const rounds: [ID, ID][][] = []
    for (let r = 0; r < ids.length - 1; r++) {
      const pairs: [ID, ID][] = []
      for (let i = 0; i < ids.length / 2; i++) {
        const a = ids[i]!
        const b = ids[ids.length - 1 - i]!
        pairs.push(r % 2 === 0 ? [a, b] : [b, a])
      }
      rounds.push(pairs)
      ids.splice(1, 0, ids.pop()!)
    }
    return rounds
  }

  let matchSeq = 0
  const addMatches = (
    tournamentId: ID,
    rounds: [ID, ID][][],
    firstDate: ISODate,
    statusFor: (round: number, index: number) => MatchStatus,
  ) => {
    rounds.forEach((pairs, r) => {
      const date = parseISODate(firstDate)
      date.setDate(date.getDate() + r * 7)
      const iso = toISODate(date)
      pairs.forEach(([home, away], i) => {
        matchSeq++
        const id = `m-${String(matchSeq).padStart(3, '0')}`
        const status = statusFor(r + 1, i)
        let homeScore: number | null = null
        let awayScore: number | null = null
        if (status === 'finished') {
          homeScore = goalsFor(strength.get(home)! * 1.08, strength.get(away)!)
          awayScore = goalsFor(strength.get(away)!, strength.get(home)!)
        } else if (status === 'live') {
          homeScore = 1
          awayScore = 1
        }
        matches.push({
          id,
          tournamentId,
          round: r + 1,
          homeTeamId: home,
          awayTeamId: away,
          date: iso,
          time: MATCH_TIMES[i % MATCH_TIMES.length]!,
          venue: VENUES[i % VENUES.length]!,
          status,
          homeScore,
          awayScore,
          ...ts,
        })
        if (homeScore !== null && awayScore !== null) {
          playTeam(id, tournamentId, home, homeScore)
          playTeam(id, tournamentId, away, awayScore)
        }
      })
    })
  }

  // Copa Invierno: 4 equipos, una vuelta, finalizada.
  addMatches('t-copa-invierno-2026', roundRobin(TEAM_DEFS.slice(0, 4).map((t) => t.id)), '2026-11-07', () => 'finished')

  // Apertura: 6 equipos, ida y vuelta (10 jornadas).
  // Jornadas 1–6 jugadas; jornada 7 con un partido en juego y otro pospuesto; resto por jugar.
  const firstLeg = roundRobin(TEAM_DEFS.map((t) => t.id))
  const secondLeg = firstLeg.map((pairs) => pairs.map(([h, a]) => [a, h] as [ID, ID]))
  addMatches('t-apertura-2027', [...firstLeg, ...secondLeg], '2027-01-16', (round, index) => {
    if (round <= 6) return 'finished'
    if (round === 7 && index === 0) return 'live'
    if (round === 7 && index === 2) return 'postponed'
    return 'scheduled'
  })

  // ─── Organizador B: Liga Cancún 2027 (4 equipos, una vuelta, 2 jornadas jugadas) ───
  // Se genera al final para no alterar los datos de A.
  const CANCUN_TEAMS: { id: ID; name: string; shortName: string; colors: [string, string]; strength: number }[] = [
    { id: 'team-jaguares', name: 'Jaguares Cancún', shortName: 'JAG', colors: ['#a16207', '#111827'], strength: 1.2 },
    { id: 'team-delfines', name: 'Delfines del Caribe', shortName: 'DEL', colors: ['#0891b2', '#f0f9ff'], strength: 1.05 },
    { id: 'team-mayas', name: 'Mayas FC', shortName: 'MAY', colors: ['#15803d', '#fef3c7'], strength: 0.95 },
    { id: 'team-arrecife', name: 'Arrecife United', shortName: 'ARR', colors: ['#7c3aed', '#fde68a'], strength: 0.9 },
  ]
  for (const t of CANCUN_TEAMS) {
    teams.push({
      id: t.id,
      name: t.name,
      shortName: t.shortName,
      logoUrl: null,
      colors: { primary: t.colors[0], secondary: t.colors[1] },
      city: 'Cancún, Q. Roo',
      createdBy: MOCK_ORGANIZER_B,
      ...ts,
    })
    strength.set(t.id, t.strength)
    for (const slot of ROSTER_TEMPLATE) {
      playerSeq++
      const id = `p-${String(playerSeq).padStart(3, '0')}`
      let firstName = ''
      let lastName = ''
      do {
        firstName = pick(FIRST_NAMES)
        lastName = `${pick(LAST_NAMES)} ${pick(LAST_NAMES)}`
      } while (usedNames.has(`${firstName} ${lastName}`) || lastName.split(' ')[0] === lastName.split(' ')[1])
      usedNames.add(`${firstName} ${lastName}`)
      const year = 1992 + Math.floor(rand() * 14)
      players.push({
        id,
        firstName,
        lastName,
        birthDate: `${year}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`,
        position: slot.position,
        photoUrl: null,
        userId: null,
        createdBy: MOCK_ORGANIZER_B,
        ...ts,
      })
      star.set(id, 0.7 + rand() * 0.8)
      addToSquad(t.id, id, slot.number)
    }
  }
  tournaments.push({
    id: 't-cancun-2027',
    name: 'Liga Cancún 2027',
    modality: 'F7',
    category: 'Libre mixto',
    startDate: '2027-02-06',
    endDate: '2027-02-20',
    status: 'active',
    venue: 'Unidad Deportiva Cancún',
    settings: defaultSettings(),
    organizerId: MOCK_ORGANIZER_B,
    ...ts,
  })
  enroll('t-cancun-2027', CANCUN_TEAMS.map((t) => t.id))
  registerSquads('t-cancun-2027', CANCUN_TEAMS.map((t) => t.id), '2027-02-06')
  // Perfil del Jugador: Pablo Hipólito juega A LA VEZ el Apertura (Halcones, organizador A) y la
  // Liga Cancún (Jaguares, organizador B). Mismo Player, dos participaciones activas simultáneas.
  const pablo = players.find((p) => p.firstName === 'Pablo' && p.lastName === 'Hipólito')!
  register('t-cancun-2027', 'team-jaguares', pablo.id, 23, '2027-02-06')
  addMatches('t-cancun-2027', roundRobin(CANCUN_TEAMS.map((t) => t.id)), '2027-02-06', (round) =>
    round <= 2 ? 'finished' : 'scheduled',
  )
  for (const m of matches) if (m.tournamentId === 't-cancun-2027') m.venue = 'Unidad Deportiva Cancún · Cancha 1'

  // Perfil del Jugador: fichaje reciente del Apertura, registrado después de las jornadas jugadas
  // (0 partidos) y con nombre largo para probar el diseño.
  playerSeq++
  const rookieId = `p-${String(playerSeq).padStart(3, '0')}`
  players.push({
    id: rookieId,
    firstName: 'José Francisco de Jesús',
    lastName: 'Hernández Montes de Oca',
    birthDate: '2007-09-02',
    position: 'DEF',
    photoUrl: null,
    userId: null,
    createdBy: ORGANIZER_ID,
    ...ts,
  })
  register('t-apertura-2027', 'team-venados', rookieId, 27, '2027-03-20')

  return {
    version: SEED_VERSION,
    users,
    credentials,
    players,
    teams,
    memberships,
    tournaments,
    tournamentTeams,
    matches,
    playerMatchStats,
  }
}

