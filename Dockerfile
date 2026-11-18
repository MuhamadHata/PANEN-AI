FROM python:3.12-slim

# libgomp1 wajib untuk runtime OpenMP milik XGBoost di Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces menjalankan container sebagai non-root user (UID 1000)
RUN useradd -m -u 1000 user

WORKDIR /app

COPY --chown=user:user requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=user:user . .

# Pastikan folder dataset & upload dapat ditulis oleh user 1000
RUN mkdir -p \
    Dataset/harga \
    Dataset/kabupaten \
    Dataset/hujan \
    Dataset/prediksi/uploads/cabai \
    Dataset/prediksi/uploads/ayam \
    Dataset/prediksi/uploads/sapi \
    Dataset/prediksi/uploads/telur \
    Dataset/prediksi/uploads/hujan \
    && chown -R user:user /app

USER user

ENV PYTHONUNBUFFERED=1
ENV PORT=7860

EXPOSE 7860

CMD ["gunicorn", "backend:app", "--workers", "1", "--threads", "4", "--timeout", "180", "--bind", "0.0.0.0:7860"]
