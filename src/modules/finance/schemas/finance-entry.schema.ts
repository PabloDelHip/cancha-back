import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FinanceCategory, FinanceEntryKind, PaymentMethod } from '../finance.js';

/**
 * Módulo 4 — movimiento financiero de la cuenta de un equipo EN UN TORNEO. Libro de solo agregado:
 * nada se edita ni se borra; una corrección (4D) anula el movimiento (`voidedAt`, con motivo) y
 * registra otro. El saldo NUNCA se guarda: se deriva de los movimientos no anulados (finance.ts).
 * Kisokar solo registra: no procesa pagos ni emite comprobantes fiscales.
 *
 * Importes en CENTAVOS enteros (sin errores de punto flotante), siempre positivos: el signo lo da
 * `kind`. La cuenta no depende de la inscripción (TournamentTeam): retirar o quitar al equipo no
 * toca sus movimientos.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'finance_entries' })
export class FinanceEntry {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: String, enum: FinanceEntryKind, required: true })
  kind: FinanceEntryKind;

  /** Solo en cargos. */
  @Prop({ type: String, enum: [...Object.values(FinanceCategory), null], default: null })
  category: FinanceCategory | null;

  @Prop({ type: Number, required: true, min: 1 })
  amount: number;

  /** Moneda del torneo al registrarlo (information.costs.currency); no cambia después. */
  @Prop({ type: String, required: true })
  currency: string;

  /** Pagos y devoluciones. */
  @Prop({ type: String, enum: [...Object.values(PaymentMethod), null], default: null })
  method: PaymentMethod | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  reference: string | null;

  /** `YYYY-MM-DD` efectiva: cuándo se recibió el pago o se generó el cargo (no futura). */
  @Prop({ required: true })
  date: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  concept: string;

  /** 4B: motivo (obligatorio en multas y descuentos). */
  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  reason: string | null;

  /** 4B: multa vinculada a un partido del torneo en el que jugó el equipo (opcional). */
  @Prop({ type: Types.ObjectId, ref: 'Match', default: null })
  matchId: Types.ObjectId | null;

  /** 4B: multa vinculada a un jugador que está o estuvo en la plantilla del equipo en este torneo (opcional). */
  @Prop({ type: Types.ObjectId, ref: 'Player', default: null })
  playerId: Types.ObjectId | null;

  /** Nota interna del organizador. */
  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  notes: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recordedBy: Types.ObjectId;

  @Prop({ type: String, default: null })
  recordedRole: string | null;

  /** Clave de idempotencia del cliente: el mismo `requestId` nunca crea dos movimientos. */
  @Prop({ required: true })
  requestId: string;

  /** Anulación (4D): el movimiento sigue en el libro, marcado, y deja de contar en el saldo. */
  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  voidedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  voidedRole: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  voidReason: string | null;

  /** Corrección (4D): el movimiento anulado al que reemplaza. */
  @Prop({ type: Types.ObjectId, default: null })
  replaces: Types.ObjectId | null;

  /** Corrección (4D): el movimiento que reemplaza a este (anulado). */
  @Prop({ type: Types.ObjectId, default: null })
  replacedBy: Types.ObjectId | null;

  /** Clave de idempotencia de la anulación (4D): repetirla devuelve la misma anulación. */
  @Prop({ type: String, default: null })
  voidRequestId: string | null;

  createdAt: Date;
}

export type FinanceEntryDocument = HydratedDocument<FinanceEntry>;
export const FinanceEntrySchema = SchemaFactory.createForClass(FinanceEntry);
// Estado de cuenta paginado en orden cronológico (4D) y listado del torneo con filtros.
FinanceEntrySchema.index({ tournamentId: 1, teamId: 1, date: 1, createdAt: 1, _id: 1 });
FinanceEntrySchema.index({ tournamentId: 1, date: 1, createdAt: 1, _id: 1 });
FinanceEntrySchema.index({ tournamentId: 1, requestId: 1 }, { name: 'one_entry_per_request', unique: true });
FinanceEntrySchema.index({ teamId: 1 });
