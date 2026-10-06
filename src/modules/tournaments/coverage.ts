import { ConflictException } from '@nestjs/common';
import { DataCoverage } from '../../common/enums/index.js';
import { coverageOf } from './schemas/tournament.schema.js';

export const TOURNAMENT_PARTIAL_COVERAGE = 'TOURNAMENT_PARTIAL_COVERAGE';

/**
 * Vistas GLOBALES de la competición (tabla, goleadores, estructura/campeón, generar la eliminatoria
 * desde la tabla): solo con cobertura FULL. En PARTIAL el torneo existe pero esas vistas no serían
 * válidas (faltan partidos de otros equipos): 409 con código de dominio, no 404 ni una lista vacía
 * que parezca oficial.
 */
export function assertFullCoverage(tournament: { dataCoverage?: DataCoverage | string | null }) {
  if (coverageOf(tournament) === DataCoverage.PARTIAL) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: TOURNAMENT_PARTIAL_COVERAGE,
      message:
        'Este torneo tiene seguimiento parcial: Cancha no dispone de todos sus resultados, así que no publica clasificaciones ni rankings generales.',
    });
  }
}
