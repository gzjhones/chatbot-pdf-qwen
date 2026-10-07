#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Revisor ortográfico de PDF — arranque en un Pod de RunPod
#
# Antes de crear el Pod:
#   • Plantilla: "RunPod PyTorch" (o cualquier Ubuntu con CUDA)
#   • Expose HTTP Ports: 5050      ← imprescindible
#   • Volume mount path: /workspace (los modelos persisten entre reinicios)
#   • (Opcional) Environment Variables: API_KEY=tu-clave  MODEL_NAME=qwen3:1.7b
#
# En la terminal web del Pod:
#   cd /workspace && git clone -b revisor_ortografico https://github.com/gzjhones/chatbot-pdf-qwen.git
#   cd chatbot-pdf-qwen && bash deploy/start_runpod.sh
#
# Prompt: edita /workspace/chatbot-pdf-qwen/prompt.txt (se aplica sin reiniciar)
#
# URL pública resultante:  https://<RUNPOD_POD_ID>-5050.proxy.runpod.net
# ─────────────────────────────────────────────────────────────────────
set -e

MODEL_NAME="${MODEL_NAME:-qwen3:1.7b}"
PORT="${PORT:-5050}"
API_KEY="${API_KEY:-}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Modelos de Ollama dentro del volumen persistente
export OLLAMA_MODELS=/workspace/ollama-models
mkdir -p "$OLLAMA_MODELS"

# 1. Dependencias
apt-get -qq update && apt-get -qq install -y curl zstd pciutils > /dev/null
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
pip install -q flask flask-cors pymupdf requests

# 2. Ollama en segundo plano (no hay systemd en el Pod)
if ! curl -s localhost:11434/api/tags >/dev/null; then
  nohup ollama serve > /workspace/ollama.log 2>&1 &
  for i in $(seq 1 30); do curl -s localhost:11434/api/tags >/dev/null && break; sleep 1; done
fi
ollama pull "$MODEL_NAME"

# 3. Flask en segundo plano, escuchando en 0.0.0.0:$PORT
pkill -f "server/app.py" 2>/dev/null || true
cd "$PROJECT_DIR"
MODEL_NAME="$MODEL_NAME" PORT="$PORT" API_KEY="$API_KEY" \
  nohup python server/app.py > /workspace/flask.log 2>&1 &
sleep 3

echo
echo "Health local:"
curl -s -H "X-API-Key: $API_KEY" "localhost:$PORT/health"; echo
echo
PUBLIC="https://${RUNPOD_POD_ID:-<POD_ID>}-${PORT}.proxy.runpod.net"
echo "URL pública : $PUBLIC"
echo "Abre en tu PC: interface/index.html?api=$PUBLIC${API_KEY:+&key=$API_KEY}"
echo "Logs        : tail -f /workspace/flask.log /workspace/ollama.log"
