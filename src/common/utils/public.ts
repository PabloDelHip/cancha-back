import type { Types } from 'mongoose';
import { ageOn } from './dates.js';

/**
 * Representaciones PÚBLICAS (sin sesión) de las entidades que se embeben en otras respuestas.
 * Listas blancas explícitas: un campo nuevo en el schema no se publica hasta añadirlo aquí.
 *
 * Política V1 de datos personales (Cancha puede tener menores): lo público se minimiza.
 * De la fecha de nacimiento solo sale la edad derivada; nunca contacto, cuenta ni custodio.
 * La fecha exacta solo la recibe el custodio de la ficha (`/admin/players`, create/update).
 */
interface PlayerLike<P extends string> {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  nickname?: string | null;
  birthDate?: string | null;
  position: P;
  photoUrl?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export function publicPlayer<P extends string>(p: PlayerLike<P>, today?: string) {
  return {
    id: p._id.toHexString(),
    firstName: p.firstName,
    lastName: p.lastName,
    nickname: p.nickname ?? null,
    position: p.position,
    photoUrl: p.photoUrl ?? null,
    age: ageOn(p.birthDate, today),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
export type PublicPlayer = ReturnType<typeof publicPlayer<string>>;

interface TeamLike {
  _id: Types.ObjectId;
  name: string;
  shortName: string;
  logoUrl?: string | null;
  colors: { primary: string; secondary: string };
}

/** Lo necesario para pintar y enlazar un equipo. */
export function teamRef(t: TeamLike) {
  return {
    id: t._id.toHexString(),
    name: t.name,
    shortName: t.shortName,
    logoUrl: t.logoUrl ?? null,
    colors: { primary: t.colors.primary, secondary: t.colors.secondary },
  };
}
export type TeamRef = ReturnType<typeof teamRef>;

interface TournamentLike {
  _id: Types.ObjectId;
  name: string;
  status: string;
  category: string;
  format: string;
  startDate: string;
  endDate: string | null;
  dataCoverage?: string | null;
}

/**
 * Lo necesario para pintar y enlazar un torneo (sin organizador ni configuración interna).
 * `dataCoverage` (6F): FULL salvo PARTIAL explícito; quien lo lea debe incluirlo en su `select`.
 */
export function tournamentRef(t: TournamentLike) {
  return {
    id: t._id.toHexString(),
    name: t.name,
    status: t.status,
    category: t.category,
    format: t.format,
    startDate: t.startDate,
    endDate: t.endDate ?? null,
    dataCoverage: (t.dataCoverage === 'PARTIAL' ? 'PARTIAL' : 'FULL') as 'FULL' | 'PARTIAL',
  };
}
/** En las entradas de las funciones puras de perfil, sin `dataCoverage` = FULL. */
export type TournamentRef = Omit<ReturnType<typeof tournamentRef>, 'dataCoverage'> & { dataCoverage?: 'FULL' | 'PARTIAL' };
