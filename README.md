---
title: PANEN AI
emoji: 🌾
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
---

# PANEN-AI

Backend Flask + XGBoost untuk prediksi harga pangan, peta FSVA, dan Early Warning System (EWS).

- **Backend**: Hugging Face Spaces (Docker, port `7860`)
- **Frontend & Gateway**: Cloudflare Workers + Static Assets (`wrangler.jsonc` & `worker.js`)
