import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  CompetitionSystem,
  DataCoverage,
  KnockoutTiebreak,
  TournamentFormat,
  TournamentStatus,
} from '../../../common/enums/index.js';
import { DisciplineRules, DisciplineRulesSchema } from '../../discipline/schemas/discipline-rules.schema.js';
import { TournamentInformation, TournamentInformationSchema } from './tournament-information.schema.js';
import type { TournamentPhase } from '../../competition/types.js';

/** Configuración deportiva. Desempate V1 fijo: puntos → diferencia de goles → goles a favor. */
@Schema({ _id: false })
export class TournamentSettings {
  @Prop({ required: true, enum: CompetitionSystem, type: String, default: CompetitionSystem.LEAGUE })
  system: CompetitionSystem;

  @Prop({ required: true, min: 0, max: 10, default: 3 })
  pointsForWin: number;

  @Prop({ required: true, min: 0, max: 10, default: 1 })
  pointsForDraw: number;

  @Prop({ required: true, min: 0, max: 10, default: 0 })
  pointsForLoss: number;

  /**
   * Empates de liga/grupos definidos en penales: el ganador de la tanda suma estos puntos ADEMÁS de
   * los del empate. null = no se tiran penales en empates.
   */
  @Prop({ type: Number, default: null, min: 1, max: 10 })
  pointsForShootoutWin: number | null;

  /** Llave de eliminatoria igualada: cómo se decide (todas las rondas salvo la final si `finalTiebreak`). */
  @Prop({ type: String, enum: KnockoutTiebreak, default: KnockoutTiebreak.PENALTIES })
  knockoutTiebreak: KnockoutTiebreak;

  /**
   * Reacomodo de llaves (liguilla): la primera ronda sale de la siembra y las siguientes las arma el
   * organizador a mano. false = cuadro fijo (tipo Mundial). Se aplica al generar la eliminatoria.
   */
  @Prop({ type: Boolean, default: false })
  reseed: boolean;

  /** Regla propia para la final; null = la misma que el resto de rondas. */
  @Prop({ type: String, enum: KnockoutTiebreak, default: null })
  finalTiebreak: KnockoutTiebreak | null;

  /** Vueltas de la fase todos contra todos (liga o grupos). */
  @Prop({ type: Number, enum: [1, 2], default: 1 })
  roundRobinLegs: 1 | 2;

  /** Partidos por eliminatoria: 1 = partido único, 2 = ida y vuelta (marcador global). */
  @Prop({ type: Number, enum: [1, 2], default: 1 })
  knockoutLegs: 1 | 2;

  /** GROUPS_KNOCKOUT: número de grupos y clasificados por grupo. */
  @Prop({ type: Number, default: null })
  groupCount: number | null;

  @Prop({ type: Number, default: null })
  qualifiersPerGroup: number | null;

  /** LEAGUE_PLAYOFFS: equipos que clasifican a playoffs (2–64; si no es potencia de 2, los mejores pasan directo). */
  @Prop({ type: Number, default: null })
  playoffTeams: number | null;
}
export const TournamentSettingsSchema = SchemaFactory.createForClass(TournamentSettings);

export const DEFAULT_SETTINGS: TournamentSettings = {
  system: CompetitionSystem.LEAGUE,
  pointsForWin: 3,
  pointsForDraw: 1,
  pointsForLoss: 0,
  pointsForShootoutWin: null,
  knockoutTiebreak: KnockoutTiebreak.PENALTIES,
  finalTiebreak: null,
  reseed: false,
  roundRobinLegs: 1,
  knockoutLegs: 1,
  groupCount: null,
  qualifiersPerGroup: null,
  playoffTeams: null,
};

/**
 * Inscripción de equipos por link (Etapa 7). La controla el organizador. Límites null = sin límite.
 * `approvalRequired` es siempre true en V1 (no hay auto-aprobación); queda en el modelo para el futuro.
 * `deadline` es fecha deportiva `YYYY-MM-DD` inclusiva (día del servidor, como las demás fechas).
 */
@Schema({ _id: false })
export class TournamentRegistrationSettings {
  @Prop({ type: Boolean, default: false })
  enabled: boolean;

  @Prop({ type: Boolean, default: true })
  approvalRequired: boolean;

  @Prop({ type: Number, default: null })
  minPlayers: number | null;

  @Prop({ type: Number, default: null })
  maxPlayers: number | null;

  @Prop({ type: Number, default: null })
  maxTeams: number | null;

  @Prop({ type: String, default: null })
  deadline: string | null;
}
export const TournamentRegistrationSettingsSchema = SchemaFactory.createForClass(TournamentRegistrationSettings);
export const DEFAULT_REGISTRATION: TournamentRegistrationSettings = {
  enabled: false,
  approvalRequired: true,
  minPlayers: null,
  maxPlayers: null,
  maxTeams: null,
  deadline: null,
};

@Schema({ timestamps: true, collection: 'tournaments' })
export class Tournament {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ required: true, enum: TournamentFormat, type: String })
  format: TournamentFormat;

  @Prop({ required: true, trim: true, maxlength: 60 })
  category: string;

  /** `YYYY-MM-DD` */
  @Prop({ required: true })
  startDate: string;

  /** `YYYY-MM-DD` */
  @Prop({ type: String, default: null })
  endDate: string | null;

  @Prop({
    required: true,
    enum: TournamentStatus,
    type: String,
    default: TournamentStatus.DRAFT,
  })
  status: TournamentStatus;

  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  venue: string | null;

  @Prop({ type: TournamentSettingsSchema, default: () => ({ ...DEFAULT_SETTINGS }) })
  settings: TournamentSettings;

  @Prop({ type: TournamentInformationSchema, default: () => ({}) })
  information: TournamentInformation;

  @Prop({ type: String, default: null })
  logoUrl: string | null;

  @Prop({ type: String, default: null, select: false })
  logoPublicId: string | null;

  /** Campo de compatibilidad. Los torneos antiguos se leen siempre como FULL. */
  @Prop({ type: String, enum: DataCoverage, default: DataCoverage.FULL })
  dataCoverage: DataCoverage;

  /** Campo obsoleto. Se expone siempre vacío para clientes anteriores. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Team' }], default: [] })
  trackedTeamIds: Types.ObjectId[];

  /**
   * Estructura de la competición (fases generadas: grupos, cabezas de serie, bracket). La escribe
   * solo el servidor, dentro del cerrojo del torneo. Vacío = liga clásica (compatibilidad V1).
   * Tipos en modules/competition/types.ts.
   */
  @Prop({ type: [Object], default: [] })
  phases: TournamentPhase[];

  @Prop({ type: TournamentRegistrationSettingsSchema, default: () => ({ ...DEFAULT_REGISTRATION }) })
  registration: TournamentRegistrationSettings;

  /**
   * Reglamento disciplinario (solo administrativo: no se expone en las respuestas públicas).
   * Ausente en torneos anteriores: se lee con `disciplineOf()` (sin sanciones automáticas).
   */
  @Prop({ type: DisciplineRulesSchema, default: undefined, select: false })
  discipline?: DisciplineRules;

  /** Liga a la que pertenece (todo torneo vive en una; null solo en documentos previos a las ligas). */
  @Prop({ type: Types.ObjectId, ref: 'League', default: null, index: true })
  leagueId: Types.ObjectId | null;

  /** Organizador propietario (User). Se toma del JWT al crear; nunca del cliente. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizerId: Types.ObjectId;

  /**
   * Cerrojo lógico: cada escritura deportiva lo incrementa dentro de su transacción para
   * serializarse con las demás del mismo torneo (ver OwnershipService.lock). Interno.
   */
  @Prop({ type: Number, default: 0 })
  writeSeq: number;

  createdAt: Date;
  updatedAt: Date;
}

export type TournamentDocument = HydratedDocument<Tournament>;
export const TournamentSchema = SchemaFactory.createForClass(Tournament);
TournamentSchema.index({ status: 1, startDate: -1 });
TournamentSchema.index({ organizerId: 1, startDate: -1 });

/** Cobertura efectiva: sin campo (torneos anteriores a 6F) = FULL. */
export function coverageOf(_t: { dataCoverage?: DataCoverage | string | null }): DataCoverage {
  return DataCoverage.FULL;
}

/** Equipos seguidos efectivos: [] en FULL y en documentos anteriores a 6G. */
export function trackedOf(_t: { dataCoverage?: DataCoverage | string | null; trackedTeamIds?: Types.ObjectId[] | null }): Types.ObjectId[] {
  return [];
}

/**
 * El mismo objeto con `dataCoverage` y `trackedTeamIds` explícitos (respuestas que exponen el
 * torneo completo). Los ids de equipo son públicos (los equipos lo son).
 */
export function withCoverage<T extends object>(t: T): T & { dataCoverage: DataCoverage; trackedTeamIds: Types.ObjectId[] } {
  const doc = t as { dataCoverage?: string | null; trackedTeamIds?: Types.ObjectId[] | null };
  return { ...t, dataCoverage: coverageOf(doc), trackedTeamIds: trackedOf(doc) };
}
