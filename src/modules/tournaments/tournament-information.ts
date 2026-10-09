import { BadRequestException } from '@nestjs/common';
import type { TournamentInformation } from './schemas/tournament-information.schema.js';
import type { TournamentInformationDto } from './dto/tournament-information.dto.js';

export const DEFAULT_INFORMATION: TournamentInformation = {
  season: null,
  description: null,
  city: null,
  state: null,
  schedule: { days: [], startTime: null, endTime: null, durationMinutes: null, notes: null, variable: false },
  enrollment: { opensOn: null, teamFee: null, playerFee: null, paymentMode: null, instructions: null },
  costs: { currency: 'MXN', refereeFee: null, refereeBilling: 'match', venueFee: null, adminFee: null, adminDescription: null, paymentNotes: null },
  rules: { text: null, notes: null },
  awards: { champion: null, runnerUp: null, topScorer: null, other: null, description: null },
  contact: { name: null, phone: null, email: null, facebook: null, instagram: null, notes: null, publicFields: [] },
};

export const definedInformation = <T extends object>(value: T | null | undefined): Partial<T> => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

export function mergeInformation(current: Partial<TournamentInformation> | null | undefined, patch?: TournamentInformationDto): TournamentInformation {
  const next: TournamentInformation = { ...DEFAULT_INFORMATION, ...current, ...definedInformation({ season: patch?.season, description: patch?.description, city: patch?.city, state: patch?.state }) };
  next.schedule = { ...DEFAULT_INFORMATION.schedule, ...current?.schedule, ...definedInformation(patch?.schedule) };
  next.enrollment = { ...DEFAULT_INFORMATION.enrollment, ...current?.enrollment, ...definedInformation(patch?.enrollment) };
  next.costs = { ...DEFAULT_INFORMATION.costs, ...current?.costs, ...definedInformation(patch?.costs) };
  next.rules = { ...DEFAULT_INFORMATION.rules, ...current?.rules, ...definedInformation(patch?.rules) };
  next.awards = { ...DEFAULT_INFORMATION.awards, ...current?.awards, ...definedInformation(patch?.awards) };
  next.contact = { ...DEFAULT_INFORMATION.contact, ...current?.contact, ...definedInformation(patch?.contact) };
  return next;
}

export function validateInformation(info: TournamentInformation, deadline?: string | null) {
  if (info.enrollment.opensOn && deadline && info.enrollment.opensOn > deadline) throw new BadRequestException("La apertura de inscripciones no puede ser posterior a la fecha límite");
  if (info.schedule.startTime && info.schedule.endTime && info.schedule.endTime <= info.schedule.startTime) throw new BadRequestException("La hora habitual de término debe ser posterior a la de inicio");
  if (info.enrollment.paymentMode === "free" && ((info.enrollment.teamFee ?? 0) > 0 || (info.enrollment.playerFee ?? 0) > 0)) throw new BadRequestException("Una inscripción gratuita no puede tener cuotas de inscripción");
}
