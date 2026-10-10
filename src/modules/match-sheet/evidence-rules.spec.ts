import { describe, expect, it } from 'vitest';
import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import { assertEvidenceImage, cleanupPlan, evidencePublicId, MAX_EVIDENCE_BYTES } from './evidence-rules.js';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const day = 24 * 60 * 60 * 1000;

describe('evidencias', () => {
  it('validación por contenido real y tamaño', () => {
    expect(() => assertEvidenceImage({ buffer: JPG, mimetype: 'image/jpeg', size: JPG.length, originalname: 'a.jpg' })).not.toThrow();
    expect(() => assertEvidenceImage(undefined)).toThrow(BadRequestException);
    const fake = Buffer.from('<svg onload=alert(1)></svg>'.padEnd(64, ' '));
    expect(() => assertEvidenceImage({ buffer: fake, mimetype: 'image/png', size: fake.length, originalname: 'x.png' })).toThrow(UnsupportedMediaTypeException);
    expect(() => assertEvidenceImage({ buffer: JPG, mimetype: 'image/jpeg', size: MAX_EVIDENCE_BYTES + 1, originalname: 'a.jpg' })).toThrow(/8 MB/);
  });

  it('ruta privada determinista por torneo, partido y clave de subida', () => {
    expect(evidencePublicId('t1', 'm1', 'key-12345')).toBe('kikovo/evidence/t1/m1/key-12345');
  });

  it('limpieza: huérfanos con más de 24 h y retiradas con más de 30 días; nunca activas ni recientes', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const plan = cleanupPlan({
      now,
      resources: [
        { publicId: 'old-orphan', createdAt: new Date(now.getTime() - 2 * day) },
        { publicId: 'fresh-orphan', createdAt: new Date(now.getTime() - 60_000) },
        { publicId: 'active', createdAt: new Date(now.getTime() - 90 * day) },
        { publicId: 'removed-old', createdAt: new Date(now.getTime() - 90 * day) },
        { publicId: 'removed-new', createdAt: new Date(now.getTime() - 90 * day) },
      ],
      records: [
        { publicId: 'active', status: 'ACTIVE', removedAt: null, purgedAt: null },
        { publicId: 'removed-old', status: 'REMOVED', removedAt: new Date(now.getTime() - 31 * day), purgedAt: null },
        { publicId: 'removed-new', status: 'REMOVED', removedAt: new Date(now.getTime() - 5 * day), purgedAt: null },
        { publicId: 'removed-purged', status: 'REMOVED', removedAt: new Date(now.getTime() - 60 * day), purgedAt: new Date() },
      ],
    });
    expect(plan).toEqual({ orphans: ['old-orphan'], purge: ['removed-old'] });
  });
});
