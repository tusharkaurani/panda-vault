# --- Stage 1: build the Vite/React/Tailwind SPA -----------------------------
FROM node:20-slim AS frontend-build

WORKDIR /frontend

COPY frontend/package.json ./
RUN npm install

COPY frontend/ .
RUN npm run build

# --- Stage 2: Python runtime -------------------------------------------------
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY --from=frontend-build /frontend/dist ./static

EXPOSE 8811

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8811"]
