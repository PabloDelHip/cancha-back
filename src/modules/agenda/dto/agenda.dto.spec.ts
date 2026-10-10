import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AgendaQueryDto } from './agenda.dto.js';

const parse = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(AgendaQueryDto, query);
  return { dto, errors: (await validate(dto)).map((e) => e.property) };
};

describe('filtros de la agenda', () => {
  it('estados: uno, varios separados por coma o repetidos; SUSPENDED incluido', async () => {
    expect((await parse({ status: 'SUSPENDED' })).dto.status).toEqual(['SUSPENDED']);
    expect((await parse({ status: 'SCHEDULED, LIVE' })).dto.status).toEqual(['SCHEDULED', 'LIVE']);
    expect((await parse({ status: ['FINISHED', 'CANCELLED'] })).dto.status).toEqual(['FINISHED', 'CANCELLED']);
    expect((await parse({ status: 'RAIN' })).errors).toContain('status');
  });

  it('finalizados excluidos salvo includeFinished=true; paginación por defecto', async () => {
    expect((await parse({})).dto).toMatchObject({ page: 1, limit: 20 });
    expect((await parse({})).dto.includeFinished).toBeUndefined();
    expect((await parse({ includeFinished: 'true' })).dto.includeFinished).toBe(true);
    expect((await parse({ includeFinished: 'false' })).dto.includeFinished).toBe(false);
  });

  it('fechas e ids validados', async () => {
    expect((await parse({ from: '2027-03-01', to: '2027-03-31' })).errors).toEqual([]);
    expect((await parse({ from: '01/03/2027' })).errors).toContain('from');
    expect((await parse({ venueId: 'x', refereeId: 'y' })).errors.sort()).toEqual(['refereeId', 'venueId']);
    expect((await parse({ limit: '500' })).errors).toContain('limit');
  });
});
