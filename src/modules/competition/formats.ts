/**
 * Formatos de competición como secuencias de fases. Es el único lugar que sabe qué fases tiene
 * cada formato y qué configuración es válida; el resto de la app trabaja con fases
 * (LEAGUE / GROUPS / KNOCKOUT), no con formatos. Añadir un formato = declarar sus fases aquí.
 */
import { CompetitionSystem, PhaseType } from '../../common/enums/index.js';

export interface FormatSettings {
  system: CompetitionSystem;
  roundRobinLegs?: number | null;
  knockoutLegs?: number | null;
  groupCount?: number | null;
  qualifiersPerGroup?: number | null;
  playoffTeams?: number | null;
}

export interface FormatDefinition {
  system: CompetitionSystem;
  label: string;
  phases: PhaseType[];
}

export const FORMATS: Record<CompetitionSystem, FormatDefinition> = {
  [CompetitionSystem.LEAGUE]: { system: CompetitionSystem.LEAGUE, label: 'Liga', phases: [PhaseType.LEAGUE] },
  [CompetitionSystem.KNOCKOUT]: { system: CompetitionSystem.KNOCKOUT, label: 'Eliminación directa', phases: [PhaseType.KNOCKOUT] },
  [CompetitionSystem.GROUPS_KNOCKOUT]: {
    system: CompetitionSystem.GROUPS_KNOCKOUT,
    label: 'Grupos + eliminación',
    phases: [PhaseType.GROUPS, PhaseType.KNOCKOUT],
  },
  [CompetitionSystem.LEAGUE_PLAYOFFS]: {
    system: CompetitionSystem.LEAGUE_PLAYOFFS,
    label: 'Liga + playoffs',
    phases: [PhaseType.LEAGUE, PhaseType.KNOCKOUT],
  },
};

export const PLAYOFF_SIZES = [2, 4, 8, 16] as const;
export const MAX_GROUPS = 8;

export function phasesOf(system: CompetitionSystem | undefined | null): PhaseType[] {
  return FORMATS[system ?? CompetitionSystem.LEAGUE]?.phases ?? [PhaseType.LEAGUE];
}

/** El formato termina en eliminatoria (campeón = ganador de la final). */
export const endsInKnockout = (system: CompetitionSystem | undefined | null) => phasesOf(system).at(-1) === PhaseType.KNOCKOUT;

export const isPowerOfTwo = (n: number) => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;

/** Reparto equilibrado en grupos (los primeros grupos reciben el equipo sobrante). */
export function groupSizes(teamCount: number, groupCount: number): number[] {
  return Array.from({ length: groupCount }, (_, g) => Math.floor(teamCount / groupCount) + (g < teamCount % groupCount ? 1 : 0));
}

/** Coherencia de la configuración sin conocer todavía los equipos inscritos. */
export function validateFormatSettings(s: FormatSettings): string[] {
  const errors: string[] = [];
  if (s.roundRobinLegs != null && ![1, 2].includes(s.roundRobinLegs)) errors.push('roundRobinLegs debe ser 1 o 2');
  if (s.knockoutLegs != null && ![1, 2].includes(s.knockoutLegs)) errors.push('knockoutLegs debe ser 1 o 2');
  if (s.system === CompetitionSystem.GROUPS_KNOCKOUT) {
    const g = s.groupCount ?? 0;
    const q = s.qualifiersPerGroup ?? 0;
    if (!Number.isInteger(g) || g < 2 || g > MAX_GROUPS) errors.push(`El número de grupos debe estar entre 2 y ${MAX_GROUPS}`);
    if (!Number.isInteger(q) || q < 1) errors.push('Debe clasificar al menos 1 equipo por grupo');
    else if (g >= 2 && !isPowerOfTwo(g * q)) {
      errors.push(
        `Clasificarían ${g * q} equipos (${g} grupos × ${q}); para armar el cuadro sin inventar criterios deben ser 2, 4, 8, 16 o 32. Ajusta grupos o clasificados.`,
      );
    }
  }
  if (s.system === CompetitionSystem.LEAGUE_PLAYOFFS && !PLAYOFF_SIZES.includes((s.playoffTeams ?? 0) as 2)) {
    errors.push('Los playoffs deben ser de 2, 4, 8 o 16 equipos');
  }
  return errors;
}

/** Validación con el número real de equipos inscritos (al generar el calendario). */
export function validateFormatForTeams(s: FormatSettings, teamCount: number): string[] {
  const errors = validateFormatSettings(s);
  if (errors.length) return errors;
  if (teamCount < 2) return ['Se necesitan al menos 2 equipos inscritos'];
  if (s.system === CompetitionSystem.KNOCKOUT && teamCount > 64) errors.push('La eliminación directa admite hasta 64 equipos');
  if (s.system === CompetitionSystem.GROUPS_KNOCKOUT) {
    const sizes = groupSizes(teamCount, s.groupCount!);
    const min = Math.min(...sizes);
    if (min < 2) errors.push(`Con ${teamCount} equipos no alcanzan ${s.groupCount} grupos de al menos 2`);
    else if (s.qualifiersPerGroup! > min) {
      errors.push(`Clasifican ${s.qualifiersPerGroup} por grupo pero el grupo más pequeño tendría ${min} equipos`);
    }
  }
  if (s.system === CompetitionSystem.LEAGUE_PLAYOFFS && teamCount < s.playoffTeams!) {
    errors.push(`Clasifican ${s.playoffTeams} a playoffs pero solo hay ${teamCount} equipos inscritos`);
  }
  return errors;
}
