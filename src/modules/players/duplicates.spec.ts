import { duplicateScore, levenshtein, nameTokens, prefilterRegexes } from './duplicates.js';

const p = (firstName: string, lastName: string, birthDate: string | null = null) => ({ firstName, lastName, birthDate });
const isDup = (a: ReturnType<typeof p>, b: ReturnType<typeof p>) => duplicateScore(a, b) !== null;

describe('detección de posibles duplicados', () => {
  it('mismo nombre: coincidencia exacta (puntuación 1), sin importar acentos, mayúsculas ni espacios', () => {
    expect(duplicateScore(p('José Luis', 'Hernández'), p('José Luis', 'Hernández'))).toBe(1);
    expect(duplicateScore(p('jose luis', 'HERNANDEZ'), p('José  Luis', 'Hernández'))).toBe(1);
  });

  it('variantes razonables: nombre compuesto, segundo apellido, partículas y erratas', () => {
    expect(isDup(p('José', 'Hernández'), p('José Luis', 'Hernández López'))).toBe(true); // nombre y apellido parciales
    expect(isDup(p('Luis', 'Hernández'), p('José Luis', 'Hernández'))).toBe(true); // usa su segundo nombre
    expect(isDup(p('José Luis', 'Hernandes'), p('José Luis', 'Hernández'))).toBe(true); // errata
    expect(isDup(p('Guadalupe', 'Martinez'), p('Guadalupe', 'Martínez'))).toBe(true);
    expect(isDup(p('María de la Luz', 'Pérez'), p('María Luz', 'Pérez'))).toBe(true); // partículas
    expect(duplicateScore(p('José', 'Hernández'), p('José Luis', 'Hernández López'))!).toBeLessThan(1); // parecido ≠ exacto
  });

  it('personas distintas NO: otro apellido, otro nombre, nombres cortos solo si son iguales', () => {
    expect(isDup(p('Juan', 'Pérez'), p('Juan', 'Gómez'))).toBe(false);
    expect(isDup(p('Pedro', 'Pérez'), p('Juan', 'Pérez'))).toBe(false);
    expect(isDup(p('José', 'Hernández'), p('José', 'Fernández'))).toBe(false); // apellidos distintos aunque difieran en 1 letra
    expect(isDup(p('Ana', 'Ruiz'), p('Ina', 'Ruiz'))).toBe(false); // tokens < 4 letras: exactos
    expect(isDup(p('Juan', 'Pérez'), p('Juana', 'Pereira'))).toBe(false);
  });

  it('la fecha de nacimiento solo ordena: igual sube, distinta baja, nunca descarta', () => {
    const base = duplicateScore(p('Juan', 'Pérez López'), p('Juan', 'Pérez'))!;
    const same = duplicateScore(p('Juan', 'Pérez López', '2001-04-18'), p('Juan', 'Pérez', '2001-04-18'))!;
    const other = duplicateScore(p('Juan', 'Pérez López', '2001-04-18'), p('Juan', 'Pérez', '1990-01-01'));
    expect(same).toBeGreaterThan(base);
    expect(other).not.toBeNull();
    expect(other!).toBeLessThan(base);
  });

  it('utilidades: tokens normalizados, distancia de edición y prefiltro por 3 primeras letras', () => {
    expect(nameTokens('María de la Luz  Ñúñez')).toEqual(['maria', 'luz', 'nunez']);
    expect(levenshtein('hernandez', 'hernandes')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(prefilterRegexes(p('José Luis', 'Hernández'))).toEqual({ first: '(^| )(jos|lui)', last: '(^| )(her)' });
    expect(prefilterRegexes(p('J', 'H'))).toBeNull(); // sin tokens útiles no se busca
  });
});
