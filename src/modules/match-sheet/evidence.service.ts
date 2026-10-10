import { ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MatchEvidence } from './schemas/match-evidence.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { MatchIncident } from '../match-incidents/schemas/match-incident.schema.js';
import { EvidenceStatus, MatchLogAction } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, toObjectId } from '../../common/utils/serialize.js';
import { CloudinaryService } from '../media/cloudinary.service.js';
import type { UploadedImage } from '../media/image-upload.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { RemoveEvidenceDto, UploadEvidenceDto } from './dto/match-sheet.dto.js';
import { assertEvidenceImage, EVIDENCE_INCOMING, EVIDENCE_URL_TTL_SECONDS, evidencePublicId, MAX_EVIDENCE_PER_MATCH } from './evidence-rules.js';

type LeanEvidence = MatchEvidence & { _id: Types.ObjectId };

/**
 * Fotografías de evidencia (Módulo 2D). Privadas en Cloudinary: la API nunca devuelve una URL
 * permanente ni el `public_id`; `url()` da una URL firmada que vence en 5 minutos, después de
 * comprobar permisos (LOGS_VIEW, como el historial).
 *
 * Subida robusta: idempotente por `uploadKey` (el cliente reintenta sin duplicar), `public_id`
 * determinista (el reintento reemplaza el mismo archivo), registro dentro de la transacción del
 * torneo (permiso revalidado y tope de 20) y, si el registro falla, se borra el archivo subido salvo
 * que otra petición con la misma clave ya lo registró. Lo que quede sin registro por una caída lo
 * recoge el script `evidence:cleanup`.
 */
@Injectable()
export class EvidenceService {
  constructor(
    @InjectModel(MatchEvidence.name) private readonly evidence: Model<MatchEvidence>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(MatchIncident.name) private readonly incidents: Model<MatchIncident>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
    private readonly cloudinary: CloudinaryService,
    private readonly log: MatchLogService,
  ) {}

  async upload(matchId: string, dto: UploadEvidenceDto, file: UploadedImage | undefined, user: AuthUser) {
    const match = await this.ownership.match(matchId, user, Permission.EVIDENCE_UPLOAD);
    const existing = await this.evidence.findOne({ matchId: match._id, uploadKey: dto.uploadKey }).lean<LeanEvidence>();
    if (existing) return { evidence: view(existing), duplicate: true };
    assertEvidenceImage(file);
    await this.assertRoom(match._id);
    if (dto.incidentId && !(await this.incidents.exists({ _id: toObjectId(dto.incidentId), matchId: match._id }))) {
      throw new NotFoundException('La incidencia no es de este partido');
    }
    const stored = await this.cloudinary.uploadPrivate(file, { publicId: evidencePublicId(match.tournamentId.toHexString(), matchId, dto.uploadKey), incoming: EVIDENCE_INCOMING });
    try {
      const created = await this.ownership.inTournament(match.tournamentId, { user, permission: Permission.EVIDENCE_UPLOAD }, async (session) => {
        const current = await this.matches.findById(match._id).select('tournamentId').session(session).lean();
        if (!current || !sameId(current.tournamentId, match.tournamentId)) throw new NotFoundException('Partido no encontrado');
        const dup = await this.evidence.findOne({ matchId: match._id, uploadKey: dto.uploadKey }).session(session).lean<LeanEvidence>();
        if (dup) return dup;
        await this.assertRoom(match._id, session);
        const [doc] = await this.evidence.create(
          [
            {
              tournamentId: match.tournamentId,
              matchId: match._id,
              kind: dto.kind,
              description: dto.description?.trim() || null,
              incidentId: dto.incidentId ? toObjectId(dto.incidentId) : null,
              uploadKey: dto.uploadKey,
              publicId: stored.publicId,
              format: stored.format,
              bytes: stored.bytes,
              uploadedBy: toObjectId(user.id),
              uploadedRole: await this.access.roleOf(match.tournamentId, user.id, session),
            },
          ],
          { session },
        );
        await this.log.entry(session, { userId: user.id }, match, MatchLogAction.EVIDENCE_ADDED, {
          evidence: { from: null, to: { evidenceId: doc._id.toHexString(), kind: dto.kind, description: doc.description } },
        });
        return doc.toObject() as LeanEvidence;
      });
      return { evidence: view(created), duplicate: false };
    } catch (e) {
      // Otra petición con la misma clave lo registró: es el mismo archivo, no se borra.
      const dup = await this.evidence.findOne({ matchId: match._id, uploadKey: dto.uploadKey }).lean<LeanEvidence>();
      if (dup) return { evidence: view(dup), duplicate: true };
      if (!(await this.evidence.exists({ publicId: stored.publicId }))) await this.cloudinary.destroyPrivate(stored.publicId);
      throw e;
    }
  }

  /** URL temporal (5 min) de una fotografía activa, tras comprobar permisos. */
  async url(matchId: string, evidenceId: string, user: AuthUser) {
    const e = await this.one(matchId, evidenceId);
    await this.ownership.ownedTournament(e.tournamentId, user, Permission.LOGS_VIEW);
    if (e.status !== EvidenceStatus.ACTIVE) throw new GoneException('La fotografía fue retirada');
    return this.cloudinary.privateUrl(e.publicId, e.format, EVIDENCE_URL_TTL_SECONDS);
  }

  /** Retirar con motivo: el registro se conserva; el archivo deja de entregarse y se purga a los 30 días. */
  async remove(matchId: string, evidenceId: string, dto: RemoveEvidenceDto, user: AuthUser) {
    const match = await this.ownership.match(matchId, user, Permission.EVIDENCE_REMOVE);
    await this.ownership.inTournament(match.tournamentId, { user, permission: Permission.EVIDENCE_REMOVE }, async (session) => {
      const e = await this.evidence.findOne({ _id: toObjectId(evidenceId), matchId: match._id }).session(session).lean<LeanEvidence>();
      if (!e) throw new NotFoundException('Fotografía no encontrada');
      if (e.status !== EvidenceStatus.ACTIVE) throw new ConflictException('La fotografía ya fue retirada');
      const role = await this.access.roleOf(match.tournamentId, user.id, session);
      await this.evidence.updateOne(
        { _id: e._id, status: EvidenceStatus.ACTIVE },
        { $set: { status: EvidenceStatus.REMOVED, removed: { at: new Date(), by: toObjectId(user.id), role, reason: dto.reason } } },
        { session },
      );
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.EVIDENCE_REMOVED, {
        evidence: { from: { evidenceId, kind: e.kind, status: EvidenceStatus.ACTIVE }, to: { evidenceId, kind: e.kind, status: EvidenceStatus.REMOVED } },
      }, dto.reason);
    });
  }

  /** Fotografías del partido (activas y retiradas), sin URL ni public_id. */
  async ofMatch(matchId: Types.ObjectId) {
    const list = await this.evidence.find({ matchId }).sort({ createdAt: 1, _id: 1 }).lean<LeanEvidence[]>();
    return list.map(view);
  }

  private async assertRoom(matchId: Types.ObjectId, session: import('mongoose').ClientSession | null = null) {
    const active = await this.evidence.countDocuments({ matchId, status: EvidenceStatus.ACTIVE }).session(session);
    if (active >= MAX_EVIDENCE_PER_MATCH) throw new ConflictException(`El partido ya tiene ${MAX_EVIDENCE_PER_MATCH} fotografías: retira alguna antes de subir otra`);
  }

  private async one(matchId: string, evidenceId: string) {
    const e = await this.evidence.findOne({ _id: toObjectId(evidenceId), matchId: toObjectId(matchId) }).lean<LeanEvidence>();
    if (!e) throw new NotFoundException('Fotografía no encontrada');
    return e;
  }
}

/** Lo que sale por la API: nunca la ruta del archivo. */
function view(e: LeanEvidence) {
  return {
    id: e._id.toHexString(),
    kind: e.kind,
    description: e.description,
    incidentId: e.incidentId?.toHexString() ?? null,
    format: e.format,
    bytes: e.bytes,
    status: e.status,
    uploadedBy: e.uploadedBy.toHexString(),
    uploadedRole: e.uploadedRole,
    createdAt: e.createdAt,
    removed: e.removed ? { at: e.removed.at, by: e.removed.by.toHexString(), role: e.removed.role, reason: e.removed.reason } : null,
  };
}
