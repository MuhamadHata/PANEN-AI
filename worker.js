/**
 * Cloudflare Worker Gateway untuk PANEN-AI (Free Plan)
 * - Menyajikan /api/geojson langsung dari Cloudflare Static Assets (hemat 5 MB/request)
 * - Mem-proxy /api/* dan /admin/* ke backend Python di Hugging Face Spaces
 * - Cron Trigger setiap 12 jam untuk menjaga Hugging Face Space tetap aktif
 */

const CACHEABLE_GET_PATHS = new Set([
  '/api/fsva-data',
  '/api/ews',
  '/api/ews-horizon',
  '/api/predict-all-provinsi',
  '/api/model-info',
  '/api/metrics',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Layani GeoJSON (5 MB) langsung dari Cloudflare Edge CDN tanpa membebani backend
    if (pathname === '/api/geojson' && request.method === 'GET') {
      const assetReq = new Request(new URL('/shp_simplified.geojson', url.origin), {
        method: 'GET',
      });
      const assetRes = await env.ASSETS.fetch(assetReq);
      if (assetRes.ok) {
        const headers = new Headers(assetRes.headers);
        headers.set('Content-Type', 'application/json; charset=utf-8');
        headers.set('Cache-Control', 'public, max-age=86400');
        return new Response(assetRes.body, {
          status: assetRes.status,
          headers,
        });
      }
    }

    // 2. Proxy semua /api/* dan /admin* ke backend Hugging Face Spaces
    if (pathname.startsWith('/api/') || pathname === '/admin' || pathname.startsWith('/admin/')) {
      const backendOrigin = (env.BACKEND_URL || '').replace(/\/+$/, '');
      if (!backendOrigin) {
        return new Response(
          JSON.stringify({ status: 'error', message: 'BACKEND_URL belum dikonfigurasi' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Cek Edge Cache singkat (60 detik) untuk endpoint GET publik yang berat
      const canCache =
        request.method === 'GET' &&
        CACHEABLE_GET_PATHS.has(pathname) &&
        !request.headers.get('Cookie');

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      if (canCache) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
      }

      const targetUrl = `${backendOrigin}${pathname}${url.search}`;
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.delete('host');
      forwardHeaders.set('X-Forwarded-Host', url.host);
      forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

      const hasBody = !['GET', 'HEAD'].includes(request.method);
      const backendRes = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
      });

      const responseHeaders = new Headers(backendRes.headers);

      // Rewrite header Location (http/https) agar redirect (/admin -> /admin/login) tetap di domain Cloudflare
      const location = responseHeaders.get('Location');
      if (location) {
        const backendHost = new URL(backendOrigin).host.replace(/\./g, '\\.');
        responseHeaders.set(
          'Location',
          location.replace(new RegExp(`^https?://${backendHost}`, 'i'), url.origin)
        );
      }

      const finalResponse = new Response(backendRes.body, {
        status: backendRes.status,
        statusText: backendRes.statusText,
        headers: responseHeaders,
      });

      if (canCache && backendRes.ok) {
        const toCache = finalResponse.clone();
        const cachedHeaders = new Headers(toCache.headers);
        cachedHeaders.set('Cache-Control', 'public, max-age=60');
        ctx.waitUntil(
          cache.put(
            cacheKey,
            new Response(toCache.body, {
              status: toCache.status,
              headers: cachedHeaders,
            })
          )
        );
      }

      return finalResponse;
    }

    // 3. Fallback ke Static Assets (utama.html / peta.html / prediksi.html / ews.html)
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger (Gratis) untuk ping backend agar Hugging Face Space tidak sleep
  async scheduled(event, env, ctx) {
    const backendOrigin = (env.BACKEND_URL || '').replace(/\/+$/, '');
    if (!backendOrigin) return;
    ctx.waitUntil(
      fetch(`${backendOrigin}/api/metrics`, {
        headers: { 'User-Agent': 'PANEN-AI-KeepAlive/1.0' },
      }).catch(() => {})
    );
  },
};
