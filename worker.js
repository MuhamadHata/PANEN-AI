/**
 * Cloudflare Worker untuk PANEN-AI — 100% Gratis (Cloudflare Workers Free + Supabase Storage Free)
 *
 * Arsitektur:
 * - Static Assets (Cloudflare Edge): utama.html, peta.html, prediksi.html, ews.html, shp_simplified.geojson
 * - Public API (/api/*): membaca hasil komputasi JSON (`cache/*.json`) dari Supabase Storage + Edge Cache
 * - Admin Panel (/admin, /admin/*): auth signed cookie (HMAC-SHA256), upload/list/hapus CSV ke Supabase Storage,
 *   dan otomatis memicu GitHub Actions (.github/workflows/recompute.yml) untuk menghitung ulang cache ML.
 */

const SESSION_COOKIE = 'panen_admin_session';
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 hari

const KOMODITAS_VALID = {
  cabai: 'Cabai Rawit Merah',
  ayam: 'Daging Ayam Ras',
  sapi: 'Daging Sapi Murni',
  telur: 'Telur Ayam Ras',
};

const VALID_UPLOAD_JENIS = new Set(['cabai', 'ayam', 'sapi', 'telur', 'hujan']);

// =========================================================
// HELPERS: JSON RESPONSE & FORMATTER
// =========================================================

function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function formatRupiah(num) {
  return 'Rp ' + Math.round(Number(num) || 0).toLocaleString('en-US');
}

function formatTimestampWIB(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Konversi ke WIB (UTC+7)
  const wib = new Date(d.getTime() + 7 * 3600 * 1000);
  const dd = String(wib.getUTCDate()).padStart(2, '0');
  const mon = months[wib.getUTCMonth()];
  const yyyy = wib.getUTCFullYear();
  const hh = String(wib.getUTCHours()).padStart(2, '0');
  const mm = String(wib.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${yyyy} ${hh}:${mm}`;
}

function formatSqlNowWIB() {
  const wib = new Date(Date.now() + 7 * 3600 * 1000);
  return wib.toISOString().replace('T', ' ').slice(0, 19);
}

// =========================================================
// HELPERS: HMAC-SHA256 SIGNED SESSION COOKIE
// =========================================================

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

async function createSessionToken(username, env) {
  const secret = env.SECRET_KEY || 'panen-ai-secret-2026';
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_SEC * 1000 })
    )
  );
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

async function verifyAdminSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const secret = env.SECRET_KEY || 'panen-ai-secret-2026';
  const expected = await hmacSign(payload, secret);
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!data.u || !data.exp || Date.now() > data.exp) return null;
    return data.u;
  } catch {
    return null;
  }
}

// =========================================================
// HELPERS: SUPABASE STORAGE REST API
// =========================================================

function getSupabaseConfig(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = (env.SUPABASE_KEY || '').trim();
  const bucket = (env.SUPABASE_BUCKET || 'panen-ai-uploads').trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL dan SUPABASE_KEY belum dikonfigurasi di Cloudflare Secrets');
  }
  return { url, key, bucket };
}

function supabaseHeaders(key, contentType) {
  const headers = { apikey: key };
  // Key baru Supabase (sb_secret_...) bukan JWT, cukup kirim via header apikey.
  // Key legacy (eyJ...) tetap membutuhkan Authorization: Bearer.
  if (!key.startsWith('sb_')) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

function encodeStoragePath(path) {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

async function supabaseDownloadRaw(env, path, ctx, edgeCacheTtlSec = 60) {
  const { url, key, bucket } = getSupabaseConfig(env);
  const remoteUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`;

  const cache = caches.default;
  const cacheKey = new Request(`https://panen-cache.internal/${bucket}/${path}`, { method: 'GET' });
  if (edgeCacheTtlSec > 0) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const res = await fetch(remoteUrl, {
    method: 'GET',
    headers: supabaseHeaders(key),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Supabase download '${path}' gagal (${res.status}): ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const body = await res.arrayBuffer();
  const outHeaders = new Headers({
    'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8',
    'Cache-Control': edgeCacheTtlSec > 0 ? `public, max-age=${edgeCacheTtlSec}` : 'no-store',
  });
  const response = new Response(body, { status: 200, headers: outHeaders });

  if (edgeCacheTtlSec > 0 && ctx) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

async function supabaseDownloadJson(env, path, ctx, edgeCacheTtlSec = 60) {
  const res = await supabaseDownloadRaw(env, path, ctx, edgeCacheTtlSec);
  return res.json();
}

async function supabaseUpload(env, path, bodyBytes, contentType = 'text/csv') {
  const { url, key, bucket } = getSupabaseConfig(env);
  const remoteUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(path)}`;
  const res = await fetch(remoteUrl, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(key, contentType),
      'x-upsert': 'true',
    },
    body: bodyBytes,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Upload Supabase gagal (${res.status}): ${txt.slice(0, 250)}`);
  }
}

async function supabaseList(env, prefix) {
  const { url, key, bucket } = getSupabaseConfig(env);
  const remoteUrl = `${url}/storage/v1/object/list/${encodeURIComponent(bucket)}`;
  const res = await fetch(remoteUrl, {
    method: 'POST',
    headers: supabaseHeaders(key, 'application/json'),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`List Supabase gagal (${res.status}): ${txt.slice(0, 250)}`);
  }
  return res.json();
}

async function supabaseRemove(env, paths) {
  const { url, key, bucket } = getSupabaseConfig(env);
  const remoteUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}`;
  const res = await fetch(remoteUrl, {
    method: 'DELETE',
    headers: supabaseHeaders(key, 'application/json'),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Hapus Supabase gagal (${res.status}): ${txt.slice(0, 250)}`);
  }
}

async function loadUploadMetadata(env) {
  try {
    return await supabaseDownloadJson(env, 'meta/upload_metadata.json', null, 0);
  } catch {
    return {};
  }
}

async function saveUploadMetadata(env, meta) {
  const raw = new TextEncoder().encode(JSON.stringify(meta, null, 2));
  await supabaseUpload(env, 'meta/upload_metadata.json', raw, 'application/json');
}

// =========================================================
// HELPER: TRIGGER GITHUB ACTIONS RECOMPUTE WORKFLOW
// =========================================================

async function triggerGitHubRecompute(env, reason) {
  const token = (env.GITHUB_TOKEN || '').trim();
  const repo = (env.GITHUB_REPO || 'MuhamadHata/PANEN-AI').trim();
  if (!token || !repo) {
    return { triggered: false, note: 'GITHUB_TOKEN belum disetel; jalankan workflow Recompute manual di GitHub Actions.' };
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/recompute.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PANEN-AI-Cloudflare-Worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { reason: String(reason || 'admin_update').slice(0, 120) },
        }),
      }
    );
    if (res.status === 204 || res.ok) {
      return { triggered: true, note: 'Cache sedang dihitung ulang otomatis via GitHub Actions (~1-2 menit).' };
    }
    const errTxt = await res.text().catch(() => '');
    return { triggered: false, note: `Trigger GitHub Actions gagal (${res.status}): ${errTxt.slice(0, 120)}` };
  } catch (e) {
    return { triggered: false, note: `Trigger GitHub Actions error: ${e.message}` };
  }
}

// =========================================================
// HELPER: PARSER CSV RINGAN (RFC 4180 + BOM)
// =========================================================

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseCsvText(rawText) {
  const clean = rawText.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

// =========================================================
// MAIN FETCH HANDLER
// =========================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Lindungi akses langsung ke file HTML admin statis
    if (pathname === '/admin.html') {
      return Response.redirect(new URL('/admin', url.origin), 302);
    }
    if (pathname === '/admin_login.html') {
      return Response.redirect(new URL('/admin/login', url.origin), 302);
    }

    // ---------------------------------------------------------
    // 1. STATIC GEOJSON DARI CLOUDFLARE EDGE CDN
    // ---------------------------------------------------------
    if (pathname === '/api/geojson' && method === 'GET') {
      const assetReq = new Request(new URL('/shp_simplified.geojson', url.origin), { method: 'GET' });
      const assetRes = await env.ASSETS.fetch(assetReq);
      if (!assetRes.ok) {
        return jsonRes({ status: 'error', message: 'GeoJSON tidak ditemukan' }, 404);
      }
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(assetRes.body, { status: 200, headers });
    }

    // ---------------------------------------------------------
    // 2. PUBLIC API ENDPOINTS (DARI SUPABASE STORAGE CACHE)
    // ---------------------------------------------------------
    const noCache = url.searchParams.get('nocache') === '1';
    const cacheTtl = noCache ? 0 : 60;

    try {
      if (pathname === '/api/model-info' && method === 'GET') {
        const res = await supabaseDownloadRaw(env, 'cache/model_info.json', ctx, cacheTtl);
        return res;
      }

      if (pathname === '/api/metrics' && method === 'GET') {
        const res = await supabaseDownloadRaw(env, 'cache/metrics.json', ctx, cacheTtl);
        return res;
      }

      if (pathname === '/api/fsva-data' && method === 'GET') {
        const res = await supabaseDownloadRaw(env, 'cache/fsva_data.json', ctx, cacheTtl);
        return res;
      }

      if (pathname === '/api/ews' && method === 'GET') {
        const res = await supabaseDownloadRaw(env, 'cache/ews_dvi.json', ctx, cacheTtl);
        return res;
      }

      if (pathname === '/api/ews-horizon' && method === 'GET') {
        const res = await supabaseDownloadRaw(env, 'cache/ews_horizon.json', ctx, cacheTtl);
        return res;
      }

      if (pathname === '/api/predict-all-provinsi' && method === 'GET') {
        const komoditas = (url.searchParams.get('komoditas') || '').trim();
        const horizon = parseInt(url.searchParams.get('horizon') || '28', 10) || 28;
        if (!komoditas) {
          return jsonRes({ status: 'error', message: 'Parameter komoditas wajib diisi' }, 400);
        }
        const allMap = await supabaseDownloadJson(env, 'cache/predict_all.json', ctx, cacheTtl);
        const komData = allMap[komoditas];
        if (!komData) {
          return jsonRes({ status: 'error', message: `Komoditas '${komoditas}' tidak ditemukan` }, 404);
        }
        return jsonRes({
          status: 'success',
          komoditas,
          horizon,
          data: komData,
          from_cache: true,
        });
      }

      if (pathname === '/api/predict-week' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const provinsi = String(body.provinsi || '').trim();
        const komoditas = String(body.komoditas || '').trim();
        const horizon = Math.max(1, Math.min(90, parseInt(body.horizon || 7, 10) || 7));

        const all90 = await supabaseDownloadJson(env, 'cache/predict_week_90.json', ctx, cacheTtl);
        const key = `${provinsi.toLowerCase()}||${komoditas.toLowerCase()}`;
        const entry = all90[key];
        if (!entry) {
          return jsonRes({ status: 'error', message: `Tidak ada data untuk ${provinsi} - ${komoditas}` }, 400);
        }

        const predictions = entry.prices.slice(0, horizon).map((price, idx) => ({
          day: idx + 1,
          price,
          price_formatted: formatRupiah(price),
        }));

        return jsonRes({
          status: 'success',
          provinsi: entry.provinsi,
          komoditas: entry.komoditas,
          horizon: predictions.length,
          last_data_date: entry.last_data_date,
          predictions,
        });
      }

      if (pathname === '/api/predict' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const provinsi = String(body.provinsi || '').trim();
        const komoditas = String(body.komoditas || '').trim();

        const all90 = await supabaseDownloadJson(env, 'cache/predict_week_90.json', ctx, cacheTtl);
        const key = `${provinsi.toLowerCase()}||${komoditas.toLowerCase()}`;
        const entry = all90[key];
        if (!entry) {
          return jsonRes({ status: 'error', message: `Tidak ada data untuk ${provinsi} - ${komoditas}` }, 400);
        }

        const prediction = Number(entry.day1_prediction ?? entry.prices[0] ?? 0);
        const lower = prediction * 0.92;
        const upper = prediction * 1.08;

        return jsonRes({
          status: 'success',
          provinsi: entry.provinsi,
          komoditas: entry.komoditas,
          prediction,
          prediction_formatted: formatRupiah(prediction),
          confidence_lower: lower,
          confidence_upper: upper,
          confidence_lower_formatted: formatRupiah(lower),
          confidence_upper_formatted: formatRupiah(upper),
          last_data_date: entry.last_data_date,
        });
      }

      if (pathname === '/api/get-latest-data' && method === 'GET') {
        const provinsi = (url.searchParams.get('provinsi') || '').trim();
        const komoditas = (url.searchParams.get('komoditas') || '').trim();
        const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '30', 10) || 30));

        const latestMap = await supabaseDownloadJson(env, 'cache/latest_data.json', ctx, cacheTtl);
        const key = `${provinsi.toLowerCase()}||${komoditas.toLowerCase()}`;
        const entry = latestMap[key];
        if (!entry) {
          return jsonRes({ status: 'error', message: `Tidak ada data untuk ${provinsi} - ${komoditas}` }, 400);
        }

        return jsonRes({
          status: 'success',
          data: {
            dates: entry.dates.slice(-days),
            prices: entry.prices.slice(-days),
            produsen_prices: entry.produsen_prices.slice(-days),
          },
        });
      }

      // ---------------------------------------------------------
      // 3. ADMIN AUTH & PAGES
      // ---------------------------------------------------------
      if (pathname === '/admin/login' && method === 'GET') {
        const user = await verifyAdminSession(request, env);
        if (user) return Response.redirect(new URL('/admin', url.origin), 302);
        return env.ASSETS.fetch(new Request(new URL('/admin_login.html', url.origin)));
      }

      if (pathname === '/admin/login' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const expectedUser = env.ADMIN_USERNAME || 'admin';
        const expectedPass = env.ADMIN_PASSWORD || 'panen2026';

        if (username === expectedUser && password === expectedPass) {
          const token = await createSessionToken(username, env);
          const secureFlag = url.protocol === 'https:' ? '; Secure' : '';
          return jsonRes(
            { status: 'success' },
            200,
            {
              'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secureFlag}`,
            }
          );
        }
        return jsonRes({ status: 'error', message: 'Username atau password salah' }, 401);
      }

      if (pathname === '/admin/logout' && method === 'POST') {
        const secureFlag = url.protocol === 'https:' ? '; Secure' : '';
        return jsonRes(
          { status: 'success' },
          200,
          {
            'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
          }
        );
      }

      if ((pathname === '/admin' || pathname === '/admin/') && method === 'GET') {
        const user = await verifyAdminSession(request, env);
        if (!user) return Response.redirect(new URL('/admin/login', url.origin), 302);
        return env.ASSETS.fetch(new Request(new URL('/admin.html', url.origin)));
      }

      if (pathname === '/admin/check' && method === 'GET') {
        const user = await verifyAdminSession(request, env);
        if (!user) return jsonRes({ status: 'error' }, 401);
        return jsonRes({ status: 'ok', username: user });
      }

      // Semua endpoint /admin/* di bawah ini wajib login admin
      if (pathname.startsWith('/admin/')) {
        const adminUser = await verifyAdminSession(request, env);
        if (!adminUser) {
          return jsonRes({ status: 'error', message: 'Unauthorized' }, 401);
        }

        // GET /admin/status
        if (pathname === '/admin/status' && method === 'GET') {
          const res = await supabaseDownloadRaw(env, 'cache/admin_status.json', ctx, 0);
          return res;
        }

        // GET /admin/files/:jenis (khusus fsva)
        const filesListMatch = pathname.match(/^\/admin\/files\/([^/]+)$/);
        if (filesListMatch && method === 'GET') {
          const jenis = decodeURIComponent(filesListMatch[1]);
          if (!['harga', 'fsva', 'hujan'].includes(jenis)) {
            return jsonRes({ status: 'error', message: 'Jenis tidak valid' }, 400);
          }
          const prefix = jenis === 'fsva' ? 'fsva' : `uploads/${jenis}`;
          const items = await supabaseList(env, prefix);
          const files = (items || [])
            .filter((it) => it.name && it.name.toLowerCase().endsWith('.csv'))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((it) => ({
              name: it.name,
              size_kb: Math.round(((it.metadata && it.metadata.size) || 0) / 102.4) / 10,
              modified: formatTimestampWIB(it.updated_at || it.created_at),
            }));
          return jsonRes({ status: 'success', files });
        }

        // DELETE /admin/files/:jenis/:filename
        const filesDelMatch = pathname.match(/^\/admin\/files\/([^/]+)\/(.+)$/);
        if (filesDelMatch && method === 'DELETE') {
          const jenis = decodeURIComponent(filesDelMatch[1]);
          const filename = decodeURIComponent(filesDelMatch[2]);
          if (!['harga', 'fsva', 'hujan'].includes(jenis)) {
            return jsonRes({ status: 'error', message: 'Jenis tidak valid' }, 400);
          }
          const remotePath = jenis === 'fsva' ? `fsva/${filename}` : `uploads/${jenis}/${filename}`;
          await supabaseRemove(env, [remotePath]);
          const gh = await triggerGitHubRecompute(env, `delete_${jenis}_${filename}`);
          return jsonRes({
            status: 'success',
            message: `${filename} berhasil dihapus. ${gh.note}`,
          });
        }

        // GET /admin/uploads/:jenis
        const uploadsListMatch = pathname.match(/^\/admin\/uploads\/([^/]+)$/);
        if (uploadsListMatch && method === 'GET') {
          const jenis = decodeURIComponent(uploadsListMatch[1]);
          const meta = await loadUploadMetadata(env);
          return jsonRes({ status: 'success', data: meta[jenis] || [] });
        }

        // DELETE /admin/uploads/:jenis/:filename
        const uploadsDelMatch = pathname.match(/^\/admin\/uploads\/([^/]+)\/(.+)$/);
        if (uploadsDelMatch && method === 'DELETE') {
          const jenis = decodeURIComponent(uploadsDelMatch[1]);
          const filename = decodeURIComponent(uploadsDelMatch[2]);
          if (!VALID_UPLOAD_JENIS.has(jenis)) {
            return jsonRes({ status: 'error', message: 'Jenis tidak valid' }, 400);
          }
          await supabaseRemove(env, [`uploads/${jenis}/${filename}`]);
          const meta = await loadUploadMetadata(env);
          if (Array.isArray(meta[jenis])) {
            meta[jenis] = meta[jenis].filter((f) => f.filename !== filename);
          }
          await saveUploadMetadata(env, meta);
          const gh = await triggerGitHubRecompute(env, `delete_upload_${jenis}_${filename}`);
          return jsonRes({
            status: 'success',
            message: `${filename} berhasil dihapus. ${gh.note}`,
          });
        }

        // POST /admin/upload/harga/:komoditas
        const uploadHargaMatch = pathname.match(/^\/admin\/upload\/harga\/(cabai|ayam|sapi|telur)$/);
        if (uploadHargaMatch && method === 'POST') {
          const komKey = uploadHargaMatch[1];
          const validKom = KOMODITAS_VALID[komKey];
          const form = await request.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') {
            return jsonRes({ status: 'error', message: 'Tidak ada file' }, 400);
          }
          const rawText = await file.text();
          const { headers, rows } = parseCsvText(rawText);
          const missing = ['tanggal', 'provinsi', 'komoditas', 'harga'].filter((c) => !headers.includes(c));
          if (missing.length > 0) {
            return jsonRes({ status: 'error', message: `Kolom tidak lengkap: ${JSON.stringify(missing)}` }, 400);
          }
          const komIdx = headers.indexOf('komoditas');
          const hasInvalid = rows.some((r) => (r[komIdx] || '').trim() !== validKom);
          if (hasInvalid) {
            return jsonRes(
              { status: 'error', message: `Komoditas harus "${validKom}", ditemukan nilai lain` },
              400
            );
          }

          const saveName = file.name || `${komKey}_${Date.now()}.csv`;
          await supabaseUpload(env, `uploads/${komKey}/${saveName}`, new TextEncoder().encode(rawText), 'text/csv');

          const meta = await loadUploadMetadata(env);
          if (!Array.isArray(meta[komKey])) meta[komKey] = [];
          meta[komKey] = meta[komKey].filter((x) => x.filename !== saveName);
          meta[komKey].push({
            filename: saveName,
            rows: rows.length,
            uploaded_at: formatSqlNowWIB(),
            komoditas: validKom,
          });
          await saveUploadMetadata(env, meta);

          const gh = await triggerGitHubRecompute(env, `upload_harga_${komKey}`);
          return jsonRes({
            status: 'success',
            message: `${rows.length} baris ${validKom} tersimpan ke Supabase. ${gh.note}`,
            filename: saveName,
            rows: rows.length,
          });
        }

        // POST /admin/upload/fsva
        if (pathname === '/admin/upload/fsva' && method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') {
            return jsonRes({ status: 'error', message: 'Tidak ada file' }, 400);
          }
          const rawText = await file.text();
          const { headers, rows } = parseCsvText(rawText);
          const missing = ['Wilayah', 'NCPR'].filter((c) => !headers.includes(c));
          if (missing.length > 0) {
            return jsonRes({ status: 'error', message: `Kolom tidak lengkap: ${JSON.stringify(missing)}` }, 400);
          }
          const tahunMatch = (file.name || '').match(/(20\d{2})/);
          const tahunStr = tahunMatch ? tahunMatch[1] : '0000';
          const saveName = `fsva kabupaten ${tahunStr}.csv`;

          await supabaseUpload(env, `fsva/${saveName}`, new TextEncoder().encode(rawText), 'text/csv');
          const gh = await triggerGitHubRecompute(env, `upload_fsva_${tahunStr}`);
          return jsonRes({
            status: 'success',
            message: `${rows.length} kabupaten FSVA ${tahunStr} tersimpan ke Supabase. ${gh.note}`,
          });
        }

        // POST /admin/upload/curah-hujan
        if (pathname === '/admin/upload/curah-hujan' && method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') {
            return jsonRes({ status: 'error', message: 'Tidak ada file' }, 400);
          }
          const rawText = await file.text();
          const { headers, rows } = parseCsvText(rawText);
          const missing = ['Nama Provinsi', 'Tahun', 'Bulan', 'Curah Hujan'].filter((c) => !headers.includes(c));
          if (missing.length > 0) {
            return jsonRes({ status: 'error', message: `Kolom tidak lengkap: ${JSON.stringify(missing)}` }, 400);
          }
          const saveName = file.name || `hujan_${Date.now()}.csv`;
          await supabaseUpload(env, `uploads/hujan/${saveName}`, new TextEncoder().encode(rawText), 'text/csv');

          const meta = await loadUploadMetadata(env);
          if (!Array.isArray(meta.hujan)) meta.hujan = [];
          meta.hujan = meta.hujan.filter((x) => x.filename !== saveName);
          meta.hujan.push({
            filename: saveName,
            rows: rows.length,
            uploaded_at: formatSqlNowWIB(),
          });
          await saveUploadMetadata(env, meta);

          const gh = await triggerGitHubRecompute(env, `upload_hujan_${saveName}`);
          return jsonRes({
            status: 'success',
            message: `${rows.length} baris baru curah hujan tersimpan ke Supabase. ${gh.note}`,
          });
        }
      }
    } catch (err) {
      const status = err.status === 404 ? 503 : 500;
      const hint =
        err.status === 404
          ? ' (Pastikan workflow GitHub Actions "Recompute PANEN-AI Cache" sudah dijalankan sekali untuk mengisi cache di Supabase Storage.)'
          : '';
      return jsonRes({ status: 'error', message: `${err.message}${hint}` }, status);
    }

    // ---------------------------------------------------------
    // 4. FALLBACK KE STATIC ASSETS (utama.html, peta.html, dll)
    // ---------------------------------------------------------
    return env.ASSETS.fetch(request);
  },
};
