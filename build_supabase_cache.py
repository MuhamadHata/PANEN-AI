"""
build_supabase_cache.py
=======================
Menghitung seluruh cache ML (XGBoost 1-90 hari, Heatmap 28 hari, EWS, DVI, FSVA,
data historis terbaru, dan status admin) lalu mengunggahnya sebagai file JSON
ringan ke Supabase Storage (`cache/*.json`) agar Cloudflare Worker (Free Plan)
bisa melayani seluruh web & API PANEN-AI 24/7 tanpa server Python berbayar.

Dijalankan otomatis oleh GitHub Actions (.github/workflows/recompute.yml) setiap
kali ada push atau upload/hapus CSV dari panel admin, atau bisa dijalankan manual:
    python build_supabase_cache.py
"""

import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

# Pastikan working directory = folder script ini
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)

# Cegah background thread precompute_all() milik backend.py berjalan paralel saat import
_orig_thread_start = threading.Thread.start
threading.Thread.start = lambda self: None
import backend  # noqa: E402
threading.Thread.start = _orig_thread_start


def _json_bytes(obj) -> bytes:
    """Serialize ke JSON kompak tanpa NaN/Inf agar valid di JS/Cloudflare."""
    def _clean(v):
        if isinstance(v, dict):
            return {str(k): _clean(val) for k, val in v.items()}
        if isinstance(v, list):
            return [_clean(val) for val in v]
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating, float)):
            f = float(v)
            return None if (np.isnan(f) or np.isinf(f)) else round(f, 4)
        if pd.isna(v):
            return None
        return v

    cleaned = _clean(obj)
    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sync_fsva_with_supabase():
    """
    Sinkronisasi folder Dataset/kabupaten (FSVA) dengan prefix `fsva/` di Supabase Storage:
    - Jika `fsva/` di Supabase masih kosong (run pertama): unggah semua CSV dasar ke Supabase.
    - Jika `fsva/` di Supabase sudah ada: jadikan Supabase sebagai sumber kebenaran
      (hapus file lokal yang sudah dihapus admin di Supabase, dan pastikan semua file
      di Supabase sudah terunduh secara lokal).
    """
    if not backend.get_supabase():
        print("[sync-fsva] Supabase belum dikonfigurasi, skip sync.")
        return

    try:
        remote_items = backend.supabase_storage_list("fsva") or []
    except Exception as e:
        print(f"[sync-fsva] Gagal list fsva/: {e}")
        return

    remote_csvs = {
        item["name"]
        for item in remote_items
        if item.get("name") and item["name"].lower().endswith(".csv")
    }

    os.makedirs(backend.DIR_FSVA, exist_ok=True)
    local_csvs = {
        f for f in os.listdir(backend.DIR_FSVA) if f.lower().endswith(".csv")
    }

    if not remote_csvs:
        print(f"[sync-fsva] Seed awal: mengunggah {len(local_csvs)} file FSVA dasar ke Supabase...")
        for fname in sorted(local_csvs):
            fpath = os.path.join(backend.DIR_FSVA, fname)
            with open(fpath, "rb") as f_in:
                backend.supabase_storage_upload(f"fsva/{fname}", f_in.read(), "text/csv")
        return

    # Hapus file lokal yang sudah dihapus admin di Supabase
    for fname in sorted(local_csvs - remote_csvs):
        fpath = os.path.join(backend.DIR_FSVA, fname)
        try:
            os.remove(fpath)
            print(f"[sync-fsva] Hapus lokal (sudah dihapus di Supabase): {fname}")
        except Exception as e:
            print(f"[sync-fsva] Gagal hapus {fname}: {e}")

    # Unduh file baru dari Supabase
    for fname in sorted(remote_csvs - local_csvs):
        try:
            data = backend.supabase_storage_download(f"fsva/{fname}")
            if data:
                with open(os.path.join(backend.DIR_FSVA, fname), "wb") as f_out:
                    f_out.write(data)
                print(f"[sync-fsva] Unduh dari Supabase: {fname}")
        except Exception as e:
            print(f"[sync-fsva] Gagal unduh {fname}: {e}")


def sync_uploads_with_supabase():
    """Pastikan folder uploads/* lokal persis sama dengan uploads/* di Supabase."""
    if not backend.get_supabase():
        return

    for key, local_dir in backend.DIR_UPLOADS.items():
        os.makedirs(local_dir, exist_ok=True)
        try:
            items = backend.supabase_storage_list(f"uploads/{key}") or []
        except Exception as e:
            print(f"[sync-uploads] Gagal list uploads/{key}: {e}")
            continue

        remote_csvs = {
            item["name"]
            for item in items
            if item.get("name") and item["name"].lower().endswith(".csv")
        }
        local_csvs = {f for f in os.listdir(local_dir) if f.lower().endswith(".csv")}

        for fname in local_csvs - remote_csvs:
            try:
                os.remove(os.path.join(local_dir, fname))
                print(f"[sync-uploads] Hapus lokal: uploads/{key}/{fname}")
            except Exception:
                pass

        for fname in remote_csvs - local_csvs:
            try:
                data = backend.supabase_storage_download(f"uploads/{key}/{fname}")
                if data:
                    with open(os.path.join(local_dir, fname), "wb") as f_out:
                        f_out.write(data)
                    print(f"[sync-uploads] Unduh dari Supabase: uploads/{key}/{fname}")
            except Exception as e:
                print(f"[sync-uploads] Gagal unduh uploads/{key}/{fname}: {e}")


def compute_predict_week_90_and_latest():
    """
    Hitung prediksi rolling 90 hari + data historis 90 hari terakhir untuk seluruh
    kombinasi (provinsi, komoditas).
    """
    df = backend.df
    features = backend.features
    model = backend.model

    predict_week_90 = {}
    latest_data = {}

    for prov_code, prov_name in backend.provinsi_map.items():
        for kom_code, kom_name in backend.komoditas_map.items():
            subset = df[(df["provinsi"] == prov_code) & (df["komoditas"] == kom_code)].sort_values("tanggal")
            if subset.empty:
                continue

            key = f"{prov_name.lower()}||{kom_name.lower()}"
            latest = subset.iloc[-1]

            # Data historis 90 hari terakhir (untuk /api/get-latest-data)
            tail90 = subset.tail(90)
            latest_data[key] = {
                "dates": tail90["tanggal"].dt.strftime("%Y-%m-%d").tolist(),
                "prices": [round(float(x), 2) if pd.notna(x) else 0.0 for x in tail90["harga"].tolist()],
                "produsen_prices": [
                    round(float(x), 2) if pd.notna(x) else 0.0
                    for x in tail90["harga_produsen"].tolist()
                ],
            }

            # Base features persis seperti endpoint /api/predict-week di backend.py
            base_features = {
                feat: (float(latest[feat]) if feat in latest.index and pd.notna(latest[feat]) else 0.0)
                for feat in features
            }

            price_window = [
                base_features.get("harga_harian_konsumen_lag_7", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_7", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_7", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_7", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_3", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_3", base_features.get("harga_harian_konsumen_lag_1", 0.0)),
                base_features.get("harga_harian_konsumen_lag_1", 0.0),
            ]
            prod_window = [
                base_features.get("harga_harian_produsen_lag_7", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_7", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_7", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_7", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_3", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_3", base_features.get("harga_harian_produsen_lag_1", 0.0)),
                base_features.get("harga_harian_produsen_lag_1", 0.0),
            ]

            base_date_dow = base_features.get("dayofweek", 0)
            base_date_woy = base_features.get("weekofyear", 1)
            base_month_sin = base_features.get("month_sin", 0)
            base_month_cos = base_features.get("month_cos", 1)

            # Prediksi hari ke-1 (untuk /api/predict)
            day1_input = pd.DataFrame([base_features])[features]
            day1_pred = round(float(model.predict(day1_input)[0]), 2)

            prices_90 = []
            for i in range(90):
                cf = base_features.copy()
                cf["harga_harian_konsumen_lag_1"] = price_window[-1]
                cf["harga_harian_konsumen_lag_3"] = price_window[-3]
                cf["harga_harian_konsumen_lag_7"] = price_window[-7] if len(price_window) >= 7 else price_window[0]
                cf["harga_harian__konsumen_ma_7"] = float(np.mean(price_window[-7:]))
                cf["harga_harian_produsen_lag_1"] = prod_window[-1]
                cf["harga_harian_produsen_lag_3"] = prod_window[-3]
                cf["harga_harian_produsen_lag_7"] = prod_window[-7] if len(prod_window) >= 7 else prod_window[0]
                cf["harga_harian__produsen_ma_7"] = float(np.mean(prod_window[-7:]))
                cf["std_7_harga"] = float(np.std(price_window[-7:]))
                cf["std_7_harga_produsen"] = float(np.std(prod_window[-7:]))

                cf["dayofweek"] = (base_date_dow + i + 1) % 7
                cf["weekofyear"] = base_date_woy + (base_date_dow + i + 1) // 7
                cf["month_sin"] = base_month_sin
                cf["month_cos"] = base_month_cos

                pred_price = float(model.predict(pd.DataFrame([cf])[features])[0])
                prices_90.append(round(pred_price, 2))

                price_window.append(pred_price)
                ratio = (prod_window[-1] / price_window[-2]) if price_window[-2] != 0 else 0.8
                prod_window.append(pred_price * ratio)

            predict_week_90[key] = {
                "provinsi": prov_name,
                "komoditas": kom_name,
                "last_data_date": latest["tanggal"].strftime("%Y-%m-%d"),
                "day1_prediction": day1_pred,
                "prices": prices_90,
            }

    return predict_week_90, latest_data


def build_admin_status():
    df = backend.df
    last_date = str(df["tanggal"].max().date()) if not df.empty else "—"
    total_rows = int(len(df))

    fsva_files = sorted([f for f in os.listdir(backend.DIR_FSVA) if f.lower().endswith(".csv")])
    last_year = "—"
    total_kab = 0
    if fsva_files:
        m = re.search(r"(\d{4})", fsva_files[-1])
        if m:
            last_year = m.group(1)
        try:
            total_kab = int(len(pd.read_csv(os.path.join(backend.DIR_FSVA, fsva_files[-1]))))
        except Exception:
            pass

    met = backend.saved_metrics or {}
    return {
        "status": "success",
        "last_harga_date": last_date,
        "total_harga_rows": total_rows,
        "last_fsva_year": last_year,
        "total_fsva_kab": total_kab,
        "model_mape": round(float(met.get("mape", 0)), 2),
        "model_r2": round(float(met.get("r2", 0)), 4),
    }


def main():
    local_only = "--local-only" in sys.argv
    t0 = time.time()

    if not local_only and not backend.get_supabase():
        print("ERROR: SUPABASE_URL dan SUPABASE_KEY wajib diisi di environment / .env!")
        sys.exit(1)

    print("=== [1/7] Sinkronisasi upload & FSVA dari Supabase Storage ===")
    if not local_only:
        sync_uploads_with_supabase()
        sync_fsva_with_supabase()

    print("=== [2/7] Memuat & memproses dataset terbaru ===")
    df_cached = backend.df
    df_new, kom_map, prov_map = backend.load_and_preprocess_data()
    if len(df_new) == 0 or (df_cached is not None and len(df_cached) > 0 and len(df_new) < len(df_cached) * 0.5):
        print(
            f"[WARN] load_and_preprocess_data() hanya menghasilkan {len(df_new)} baris "
            f"(cache parquet punya {len(df_cached) if df_cached is not None else 0} baris). "
            f"Menggunakan df_cache.parquet sebagai fallback."
        )
    else:
        backend.df = df_new
        backend.komoditas_map = kom_map
        backend.provinsi_map = prov_map
        backend.komoditas_list = list(kom_map.values())
        backend.provinsi_list = list(prov_map.values())
        backend.komoditas_name2code = {v: k for k, v in kom_map.items()}
        backend.provinsi_name2code = {v: k for k, v in prov_map.items()}
    print(f"Dataset aktif: {len(backend.df)} baris, {len(backend.provinsi_list)} provinsi, {len(backend.komoditas_list)} komoditas")
    if len(backend.df) == 0:
        print("ERROR: Dataset kosong (0 baris), membatalkan upload cache agar tidak menimpa data!")
        sys.exit(1)

    print("=== [3/7] Menghitung predict_all (heatmap 28 hari) ===")
    predict_all = {}
    for kom in backend.komoditas_list:
        predict_all[kom] = backend._compute_predict_all(kom, horizon=28)
        print(f"  - {kom}: {len(predict_all[kom])} provinsi")

    print("=== [4/7] Menghitung predict_week (1-90 hari) & data historis ===")
    predict_week_90, latest_data = compute_predict_week_90_and_latest()
    print(f"  - {len(predict_week_90)} kombinasi provinsi x komoditas selesai")
    if len(predict_week_90) == 0:
        print("ERROR: predict_week_90 kosong, membatalkan upload!")
        sys.exit(1)

    print("=== [5/7] Menghitung EWS horizon & DVI ===")
    backend._ews_cache = {}
    backend._compute_and_cache_ews()
    ews_horizon = {"status": "success", "data": backend._ews_cache}
    ews_dvi = {"status": "success", "data": backend._compute_dvi_per_provinsi()}

    print("=== [6/7] Menghitung FSVA nowcast ===")
    backend._fsva_cache = {}
    backend._build_fsva_cache()
    slim_fields = {
        "Kabupaten", "Provinsi", "nowcast_score", "fsva_score",
        "delta", "nowcast_kelas", "kelas", "delta_breakdown",
    }
    slim_cache = {
        str(tahun): [
            {k: v for k, v in rec.items() if k in slim_fields}
            for rec in records
        ]
        for tahun, records in backend._fsva_cache.items()
    }
    fsva_data = {"status": "success", "data": slim_cache}

    model_info = {
        "status": "success",
        "features_count": len(backend.features),
        "features": backend.features[:10],
        "komoditas_list": backend.komoditas_list,
        "provinsi_list": backend.provinsi_list,
        "komoditas_map": {v: k for k, v in backend.komoditas_map.items()},
        "provinsi_map": {v: k for k, v in backend.provinsi_map.items()},
    }
    metrics = {
        "status": "success",
        "rmse": backend.saved_metrics.get("rmse", 0),
        "mae": backend.saved_metrics.get("mae", 0),
        "mape": backend.saved_metrics.get("mape", 0),
        "r2": backend.saved_metrics.get("r2", 0),
    }
    admin_status = build_admin_status()
    version_info = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "version": int(time.time()),
    }

    payloads = {
        "cache/model_info.json": model_info,
        "cache/metrics.json": metrics,
        "cache/predict_all.json": predict_all,
        "cache/predict_week_90.json": predict_week_90,
        "cache/latest_data.json": latest_data,
        "cache/ews_horizon.json": ews_horizon,
        "cache/ews_dvi.json": ews_dvi,
        "cache/fsva_data.json": fsva_data,
        "cache/admin_status.json": admin_status,
        "cache/version.json": version_info,
    }

    print("=== [7/7] Mengunggah cache JSON ke Supabase Storage ===")
    for remote_path, obj in payloads.items():
        raw = _json_bytes(obj)
        size_kb = len(raw) / 1024
        if local_only:
            out_path = os.path.join(BASE_DIR, "local_cache_preview", remote_path)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with open(out_path, "wb") as f_out:
                f_out.write(raw)
            print(f"  [local] {remote_path} ({size_kb:.1f} KB)")
        else:
            backend.supabase_storage_upload(remote_path, raw, "application/json")
            print(f"  [uploaded] {remote_path} ({size_kb:.1f} KB)")

    print(f"SELESAI dalam {time.time() - t0:.1f} detik!")


if __name__ == "__main__":
    main()
