import { describe, expect, it } from 'vitest';
import { TournamentRole } from '../enums/index.js';
import { can, Permission, permissionsOf } from './permissions.js';

describe('matriz de permisos (RBAC)', () => {
  it('propietario: todo; sin rol: nada', () => {
    expect(permissionsOf('OWNER').sort()).toEqual(Object.values(Permission).sort());
    expect(Object.values(Permission).some((p) => can(null, p))).toBe(false);
  });

  it('ADMIN: todo salvo eliminar y gestionar colaboradores', () => {
    expect(can(TournamentRole.ADMIN, Permission.DELETE)).toBe(false);
    expect(can(TournamentRole.ADMIN, Permission.MEMBERS)).toBe(false);
    expect(permissionsOf(TournamentRole.ADMIN)).toHaveLength(Object.values(Permission).length - 2);
  });

  it('COORDINATOR y SCORER: exactamente lo aprobado', () => {
    expect(permissionsOf(TournamentRole.COORDINATOR).sort()).toEqual(
      [Permission.VIEW, Permission.SCHEDULE, Permission.ASSIGNMENTS, Permission.INCIDENTS, Permission.REFEREE_CORRECTIONS, Permission.EVIDENCE_UPLOAD, Permission.DISCIPLINE_VIEW, Permission.LOGS_VIEW, Permission.REFEREE_CONTACT].sort(),
    );
    expect(permissionsOf(TournamentRole.SCORER).sort()).toEqual([Permission.VIEW, Permission.RESULTS, Permission.EVIDENCE_UPLOAD, Permission.DISCIPLINE_VIEW, Permission.LOGS_VIEW].sort());
    expect(can(TournamentRole.SCORER, Permission.REFEREE_CONTACT)).toBe(false);
  });

  it('recursos del propietario (R3): asignar y ver contacto solo OWNER/ADMIN/COORDINATOR', () => {
    for (const role of ['OWNER', TournamentRole.ADMIN, TournamentRole.COORDINATOR] as const) {
      expect(can(role, Permission.ASSIGNMENTS)).toBe(true);
      expect(can(role, Permission.REFEREE_CONTACT)).toBe(true);
    }
    expect(can(TournamentRole.SCORER, Permission.ASSIGNMENTS)).toBe(false);
    expect(can(TournamentRole.SCORER, Permission.REFEREE_CONTACT)).toBe(false);
  });

  it('2C-2: incidencias y correcciones arbitrales solo OWNER/ADMIN/COORDINATOR; SCORER no', () => {
    for (const role of ['OWNER', TournamentRole.ADMIN, TournamentRole.COORDINATOR] as const) {
      expect(can(role, Permission.INCIDENTS)).toBe(true);
      expect(can(role, Permission.REFEREE_CORRECTIONS)).toBe(true);
    }
    expect(can(TournamentRole.SCORER, Permission.INCIDENTS)).toBe(false);
    expect(can(TournamentRole.SCORER, Permission.REFEREE_CORRECTIONS)).toBe(false);
  });

  it('2D: cerrar y reabrir la ficha y retirar fotos solo OWNER/ADMIN; subir fotos todos; alineaciones con RESULTS', () => {
    for (const p of [Permission.SHEET_CLOSE, Permission.SHEET_REOPEN, Permission.EVIDENCE_REMOVE]) {
      expect(['OWNER', TournamentRole.ADMIN].every((r) => can(r as 'OWNER', p))).toBe(true);
      expect(can(TournamentRole.COORDINATOR, p) || can(TournamentRole.SCORER, p)).toBe(false);
    }
    for (const r of ['OWNER', TournamentRole.ADMIN, TournamentRole.COORDINATOR, TournamentRole.SCORER] as const) expect(can(r, Permission.EVIDENCE_UPLOAD)).toBe(true);
    expect(can(TournamentRole.COORDINATOR, Permission.RESULTS)).toBe(false);
  });
});
