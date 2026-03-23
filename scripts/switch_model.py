#!/usr/bin/env python3
"""
Cambia el modelo activo en config.json verificando que Ollama esté
corriendo y que el modelo esté disponible localmente.

Uso:
    python scripts/switch_model.py qwen3:1.7b
    python scripts/switch_model.py llama3:8b
"""

import sys
import os
import json

import requests

# ---------------------------------------------------------------------------
# Argumentos
# ---------------------------------------------------------------------------
if len(sys.argv) < 2:
    print("Uso: python scripts/switch_model.py <nombre-modelo>")
    print("Ejemplos:")
    print("  python scripts/switch_model.py qwen3:1.7b")
    print("  python scripts/switch_model.py llama3:8b")
    sys.exit(1)

nuevo_modelo = sys.argv[1].strip()

# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(PROJECT_DIR, "config.json")

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    config = json.load(f)

OLLAMA_URL = config.get("ollama_url", "http://localhost:11434")

# ---------------------------------------------------------------------------
# 1. Verificar que Ollama está corriendo
# ---------------------------------------------------------------------------
print(f"[INFO] Verificando Ollama en {OLLAMA_URL}…")
try:
    r = requests.get(OLLAMA_URL + "/api/tags", timeout=5)
    r.raise_for_status()
    modelos_disponibles = [m["name"] for m in r.json().get("models", [])]
except requests.exceptions.ConnectionError:
    print(f"[ERROR] No se puede conectar a Ollama en {OLLAMA_URL}")
    print("        Asegúrate de que Ollama está corriendo: ollama serve")
    sys.exit(1)
except Exception as exc:
    print(f"[ERROR] Respuesta inesperada de Ollama: {exc}")
    sys.exit(1)

print(f"[OK]   Ollama responde. Modelos disponibles: {len(modelos_disponibles)}")

# ---------------------------------------------------------------------------
# 2. Verificar que el modelo está disponible
# ---------------------------------------------------------------------------
# Ollama permite coincidir sin el tag :latest implícito
def model_matches(available: list, target: str) -> bool:
    for m in available:
        if m == target:
            return True
        # "qwen3:0.6b" coincide con "qwen3:0.6b" pero también
        # "qwen3" con "qwen3:latest"
        if ":" not in target and m.split(":")[0] == target:
            return True
    return False

if not model_matches(modelos_disponibles, nuevo_modelo):
    print(f"[WARN] El modelo '{nuevo_modelo}' no está en Ollama.")
    print(f"       Modelos disponibles: {modelos_disponibles}")
    print(f"\n       Para descargarlo ejecuta:")
    print(f"           ollama pull {nuevo_modelo}")
    respuesta = input("\n¿Descargar ahora? [s/N] ").strip().lower()
    if respuesta == "s":
        import subprocess
        print(f"[INFO] Descargando {nuevo_modelo}…")
        result = subprocess.run(["ollama", "pull", nuevo_modelo])
        if result.returncode != 0:
            print("[ERROR] La descarga falló.")
            sys.exit(1)
        print(f"[OK]   Modelo descargado.")
    else:
        print("[ABORT] Operación cancelada.")
        sys.exit(1)
else:
    print(f"[OK]   Modelo '{nuevo_modelo}' disponible en Ollama.")

# ---------------------------------------------------------------------------
# 3. Actualizar config.json
# ---------------------------------------------------------------------------
modelo_anterior = config.get("model_name", "(ninguno)")
config["model_name"] = nuevo_modelo

with open(CONFIG_PATH, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"\n[OK]   config.json actualizado:")
print(f"       {modelo_anterior}  →  {nuevo_modelo}")
print()
print("El servidor Flask lee config.json en cada request.")
print("No necesitas reiniciarlo para que el cambio tenga efecto.")
