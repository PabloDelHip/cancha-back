import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CloudinaryService, IMAGE_PRESETS } from './cloudinary.service.js';
import { detectImageType } from './image-upload.js';
import type { EnvConfig } from '../../config/env.validation.js';

const config = (values: Partial<EnvConfig>) => ({ get: (k: keyof EnvConfig) => values[k] ?? null }) as unknown as ConfigService<EnvConfig, true>;
const configured = () => new CloudinaryService(config({ CLOUDINARY_CLOUD_NAME: 'demo-cloud', CLOUDINARY_API_KEY: '123456', CLOUDINARY_API_SECRET: 'shh-secret' }));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const file = { buffer: PNG, mimetype: 'image/png', size: PNG.length, originalname: 'logo.png' };

afterEach(() => vi.unstubAllGlobals());

describe('CloudinaryService', () => {
  it('firma como documenta Cloudinary (parámetros ordenados + secreto, SHA-1)', () => {
    // Ejemplo oficial: https://cloudinary.com/documentation/authentication_signatures
    expect(
      CloudinaryService.sign({ timestamp: 1315060510, public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' }, 'abcd'),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('upload: POST firmado a la carpeta con transformación de entrada; devuelve URL f_auto,q_auto + public_id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'kikovo/teams/abc123', version: 1700000000 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const stored = await configured().upload(file, IMAGE_PRESETS.teamLogo);
    expect(stored).toEqual({ publicId: 'kikovo/teams/abc123', url: 'https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto/v1700000000/kikovo/teams/abc123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    const form = init.body as FormData;
    expect(form.get('folder')).toBe('kikovo/teams');
    expect(form.get('transformation')).toBe('c_limit,w_512,h_512');
    expect(form.get('api_key')).toBe('123456');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('api_secret')).toBeNull(); // el secreto nunca viaja
    expect(form.get('signature')).toBe(
      CloudinaryService.sign({ folder: 'kikovo/teams', timestamp: Number(form.get('timestamp')), transformation: 'c_limit,w_512,h_512' }, 'shh-secret'),
    );
  });

  it('upload: Cloudinary rechaza o no responde → 502 sin filtrar detalles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Invalid Signature"}}', { status: 401 })));
    await expect(configured().upload(file, IMAGE_PRESETS.playerPhoto)).rejects.toBeInstanceOf(BadGatewayException);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(configured().upload(file, IMAGE_PRESETS.playerPhoto)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('destroy: firmado con invalidate; nunca lanza; sin public_id no llama', async () => {
    const fetchMock = vi.fn(async () => new Response('{"result":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await configured().destroy('kikovo/players/old1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/destroy');
    expect([form.get('public_id'), form.get('invalidate')]).toEqual(['kikovo/players/old1', 'true']);
    await configured().destroy(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(configured().destroy('x')).resolves.toBeUndefined();
  });

  it('sin credenciales: subir → 503; borrar → no hace nada', async () => {
    const off = new CloudinaryService(config({}));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(off.configured).toBe(false);
    await expect(off.upload(file, IMAGE_PRESETS.playerPhoto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await off.destroy('x');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('detectImageType (contenido real, no el mimetype del cliente)', () => {
  const pad = (b: number[] | Buffer) => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
  it('reconoce JPG, PNG, GIF, WebP y AVIF', () => {
    expect(detectImageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(pad(Buffer.from('GIF89a')))).toBe('image/gif');
    expect(detectImageType(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])))).toBe('image/webp');
    expect(detectImageType(pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif')])))).toBe('image/avif');
  });
  it('rechaza texto, SVG, PDF, ejecutables y archivos diminutos', () => {
    expect(detectImageType(pad(Buffer.from('hola mundo')))).toBeNull();
    expect(detectImageType(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')))).toBeNull();
    expect(detectImageType(pad(Buffer.from('%PDF-1.7')))).toBeNull();
    expect(detectImageType(pad(Buffer.from('MZ\x90\x00')))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('privado (2D): sube con type=private, public_id determinista y overwrite; la URL es temporal y firmada', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ public_id: 'kikovo/evidence/t/m/key12345', version: 1, format: 'jpg', bytes: 1234 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = configured();
    expect(await svc.uploadPrivate(file, { publicId: 'kikovo/evidence/t/m/key12345', incoming: 'c_limit,w_2400,h_2400' })).toEqual({ publicId: 'kikovo/evidence/t/m/key12345', version: 1, format: 'jpg', bytes: 1234 });
    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect([form.get('type'), form.get('overwrite'), form.get('public_id')]).toEqual(['private', 'true', 'kikovo/evidence/t/m/key12345']);
    expect(form.get('signature')).toBe(
      CloudinaryService.sign({ overwrite: 'true', public_id: 'kikovo/evidence/t/m/key12345', timestamp: Number(form.get('timestamp')), transformation: 'c_limit,w_2400,h_2400', type: 'private' }, 'shh-secret'),
    );

    const before = Math.floor(Date.now() / 1000);
    const { url, expiresAt } = svc.privateUrl('kikovo/evidence/t/m/key12345', 'jpg', 300);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/download');
    const q = Object.fromEntries(u.searchParams);
    expect(Number(q.expires_at)).toBeGreaterThanOrEqual(before + 300);
    expect(expiresAt.getTime()).toBe(Number(q.expires_at) * 1000);
    expect(q.type).toBe('private');
    expect(url).not.toContain('shh-secret');
    const { signature, api_key: _k, ...signed } = q;
    expect(signature).toBe(CloudinaryService.sign(signed, 'shh-secret'));
    // Nunca una URL pública permanente de res.cloudinary.com.
    expect(url).not.toContain('res.cloudinary.com');
  });

  it('privado: listar con Admin API (Basic) y borrar con type=private; la base del API es configurable (pruebas)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ resources: [{ public_id: 'kikovo/evidence/a', created_at: '2026-01-01T00:00:00Z' }], next_cursor: 'c2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new CloudinaryService(config({ CLOUDINARY_CLOUD_NAME: 'demo-cloud', CLOUDINARY_API_KEY: '123456', CLOUDINARY_API_SECRET: 'shh-secret', CLOUDINARY_API_URL: 'http://localhost:3999' }));
    const page = await svc.listPrivate('kikovo/evidence/');
    expect(page).toEqual({ resources: [{ publicId: 'kikovo/evidence/a', createdAt: new Date('2026-01-01T00:00:00Z') }], nextCursor: 'c2' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3999/v1_1/demo-cloud/resources/image/private?prefix=kikovo%2Fevidence%2F&max_results=500');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('123456:shh-secret').toString('base64')}`);
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect(await svc.destroyPrivate('kikovo/evidence/a')).toBe(true);
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body instanceof FormData && ((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as FormData).get('type')).toBe('private');
  });
});
