import { decryptRegistrationToken, encryptRegistrationToken, hashRegistrationToken, newRegistrationToken, TOKEN_PATTERN } from './registration-token.js';

describe('token del enlace de inscripción', () => {
  it('256 bits aleatorios en base64url, distintos cada vez', () => {
    const tokens = new Set(Array.from({ length: 200 }, newRegistrationToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(TOKEN_PATTERN);
  });

  it('hash determinista (búsqueda) y distinto del token', () => {
    const t = newRegistrationToken();
    expect(hashRegistrationToken(t)).toBe(hashRegistrationToken(t));
    expect(hashRegistrationToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRegistrationToken(t)).not.toContain(t);
  });

  it('cifrado autenticado: se recupera con el secreto correcto y falla con otro o si se altera', () => {
    const t = newRegistrationToken();
    const enc = encryptRegistrationToken(t, 'secreto-del-servidor-0123456789abcdef');
    expect(enc).not.toContain(t);
    expect(decryptRegistrationToken(enc, 'secreto-del-servidor-0123456789abcdef')).toBe(t);
    expect(() => decryptRegistrationToken(enc, 'otro-secreto-0123456789abcdef0123')).toThrow();
    const [iv, tag, data] = enc.split('.');
    const tampered = [iv, tag, data.slice(0, -2) + (data.endsWith('AA') ? 'BB' : 'AA')].join('.');
    expect(() => decryptRegistrationToken(tampered, 'secreto-del-servidor-0123456789abcdef')).toThrow();
  });
});
