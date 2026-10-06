import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches, ValidateBy, ValidationOptions } from 'class-validator';
import { isValidISODate, TIME_REGEX } from './utils/dates.js';

/** Fecha pura `YYYY-MM-DD` existente en el calendario. */
export function IsISODateOnly(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isISODateOnly',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isValidISODate(value),
        defaultMessage: (args) =>
          `${args?.property} debe ser una fecha válida con formato YYYY-MM-DD`,
      },
    },
    options,
  );
}

/** Hora `HH:mm` (24 h). */
export function IsTime() {
  return Matches(TIME_REGEX, {
    message: ({ property }) => `${property} debe tener formato HH:mm`,
  });
}

/** Recorta espacios; convierte '' en null (campos opcionales de formularios). */
export function Trim() {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) => {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }),
  );
}
