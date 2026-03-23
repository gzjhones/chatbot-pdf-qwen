# PDF Analyzer — versión Ollama

Análisis inteligente de documentos PDF usando modelos locales a través de **Ollama**.
Sin `transformers`, sin `torch`, sin API keys externas.

---

## Estructura

```
pdf-analyzer-vOllama/
├── config.json              ← modelo activo y parámetros
├── server/
│   └── app.py               ← servidor Flask (puerto 5050)
├── interface/
│   └── index.html           ← interfaz web standalone + embebible
├── notebook/
│   └── analyzer.ipynb       ← Jupyter Notebook
├── scripts/
│   └── switch_model.py      ← cambia de modelo verificando Ollama
└── README.md
```

---

## Requisitos

### 1. Ollama

Instala Ollama desde [https://ollama.com](https://ollama.com) y arráncalo:

```bash
ollama serve
```

### 2. Entorno Python

```bash
conda create -n chatbot-pdf python=3.10 -y
conda activate chatbot-pdf
pip install flask flask-cors pymupdf requests
```

> No se necesita PyTorch ni CUDA. El modelo corre dentro de Ollama.

---

## Inicio rápido

### Paso 1 — Descargar un modelo en Ollama

```bash
ollama pull qwen3:0.6b
```

Otros modelos recomendados:

```bash
ollama pull qwen3:1.7b
ollama pull qwen3:4b
ollama pull llama3:8b
ollama pull mistral:7b
ollama pull phi3:mini
```

### Paso 2 — Configurar `config.json`

```json
{
  "model_name": "qwen3:0.6b",
  "ollama_url": "http://localhost:11434",
  "max_tokens": 1024,
  "temperature": 0.7
}
```

| Campo | Descripción |
|---|---|
| `model_name` | Nombre exacto del modelo en Ollama |
| `ollama_url` | URL del servidor Ollama |
| `max_tokens` | Tokens máximos en la respuesta |
| `temperature` | Creatividad (0 = determinista, 1 = creativo) |

### Paso 3 — Arrancar el servidor Flask

```bash
conda activate chatbot-pdf
cd pdf-analyzer-vOllama
python server/app.py
```

Verifica que funciona:

```bash
curl http://localhost:5050/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "modelo": "qwen3:0.6b",
  "ollama_ok": true,
  "modelos_disponibles": ["qwen3:0.6b", ...]
}
```

### Paso 4 — Usar la interfaz web

Abre `interface/index.html` directamente en el navegador.

1. La barra de estado muestra si Ollama responde y qué modelo está activo
2. Arrastra un PDF o haz clic para seleccionar
3. Pulsa **Analizar documento**
4. Los resultados aparecen en tres tarjetas: Objetivos, Conclusiones, Valoración

#### Embeber en otra página

```html
<iframe src="interface/index.html" width="800" height="900" frameborder="0"></iframe>
```

---

## API REST

### `POST /analyze`

```bash
# Convierte el PDF a base64 y envía
B64=$(base64 -w0 mi_documento.pdf)
curl -X POST http://localhost:5050/analyze \
  -H "Content-Type: application/json" \
  -d "{\"pdf_base64\": \"$B64\"}"
```

**Respuesta:**
```json
{
  "objetivos":      "...",
  "conclusiones":   "...",
  "valoracion":     "★★★★☆ ...",
  "texto_completo": "...",
  "modelo_usado":   "qwen3:0.6b"
}
```

### `GET /health`

```json
{
  "status": "ok",
  "modelo": "qwen3:0.6b",
  "ollama_ok": true,
  "modelos_disponibles": ["qwen3:0.6b", "llama3:8b"]
}
```

---

## Cambiar de modelo

### Opción A — Script (recomendada)

```bash
python scripts/switch_model.py qwen3:1.7b
```

El script:
- Verifica que Ollama está corriendo
- Verifica que el modelo existe (y ofrece descargarlo si no)
- Actualiza `config.json`
- **No es necesario reiniciar el servidor Flask** (lee config en cada request)

### Opción B — Manual

Edita `config.json` y cambia `model_name`:
```json
{ "model_name": "llama3:8b" }
```

### Opción C — Desde el notebook

```python
change_model("qwen3:1.7b")
```

---

## Notebook Jupyter

```bash
conda activate chatbot-pdf
jupyter notebook notebook/analyzer.ipynb
```

| Celda | Contenido |
|---|---|
| 1 | Imports, lectura de `config.json`, verificación de Ollama |
| 2 | `master_prompt` configurable |
| 3 | `analyze_pdf(pdf_path)` — llama directamente a Ollama |
| 4 | `change_model(nombre)` — cambia sin reiniciar el kernel |
| 5 | `start_server()` — lanza Flask en background |
| 6 | Ejemplo de uso y benchmark comparativo entre modelos |

---

## Diferencias con pdf-analyzer (versión Transformers)

| Característica | `pdf-analyzer` (Transformers) | `pdf-analyzer-vOllama` |
|---|---|---|
| Requiere GPU | Opcional (más rápido con GPU) | No (Ollama lo gestiona) |
| Descarga modelos | Manual a `./models/` | `ollama pull <modelo>` |
| RAM al arrancar | Carga modelo en Python | Ollama gestiona la memoria |
| Cambio de modelo | Reinicia el kernel o usa `change_model()` | Solo actualiza `config.json` |
| Dependencias | transformers, torch, etc. | flask, pymupdf, requests |
| Múltiples clientes | Un modelo cargado en memoria | Ollama gestiona la cola |

---

## Solución de problemas

### `No se puede conectar a Ollama`
```bash
ollama serve   # en otra terminal
```

### `El modelo 'X' no está disponible`
```bash
ollama pull qwen3:0.6b
ollama list    # ver modelos descargados
```

### `Error 404 de Ollama`
El nombre del modelo debe coincidir exactamente con `ollama list`.
Ejemplo: `qwen3:0.6b`, no `qwen3-0.6b`.

### CORS error en el navegador
El servidor Flask ya tiene CORS habilitado para todos los orígenes.
Asegúrate de que `python server/app.py` está corriendo.

### Respuesta muy corta o truncada
Aumenta `max_tokens` en `config.json` (ej: `2048`).
