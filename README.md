# PANEN-AI

Aplikasi web prediksi harga pangan (XGBoost), pemetaan ketahanan pangan (FSVA), dan Early Warning System (EWS) yang berjalan **100% gratis** di atas **Cloudflare Workers (Free) + Supabase Storage (Free) + GitHub Actions (Free)**.

## Arsitektur
- **Cloudflare Workers + Static Assets** ([worker.js](worker.js), [wrangler.jsonc](wrangler.jsonc)): menyajikan halaman HTML, GeoJSON (5 MB) dari CDN, seluruh endpoint `/api/*` dari cache JSON di Supabase, serta Panel Admin `/admin`.
- **Supabase Storage**: menyimpan file upload CSV admin (`uploads/*`, `fsva/*`, `meta/upload_metadata.json`) dan hasil komputasi ML (`cache/*.json`).
- **GitHub Actions** ([.github/workflows/recompute.yml](.github/workflows/recompute.yml)): menjalankan [build_supabase_cache.py](build_supabase_cache.py) (Pandas + XGBoost) otomatis setiap kali ada perubahan dataset atau upload/hapus CSV dari panel admin.
