#!/usr/bin/env bash
# Construye la imagen del backend en Cloud Build y la despliega en Cloud Run.
# Uso: ./deploy.sh   (desde cualquier carpeta)
# Usa siempre la cuenta y el proyecto de abajo, sin cambiar la configuración global de gcloud.
set -euo pipefail

ACCOUNT="pablodelhip@gmail.com"
PROJECT="n8ninttesi"
IMAGE="us-central1-docker.pkg.dev/${PROJECT}/kikovo/kikovo-api:latest"
SERVICE="kikovo-api"
REGION="us-central1"
GCLOUD=(gcloud --account="$ACCOUNT" --project="$PROJECT")

cd "$(dirname "$0")"

# Si las credenciales de la cuenta vencieron, se renuevan en el navegador (sin contraseña en la terminal).
if ! "${GCLOUD[@]}" auth print-access-token >/dev/null 2>&1; then
  echo "==> Las credenciales de $ACCOUNT vencieron: se abrirá el navegador para iniciar sesión"
  gcloud auth login "$ACCOUNT"
fi

echo "==> Construyendo y subiendo la imagen: $IMAGE"
"${GCLOUD[@]}" builds submit --tag "$IMAGE" .

echo "==> Desplegando $SERVICE en Cloud Run ($REGION)"
"${GCLOUD[@]}" run deploy "$SERVICE" --image "$IMAGE" --region "$REGION"

echo "==> Listo"
