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
      [Permission.VIEW, Permission.SCHEDULE, Permission.ASSIGNMENTS, Permission.DISCIPLINE_VIEW, Permission.LOGS_VIEW, Permission.REFEREE_CONTACT].sort(),
    );
    expect(permissionsOf(TournamentRole.SCORER).sort()).toEqual([Permission.VIEW, Permission.RESULTS, Permission.DISCIPLINE_VIEW, Permission.LOGS_VIEW].sort());
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
});
