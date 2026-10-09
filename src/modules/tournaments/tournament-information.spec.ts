import { plainToInstance } from 'class-transformer';
import { serialize } from '../../common/utils/serialize.js';
import { mergeInformation, validateInformation } from './tournament-information.js';
import { TournamentInformationDto } from './dto/tournament-information.dto.js';

it('una edición parcial transformada no borra valores ni reinicia la configuración', () => {
  const old = mergeInformation(null, { season: 'Apertura', schedule: { days: [6, 7], startTime: '08:00', endTime: '22:00' }, costs: { refereeFee: 300 } });
  const patch = plainToInstance(TournamentInformationDto, { schedule: { notes: 'Horario variable' }, costs: { venueFee: 0 } });
  const next = mergeInformation(old, patch);
  expect(next).toMatchObject({ season: 'Apertura', schedule: { days: [6, 7], startTime: '08:00', endTime: '22:00', notes: 'Horario variable' }, costs: { refereeFee: 300, venueFee: 0, currency: 'MXN' } });
  expect(old.schedule.notes).toBeNull();
});

it('null elimina texto opcional y cero se conserva como importe numérico', () => {
  const old = mergeInformation(null, { season: 'Apertura', enrollment: { teamFee: 100 } });
  expect(mergeInformation(old, { season: null, enrollment: { teamFee: 0 } })).toMatchObject({ season: null, enrollment: { teamFee: 0 } });
});

it('la privacidad se aplica también a torneos anidados y requiere publicación explícita', () => {
  const information = mergeInformation(null, { contact: { name: 'Público', email: 'privado@example.com', notes: 'Solo organizador', publicFields: ['name'] } });
  const value = { summary: { tournaments: [{ information }] } };
  const publicValue = serialize(value);
  expect(JSON.stringify(publicValue)).not.toContain('privado@example.com');
  expect(JSON.stringify(publicValue)).not.toContain('Solo organizador');
  expect(publicValue.summary.tournaments[0].information.contact.name).toBe('Público');
  expect(serialize(value, { includePrivateTournamentContact: true }).summary.tournaments[0].information.contact.email).toBe('privado@example.com');
  expect(information.contact.email).toBe('privado@example.com');
});

it('la coherencia cruza los valores anteriores y los modificados', () => {
  const old = mergeInformation(null, { enrollment: { opensOn: '2027-03-01' }, schedule: { startTime: '08:00', endTime: '22:00' } });
  expect(() => validateInformation(mergeInformation(old, { schedule: { endTime: '07:59' } }))).toThrow();
  expect(() => validateInformation(old, '2027-02-28')).toThrow();
});
