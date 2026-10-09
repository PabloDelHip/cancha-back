import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const TOURNAMENT_CONTACT_FIELDS = ['name', 'phone', 'email', 'facebook', 'instagram', 'notes'] as const;
export type TournamentContactField = (typeof TOURNAMENT_CONTACT_FIELDS)[number];

@Schema({ _id: false })
export class TournamentSchedule {
  @Prop({ type: [Number], default: [] })
  days: number[];

  @Prop({ type: String, default: null })
  startTime: string | null;

  @Prop({ type: String, default: null })
  endTime: string | null;

  @Prop({ type: Number, default: null, min: 1, max: 1440 })
  durationMinutes: number | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  notes: string | null;

  @Prop({ type: Boolean, default: false })
  variable: boolean;

}
export const TournamentScheduleSchema = SchemaFactory.createForClass(TournamentSchedule);

@Schema({ _id: false })
export class TournamentEnrollment {
  @Prop({ type: String, default: null })
  opensOn: string | null;

  @Prop({ type: Number, default: null, min: 0, max: 1000000000 })
  teamFee: number | null;

  @Prop({ type: Number, default: null, min: 0, max: 1000000000 })
  playerFee: number | null;

  @Prop({ type: String, default: null, enum: ['free', 'paid', null] })
  paymentMode: 'free' | 'paid' | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 4000 })
  instructions: string | null;

}
export const TournamentEnrollmentSchema = SchemaFactory.createForClass(TournamentEnrollment);

@Schema({ _id: false })
export class TournamentCosts {
  @Prop({ type: String, default: 'MXN' })
  currency: string;

  @Prop({ type: Number, default: null, min: 0, max: 1000000000 })
  refereeFee: number | null;

  @Prop({ type: String, default: 'match', enum: ['team', 'match'] })
  refereeBilling: 'team' | 'match';

  @Prop({ type: Number, default: null, min: 0, max: 1000000000 })
  venueFee: number | null;

  @Prop({ type: Number, default: null, min: 0, max: 1000000000 })
  adminFee: number | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  adminDescription: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 4000 })
  paymentNotes: string | null;

}
export const TournamentCostsSchema = SchemaFactory.createForClass(TournamentCosts);

@Schema({ _id: false })
export class TournamentRules {
  @Prop({ type: String, default: null, trim: true, maxlength: 20000 })
  text: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 4000 })
  notes: string | null;

}
export const TournamentRulesSchema = SchemaFactory.createForClass(TournamentRules);

@Schema({ _id: false })
export class TournamentAwards {
  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  champion: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  runnerUp: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  topScorer: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  other: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  description: string | null;

}
export const TournamentAwardsSchema = SchemaFactory.createForClass(TournamentAwards);

@Schema({ _id: false })
export class TournamentContact {
  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  name: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 30 })
  phone: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 254 })
  email: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  facebook: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  instagram: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 2000 })
  notes: string | null;

  @Prop({ type: [String], default: [] })
  publicFields: TournamentContactField[];

}
export const TournamentContactSchema = SchemaFactory.createForClass(TournamentContact);

/** Informative conditions. Never used to generate matches or calculate competition results. */
@Schema({ _id: false })
export class TournamentInformation {
  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  season: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 6000 })
  description: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 80 })
  city: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 80 })
  state: string | null;

  @Prop({ type: TournamentScheduleSchema, default: () => ({}) })
  schedule: TournamentSchedule;

  @Prop({ type: TournamentEnrollmentSchema, default: () => ({}) })
  enrollment: TournamentEnrollment;

  @Prop({ type: TournamentCostsSchema, default: () => ({}) })
  costs: TournamentCosts;

  @Prop({ type: TournamentRulesSchema, default: () => ({}) })
  rules: TournamentRules;

  @Prop({ type: TournamentAwardsSchema, default: () => ({}) })
  awards: TournamentAwards;

  @Prop({ type: TournamentContactSchema, default: () => ({}) })
  contact: TournamentContact;

}
export const TournamentInformationSchema = SchemaFactory.createForClass(TournamentInformation);
