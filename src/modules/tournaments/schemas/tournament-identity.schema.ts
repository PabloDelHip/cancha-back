import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * 10C — foto de identidad de un torneo FINALIZADO: los nombres con que se jugó. Solo nombres
 * deportivos, escudo y colores (nunca contacto, nacimiento, documentos ni dinero) y NINGÚN dato
 * deportivo: resultados y estadísticas siguen en sus colecciones y se leen por id.
 * Se toma dentro de la transacción del cierre; después solo cambia con una corrección explícita
 * y auditada (POST /tournaments/:id/identity/corrections).
 */
@Schema({ _id: false })
export class IdentityTeam {
  @Prop({ type: Types.ObjectId, required: true })
  teamId: Types.ObjectId;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  shortName: string;

  @Prop({ type: String, default: null })
  logoUrl: string | null;

  @Prop({ type: { primary: String, secondary: String, _id: false }, required: true })
  colors: { primary: string; secondary: string };
}
export const IdentityTeamSchema = SchemaFactory.createForClass(IdentityTeam);

@Schema({ _id: false })
export class IdentityPlayer {
  @Prop({ type: Types.ObjectId, required: true })
  playerId: Types.ObjectId;

  @Prop({ type: String, required: true })
  firstName: string;

  @Prop({ type: String, required: true })
  lastName: string;

  @Prop({ type: String, default: null })
  nickname: string | null;
}
export const IdentityPlayerSchema = SchemaFactory.createForClass(IdentityPlayer);

/** Corrección explícita de un nombre histórico: quién, cuándo, por qué, antes y después. */
@Schema({ _id: false })
export class IdentityCorrection {
  @Prop({ type: String, required: true })
  kind: 'TEAM' | 'PLAYER' | 'LEAGUE';

  @Prop({ type: Types.ObjectId, default: null })
  refId: Types.ObjectId | null;

  @Prop({ type: Object, required: true })
  before: Record<string, string | null>;

  @Prop({ type: Object, required: true })
  after: Record<string, string | null>;

  @Prop({ type: String, required: true })
  reason: string;

  @Prop({ type: Types.ObjectId, required: true })
  by: Types.ObjectId;

  @Prop({ type: String, required: true })
  role: string;

  @Prop({ type: Date, required: true })
  at: Date;
}
export const IdentityCorrectionSchema = SchemaFactory.createForClass(IdentityCorrection);

@Schema({ _id: false })
export class TournamentIdentity {
  @Prop({ type: Date, required: true })
  takenAt: Date;

  @Prop({ type: String, default: null })
  leagueName: string | null;

  @Prop({ type: [IdentityTeamSchema], default: [] })
  teams: IdentityTeam[];

  @Prop({ type: [IdentityPlayerSchema], default: [] })
  players: IdentityPlayer[];

  @Prop({ type: [IdentityCorrectionSchema], default: [] })
  corrections: IdentityCorrection[];
}
export const TournamentIdentitySchema = SchemaFactory.createForClass(TournamentIdentity);
