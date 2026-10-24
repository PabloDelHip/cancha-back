/**
 * Logo del torneo para el PDF, best-effort: solo imágenes de Cloudinary (donde los guarda el módulo
 * de medios; nunca una URL arbitraria), pedidas como PNG pequeño, con tiempo y tamaño máximos. Si
 * falla, el PDF usa las iniciales. Las pruebas no tienen red: siempre usan las iniciales.
 */
export async function fetchLogo(url: string | null | undefined): Promise<Buffer | null> {
  if (!url || process.env.REPORTS_FETCH_LOGOS === 'false') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com' || !parsed.pathname.includes('/image/upload/')) return null;
  parsed.pathname = parsed.pathname.replace('/image/upload/', '/image/upload/f_png,w_160,h_160,c_fit/');
  try {
    const res = await fetch(parsed, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/png')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 1_000_000 ? buf : null;
  } catch {
    return null;
  }
}
