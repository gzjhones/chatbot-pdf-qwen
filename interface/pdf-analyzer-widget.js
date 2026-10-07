/**
 * pdf-analyzer-widget.js
 * Widget embebible: revisor ortográfico de PDFs con Ollama.
 * Uso: <script src="pdf-analyzer-widget.js"></script>
 */
(function () {
  'use strict';

  /* ── Servidor remoto configurable ───────────────────────────────
     Prioridad: ?api=URL en la barra de direcciones  →
                data-api-base en el <script>         →
                window.PDF_ANALYZER_API              →
                http://localhost:5050
     Ejemplos:
       index.html?api=https://xxxx.trycloudflare.com        (Colab)
       index.html?api=https://PODID-5050.proxy.runpod.net   (RunPod)
  ─────────────────────────────────────────────────────────────── */
  const SCRIPT_TAG = document.currentScript;
  const QS = new URLSearchParams(window.location.search);
  const API_BASE = (
    QS.get('api') ||
    (SCRIPT_TAG && SCRIPT_TAG.dataset.apiBase) ||
    window.PDF_ANALYZER_API ||
    'http://localhost:5050'
  ).replace(/\/+$/, '');
  const API_KEY = QS.get('key') ||
    (SCRIPT_TAG && SCRIPT_TAG.dataset.apiKey) ||
    window.PDF_ANALYZER_KEY || '';

  const API_URL    = API_BASE + '/analyze';
  const HEALTH_URL = API_BASE + '/health';

  /* Cabeceras comunes. 'ngrok-skip-browser-warning' evita la página
     intermedia de ngrok gratuito; otros proxies la ignoran. */
  function apiHeaders(extra) {
    const h = Object.assign({ 'ngrok-skip-browser-warning': '1' }, extra || {});
    if (API_KEY) h['X-API-Key'] = API_KEY;
    return h;
  }

  /* ══════════════════════════════════════════════════════════════════
     CSS (inyectado en Shadow DOM — no afecta a la página huésped)
  ══════════════════════════════════════════════════════════════════ */
  const STYLES = `
    /* ── Reset ────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── Variables ────────────────────────────────────────────── */
    :host {
      --bg:       #ffffff;
      --bg2:      #f6f8fa;
      --bg3:      #eef1f5;
      --border:   #d0d7de;
      --accent:   #1a56db;
      --accent-h: #1e429f;
      --green:    #0f7b3e;
      --red:      #cf222e;
      --text:     #1f2328;
      --muted:    #57606a;
      --radius:   12px;
      --shadow:   0 8px 32px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.10);
    }

    /* ── Panel container ──────────────────────────────────────── */
    .panel {
      display: flex;
      flex-direction: column;
      width: 380px;
      height: 520px;
      background: var(--bg);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      color: var(--text);
      transition: width .3s cubic-bezier(.4,0,.2,1),
                  height .3s cubic-bezier(.4,0,.2,1);
    }
    .panel.expanded {
      width: 720px;
      height: 85vh;
    }

    /* ── Header ───────────────────────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      background: var(--accent);
      color: #fff;
      flex-shrink: 0;
      user-select: none;
    }
    .header-icon { font-size: 18px; }
    .header-title {
      font-weight: 700;
      font-size: 15px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header-btn {
      background: rgba(255,255,255,.18);
      border: none;
      border-radius: 6px;
      color: #fff;
      width: 28px;
      height: 28px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      transition: background .15s;
      flex-shrink: 0;
    }
    .header-btn:hover { background: rgba(255,255,255,.32); }

    /* ── Body (scrollable) ────────────────────────────────────── */
    .body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .body::-webkit-scrollbar { width: 6px; }
    .body::-webkit-scrollbar-track { background: transparent; }
    .body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* ── Status strip ─────────────────────────────────────────── */
    .status-strip {
      display: flex;
      align-items: center;
      gap: 7px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 11px;
      font-size: 12px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .dot.ok    { background: var(--green); animation: pulse 2s infinite; }
    .dot.error { background: var(--red); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    .status-model {
      margin-left: auto;
      font-weight: 600;
      color: var(--accent);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }

    /* ── Drop zone ────────────────────────────────────────────── */
    .drop-zone {
      border: 2px dashed var(--border);
      border-radius: 10px;
      background: var(--bg2);
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      transition: border-color .2s, background .2s;
      position: relative;
      flex-shrink: 0;
    }
    .drop-zone.dragover {
      border-color: var(--accent);
      background: rgba(26,86,219,.06);
    }
    .drop-zone input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }
    .drop-icon { font-size: 2rem; margin-bottom: 6px; }
    .drop-title { font-weight: 600; font-size: 13px; color: var(--text); }
    .drop-sub   { font-size: 11px; color: var(--muted); margin-top: 3px; }
    .file-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      margin-top: 10px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      color: var(--green);
      font-weight: 600;
      max-width: 100%;
    }
    .file-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Error inline ─────────────────────────────────────────── */
    .inline-error {
      background: #fff0f0;
      border: 1px solid #ffc8c8;
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--red);
      font-size: 12px;
    }

    /* ── Button ───────────────────────────────────────────────── */
    .btn {
      width: 100%;
      padding: 10px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: filter .15s, transform .1s;
      flex-shrink: 0;
    }
    .btn:active { transform: scale(.98); }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn-primary {
      background: var(--accent);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
    .btn-ghost {
      background: var(--bg2);
      border: 1px solid var(--border);
      color: var(--muted);
      font-weight: 600;
    }
    .btn-ghost:hover:not(:disabled) { background: var(--bg3); }

    /* ── Spinner ──────────────────────────────────────────────── */
    .spinner-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 24px 0;
    }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner-label { color: var(--muted); font-size: 12px; }

    /* ── Results ──────────────────────────────────────────────── */
    .model-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
    }
    .cards { display: flex; flex-direction: column; gap: 10px; }
    .card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .card-icon { font-size: 16px; }
    .card-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .07em;
      color: var(--muted);
    }
    .card-body {
      font-size: 12.5px;
      line-height: 1.7;
      color: var(--text);
    }
    .card-body h2, .card-body h3, .card-body h4 {
      font-weight: 700;
      margin-bottom: 6px;
      line-height: 1.3;
      color: var(--text);
    }
    .card-body h2 { font-size: 14px; }
    .card-body h3 { font-size: 13px; }
    .card-body h4 { font-size: 12.5px; }
    .card-body ul {
      padding-left: 16px;
      margin: 6px 0;
      list-style: disc;
    }
    .card-body li {
      margin-bottom: 4px;
      line-height: 1.6;
    }
    .card-body hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 8px 0;
    }
    .card-body strong { color: var(--text); }
    .card-body p { margin-bottom: 6px; }
    .card-body p:last-child { margin-bottom: 0; }
    .stars { font-size: 18px; color: #d29922; letter-spacing: 2px; margin-bottom: 4px; }

    /* ── Raw text toggle ──────────────────────────────────────── */
    details {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      font-size: 12px;
    }
    summary {
      padding: 7px 12px;
      background: var(--bg2);
      cursor: pointer;
      color: var(--muted);
      user-select: none;
    }
    summary:hover { color: var(--text); }
    .raw-text {
      padding: 10px 12px;
      font-family: monospace;
      font-size: 11px;
      color: var(--muted);
      white-space: pre-wrap;
      max-height: 180px;
      overflow-y: auto;
      background: var(--bg);
    }

    /* ── Utility ──────────────────────────────────────────────── */
    .hidden { display: none !important; }
    .sep { border: none; border-top: 1px solid var(--border); margin: 0; }
  `;

  /* ══════════════════════════════════════════════════════════════════
     HTML interno del panel
  ══════════════════════════════════════════════════════════════════ */
  const PANEL_HTML = `
    <div class="panel" id="panel">

      <!-- Header -->
      <div class="header">
        <span class="header-icon">📄</span>
        <span class="header-title">Revisor ortográfico</span>
        <button class="header-btn" id="btnExpand" title="Expandir / Compactar">⤢</button>
        <button class="header-btn" id="btnClose"  title="Cerrar">✕</button>
      </div>

      <!-- Body -->
      <div class="body" id="body">

        <!-- Status -->
        <div class="status-strip" id="statusStrip">
          <span class="dot" id="statusDot"></span>
          <span id="statusText">Comprobando servidor…</span>
          <span class="status-model hidden" id="statusModel"></span>
        </div>

        <!-- Drop zone -->
        <div class="drop-zone" id="dropZone">
          <input type="file" id="fileInput" accept=".pdf" />
          <div class="drop-icon">📂</div>
          <div class="drop-title">Arrastra tu PDF aquí</div>
          <div class="drop-sub">o haz clic para seleccionar</div>
          <div class="file-chip hidden" id="fileChip">
            📎 <span id="chipName"></span>
          </div>
        </div>

        <!-- Inline error -->
        <div class="inline-error hidden" id="inlineError"></div>

        <!-- Analyze button -->
        <button class="btn btn-primary hidden" id="btnAnalyze">
          🔍 Revisar ortografía
        </button>

        <!-- Spinner -->
        <div class="spinner-wrap hidden" id="spinner">
          <div class="spinner"></div>
          <span class="spinner-label" id="spinnerLabel">Enviando a Ollama…</span>
        </div>

        <!-- Results -->
        <div class="hidden" id="results">
          <div class="model-badge" id="modelBadge">
            <span class="dot ok"></span>
            <span id="modelName">—</span>
          </div>

          <hr class="sep" style="margin: 10px 0">

          <div class="cards">

            <div class="card">
              <div class="card-header">
                <span class="card-icon">❌</span>
                <span class="card-label">Errores encontrados</span>
              </div>
              <div class="card-body" id="cardObjetivos"></div>
            </div>

            <div class="card">
              <div class="card-header">
                <span class="card-icon">✏️</span>
                <span class="card-label">Oraciones corregidas</span>
              </div>
              <div class="card-body" id="cardConclusiones"></div>
            </div>

            <div class="card">
              <div class="card-header">
                <span class="card-icon">⭐</span>
                <span class="card-label">Valoración ortográfica</span>
              </div>
              <div class="card-body">
                <div class="stars" id="starsRow"></div>
                <div id="cardValoracion"></div>
              </div>
            </div>

          </div><!-- /cards -->

          <details style="margin-top:10px">
            <summary>📋 Ver texto extraído</summary>
            <div class="raw-text" id="rawText"></div>
          </details>

          <button class="btn btn-ghost" id="btnReset" style="margin-top:10px">
            ↩ Revisar otro PDF
          </button>
        </div><!-- /results -->

      </div><!-- /body -->
    </div><!-- /panel -->
  `;

  /* ══════════════════════════════════════════════════════════════════
     CSS del botón flotante (va en el documento principal, mínimo)
  ══════════════════════════════════════════════════════════════════ */
  const FAB_STYLES = `
    #pdf-analyzer-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #1a56db;
      color: #fff;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 4px 18px rgba(26,86,219,.45);
      transition: transform .2s, box-shadow .2s;
      z-index: 2147483646;
    }
    #pdf-analyzer-fab:hover {
      transform: scale(1.09);
      box-shadow: 0 6px 24px rgba(26,86,219,.6);
    }
    #pdf-analyzer-fab:active { transform: scale(.96); }

    #pdf-analyzer-host {
      position: fixed;
      bottom: 92px;
      right: 24px;
      z-index: 2147483647;
      display: none;
    }
    #pdf-analyzer-host.open { display: block; }
  `;

  /* ══════════════════════════════════════════════════════════════════
     Inicialización
  ══════════════════════════════════════════════════════════════════ */
  function init() {
    /* Inyecta CSS del FAB en <head> */
    const fabStyle = document.createElement('style');
    fabStyle.textContent = FAB_STYLES;
    document.head.appendChild(fabStyle);

    /* Botón flotante */
    const fab = document.createElement('button');
    fab.id = 'pdf-analyzer-fab';
    fab.title = 'Abrir analizador de PDF';
    fab.innerHTML = '📄';
    document.body.appendChild(fab);

    /* Shadow host */
    const host = document.createElement('div');
    host.id = 'pdf-analyzer-host';
    document.body.appendChild(host);

    /* Shadow DOM */
    const shadow = host.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    shadow.appendChild(styleEl);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = PANEL_HTML;
    shadow.appendChild(wrapper);

    /* ── Referencias a elementos del shadow ── */
    const panel         = shadow.getElementById('panel');
    const btnExpand     = shadow.getElementById('btnExpand');
    const btnClose      = shadow.getElementById('btnClose');
    const statusDot     = shadow.getElementById('statusDot');
    const statusText    = shadow.getElementById('statusText');
    const statusModel   = shadow.getElementById('statusModel');
    const dropZone      = shadow.getElementById('dropZone');
    const fileInput     = shadow.getElementById('fileInput');
    const fileChip      = shadow.getElementById('fileChip');
    const chipName      = shadow.getElementById('chipName');
    const inlineError   = shadow.getElementById('inlineError');
    const btnAnalyze    = shadow.getElementById('btnAnalyze');
    const spinner       = shadow.getElementById('spinner');
    const spinnerLabel  = shadow.getElementById('spinnerLabel');
    const results       = shadow.getElementById('results');
    const modelName     = shadow.getElementById('modelName');
    const starsRow      = shadow.getElementById('starsRow');
    const cardObjetivos = shadow.getElementById('cardObjetivos');
    const cardConclus   = shadow.getElementById('cardConclusiones');
    const cardValoracion= shadow.getElementById('cardValoracion');
    const rawText       = shadow.getElementById('rawText');
    const btnReset      = shadow.getElementById('btnReset');

    let selectedFile = null;
    let expanded     = false;

    /* ── Abrir / cerrar ────────────────────────────────────────── */
    fab.addEventListener('click', () => {
      const isOpen = host.classList.contains('open');
      host.classList.toggle('open', !isOpen);
      fab.innerHTML = isOpen ? '📄' : '✕';
      if (!isOpen) checkHealth();
    });

    btnClose.addEventListener('click', () => {
      host.classList.remove('open');
      fab.innerHTML = '📄';
    });

    /* ── Expandir / compactar ──────────────────────────────────── */
    btnExpand.addEventListener('click', () => {
      expanded = !expanded;
      panel.classList.toggle('expanded', expanded);
      btnExpand.textContent = expanded ? '⤡' : '⤢';
      btnExpand.title = expanded ? 'Compactar' : 'Expandir';
      /* Reposiciona el host cuando se expande para que no se salga */
      host.style.right = expanded ? '24px' : '24px';
    });

    /* ── Health check ──────────────────────────────────────────── */
    async function checkHealth() {
      statusDot.className = 'dot';
      statusText.textContent = 'Comprobando servidor…';
      statusModel.classList.add('hidden');
      try {
        const r = await fetch(HEALTH_URL,
          { headers: apiHeaders(), signal: AbortSignal.timeout(15000) });
        const d = await r.json();
        if (d.ollama_ok) {
          statusDot.className = 'dot ok';
          statusText.textContent = 'Ollama conectado';
        } else {
          statusDot.className = 'dot error';
          statusText.textContent = 'Ollama no responde';
        }
        statusModel.textContent = '🦙 ' + (d.modelo || '—');
        statusModel.classList.remove('hidden');
      } catch {
        statusDot.className = 'dot error';
        statusText.textContent = 'Servidor no disponible';
      }
    }

    /* ── Drag & drop ────────────────────────────────────────────── */
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () =>
      dropZone.classList.remove('dragover'));

    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      validateAndSet(file);
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) validateAndSet(fileInput.files[0]);
    });

    /* ── Validación de archivo ────────────────────────────────── */
    function validateAndSet(file) {
      hideError();
      if (!file) return;

      /* Valida por tipo MIME y por extensión */
      const isPdf = file.type === 'application/pdf'
                 || file.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        showError('Solo se admiten archivos PDF');
        return;
      }

      selectedFile = file;
      chipName.textContent = file.name;
      fileChip.classList.remove('hidden');
      btnAnalyze.classList.remove('hidden');
      results.classList.add('hidden');
    }

    /* ── Analizar ────────────────────────────────────────────── */
    btnAnalyze.addEventListener('click', async () => {
      if (!selectedFile) return;
      setLoading(true, 'Leyendo PDF…');
      hideError();
      results.classList.add('hidden');

      try {
        const b64 = await toBase64(selectedFile);
        setLoading(true, 'Enviando a Ollama…');

        const res = await fetch(API_URL, {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ pdf_base64: b64 }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        /* El servidor responde con un job_id; consultamos el avance */
        const { job_id } = await res.json();
        renderResults(await waitForJob(job_id));

      } catch (err) {
        showError('Error: ' + err.message);
      } finally {
        setLoading(false);
      }
    });

    /* ── Reset ───────────────────────────────────────────────── */
    btnReset.addEventListener('click', () => {
      selectedFile = null;
      fileInput.value = '';
      fileChip.classList.add('hidden');
      btnAnalyze.classList.add('hidden');
      results.classList.add('hidden');
      hideError();
      checkHealth();
    });

    /* ── Polling del trabajo en el servidor ──────────────────── */
    async function waitForJob(jobId) {
      const url = API_BASE + '/jobs/' + jobId;
      let fallos = 0;
      while (true) {
        await new Promise(r => setTimeout(r, 2000));
        let d;
        try {
          const r = await fetch(url, { headers: apiHeaders() });
          d = await r.json();
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          fallos = 0;
        } catch (e) {
          if (++fallos >= 5) throw e;          // tolera cortes breves del túnel
          continue;
        }
        if (d.estado === 'listo') return d.resultado;
        if (d.estado === 'error') throw new Error(d.error);
        setLoading(true, d.total
          ? `Revisando bloque ${d.progreso} de ${d.total}…`
          : 'Extrayendo texto…');
      }
    }

    /* ── Helpers ─────────────────────────────────────────────── */
    function toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function setLoading(on, label = '') {
      btnAnalyze.disabled = on;
      spinner.classList.toggle('hidden', !on);
      if (label) spinnerLabel.textContent = label;
    }

    function showError(msg) {
      inlineError.textContent = '⚠️ ' + msg;
      inlineError.classList.remove('hidden');
    }
    function hideError() { inlineError.classList.add('hidden'); }

    function extractStars(text) {
      const m = text.match(/([1-5])\s*(?:\/\s*5|\s*estrellas?)/i)
             || text.match(/(★+)/);
      if (!m) return 0;
      return m[1] && m[1].startsWith('★') ? m[1].length : parseInt(m[1], 10);
    }

    /* ── parseMarkdown ───────────────────────────────────────── */
    function parseMarkdown(text) {
      if (!text) return '<p>—</p>';

      const lines  = text.split('\n');
      const output = [];
      let listOpen = false;

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        /* Escapa HTML para evitar XSS antes de insertar etiquetas */
        const safe = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        /* Inline: **bold** y __bold__ */
        const inlined = safe
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/__(.+?)__/g,     '<strong>$1</strong>');

        /* Separador horizontal */
        if (/^---+$/.test(line.trim())) {
          if (listOpen) { output.push('</ul>'); listOpen = false; }
          output.push('<hr>');
          continue;
        }

        /* Encabezados ### ## # */
        const hMatch = inlined.match(/^(#{1,3})\s+(.+)/);
        if (hMatch) {
          if (listOpen) { output.push('</ul>'); listOpen = false; }
          const level = hMatch[1].length;          // 1 → h2, 2 → h3, 3 → h4
          const tag   = `h${level + 1}`;
          output.push(`<${tag}>${hMatch[2]}</${tag}>`);
          continue;
        }

        /* Ítems de lista: "- texto" o "• texto" */
        const liMatch = inlined.match(/^[-•]\s+(.+)/);
        if (liMatch) {
          if (!listOpen) { output.push('<ul>'); listOpen = true; }
          output.push(`<li>${liMatch[1]}</li>`);
          continue;
        }

        /* Cierra lista si la línea ya no es un ítem */
        if (listOpen) { output.push('</ul>'); listOpen = false; }

        /* Línea vacía → separación de párrafo */
        if (line.trim() === '') {
          output.push('<p></p>');
          continue;
        }

        /* Línea normal → párrafo */
        output.push(`<p>${inlined}</p>`);
      }

      if (listOpen) output.push('</ul>');
      return output.join('');
    }

    /* ── renderResults ───────────────────────────────────────── */
    function renderResults(d) {
      modelName.textContent = d.modelo_usado  || '—';
      rawText.textContent   = d.texto_completo || '';

      cardObjetivos.innerHTML  = parseMarkdown(d.errores);
      cardConclus.innerHTML    = parseMarkdown(d.correcciones);
      cardValoracion.innerHTML = parseMarkdown(d.valoracion);

      const n = d.estrellas || extractStars(d.valoracion || '');
      starsRow.textContent = n > 0
        ? '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n)) : '';

      results.classList.remove('hidden');

      /* Actualiza estado con el modelo real */
      statusModel.textContent = '🦙 ' + (d.modelo_usado || '—');
      statusModel.classList.remove('hidden');
      statusDot.className = 'dot ok';
      statusText.textContent = 'Revisión completada';
    }
  }

  /* Lanza cuando el DOM está listo */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
