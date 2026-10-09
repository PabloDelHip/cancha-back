import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { EligibilityMode } from '../../../common/enums/index.js';

/**
 * Reglamento disciplinario del torneo. Los torneos anteriores al módulo no tienen el campo y se
 * leen con DEFAULT_DISCIPLINE (sin sanciones automáticas): nada cambia hasta que el organizador
 * lo activa.
 */
@Schema({ _id: false })
export class DisciplineRules {
  /** Genera sanciones automáticas. Las manuales y los avisos de elegibilidad aplican siempre. */
  @Prop({ type: Boolean, default: false })
  enabled: boolean;

  /** Amarillas que generan una suspensión (cada N). null = sin suspensión por acumulación. */
  @Prop({ type: Number, default: 5, min: 2, max: 20 })
  yellowsForSuspension: number | null;

  @Prop({ type: Number, default: 1, min: 0, max: 20 })
  accumulationMatches: number;

  @Prop({ type: Number, default: 1, min: 0, max: 20 })
  directRedMatches: number;

  @Prop({ type: Number, default: 1, min: 0, max: 20 })
  secondYellowMatches: number;

  /** El conteo de amarillas vuelve a cero al empezar una nueva fase (las suspensiones no). */
  @Prop({ type: Boolean, default: false })
  resetAccumulationOnPhaseChange: boolean;

  @Prop({ type: String, enum: EligibilityMode, default: EligibilityMode.WARN })
  eligibility: EligibilityMode;
}

export const DisciplineRulesSchema = SchemaFactory.createForClass(DisciplineRules);

export const DEFAULT_DISCIPLINE: DisciplineRules = {
  enabled: false,
  yellowsForSuspension: 5,
  accumulationMatches: 1,
  directRedMatches: 1,
  secondYellowMatches: 1,
  resetAccumulationOnPhaseChange: false,
  eligibility: EligibilityMode.WARN,
};

export const disciplineOf = (t: { discipline?: Partial<DisciplineRules> | null }): DisciplineRules => ({
  ...DEFAULT_DISCIPLINE,
  ...t.discipline,
});
