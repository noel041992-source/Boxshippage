'use strict';

// ===== CONFIGURACIÓN =====
const ESTADOS_ESPANOL = {
  RECEIVED: '📦 Bodega Miami',
  IN_TRANSIT: '🚚 En Tránsito a Panamá',
  ARRIVED: '🏁 Recibido en Puerto/Aduana Panamá',
  WAREHOUSED: '🏬 Bodega Panamá',
  DELIVERED: '✅ Listo para Entrega al Cliente',
};
const BODEGA_MIAMI = ESTADOS_ESPANOL.RECEIVED;
const BODEGA_PANAMA = ESTADOS_ESPANOL.WAREHOUSED;

// Ruta correcta para Cloudflare Pages
const API_CONFIG = { endpoint: '/tracking', timeoutMs: 15000 };

// ⚠️ PON AQUÍ TU SITE KEY PÚBLICA DE CLOUDFLARE TURNSTILE (Empieza con 0x)
const TURNSTILE_SITE_KEY = 'TU_SITE_KEY_AQUI'; 

const HISTORY_KEY = 'boxship_historial';
const LAST_KEY = 'boxship_ultimo';
const CACHE_PREFIX = 'boxship_cache_';
const CACHE_TTL = 5 * 60 * 1000;
const MAX_HISTORY = 10;
const ID_PATTERN = /^[\w.\-]{3,64}$/;

const $ = (id) => document.getElementById(id);
let turnstileWidgetId = null;

// ===== HISTORIAL Y CACHÉ =====
function leerHistorial() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function guardarEnHistorial(id) {
  const h = leerHistorial().filter((x) => x !== id);
  h.unshift(id);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY))); localStorage.setItem(LAST_KEY, id); } catch (e) {}
  renderHistorialBusquedas();
}
function leerCache(id) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    return Date.now() - ts < CACHE_TTL ? data : null;
  } catch { return null; }
}
function guardarCache(id, data) { try { localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ data, ts: Date.now() })); } catch (e) {} }
function limpiarHistorial() {
  leerHistorial().forEach((id) => localStorage.removeItem(CACHE_PREFIX + id));
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(LAST_KEY);
  renderHistorialBusquedas();
}
function renderHistorialBusquedas() {
  const cont = $('historialBusquedas');
  if (!cont) return;
  const h = leerHistorial();
  if (!h.length) { cont.style.display = 'none'; return; }
  cont.replaceChildren();
  const title = document.createElement('span'); title.className = 'search-history-title'; title.textContent = 'Búsquedas recientes:';
  cont.appendChild(title);
  h.forEach((id) => {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'history-chip'; chip.textContent = id;
    chip.addEventListener('click', () => { $('trackingInput').value = id; consultarTracking(true); });
    cont.appendChild(chip);
  });
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'history-clear'; clear.textContent = '🗑️ Limpiar';
  clear.addEventListener('click', limpiarHistorial);
  cont.appendChild(clear);
  cont.style.display = 'flex';
}

// ===== CONSULTA PRINCIPAL =====
let consultando = false;

async function consultarTracking(forzar = false) {
  if (consultando) return;
  const trackingId = $('trackingInput').value.replace(/\s+/g, '');
  $('trackingInput').value = trackingId;

  if (!trackingId) { mostrarError('Por favor, ingresa un número de tracking'); return; }
  if (!ID_PATTERN.test(trackingId)) { mostrarError('El número de tracking no parece válido.'); return; }

  ocultarError();

  if (forzar !== true) {
    const cacheado = leerCache(trackingId);
    if (cacheado) { mostrarResultado(cacheado); guardarEnHistorial(trackingId); return; }
  }

  // PROTECCIÓN TURNSTILE
  if (typeof turnstile === 'undefined') {
    mostrarError('El sistema de seguridad está bloqueado. Desactiva tu bloqueador y recarga.');
    return;
  }
  if (!turnstileWidgetId) {
    mostrarError('El sistema de seguridad aún no está listo. Espera un momento.');
    return;
  }
  const turnstileToken = turnstile.getResponse(turnstileWidgetId);
  if (!turnstileToken) {
    mostrarError('Por favor, completa la verificación de seguridad (la casilla).');
    return;
  }

  consultando = true;
  setBotonEstado(true);
  mostrarLoading();
  ocultarResultados();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_CONFIG.timeoutMs);

  try {
    const respuesta = await fetch(API_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking_id: trackingId, turnstile_token: turnstileToken }),
      signal: controller.signal,
    });

    let datos;
    try { datos = await respuesta.json(); }
    catch { mostrarError('El servicio no está disponible por ahora.'); return; }

    if (datos.error || datos.code !== 200 || !datos.data) {
      manejarError(datos);
    } else {
      mostrarResultado(datos.data);
      guardarCache(trackingId, datos.data);
      guardarEnHistorial(trackingId);
    }
  } catch (error) {
    mostrarError(error.name === 'AbortError' ? 'La consulta tardó demasiado.' : 'Error de conexión.');
  } finally {
    clearTimeout(timer);
    consultando = false;
    setBotonEstado(false);
    ocultarLoading();
    if (turnstileWidgetId && typeof turnstile !== 'undefined') turnstile.reset(turnstileWidgetId);
  }
}

// ===== MOSTRAR RESULTADO =====
function parseFecha(f) { const t = Date.parse(f); return Number.isNaN(t) ? null : t; }
function prepararHistorial(lista) {
  const items = lista.map((m, i) => ({ ...m, _i: i, _t: parseFecha(m.date) }));
  const todasConFecha = items.every((m) => m._t !== null);
  const cronologico = todasConFecha ? [...items].sort((a, b) => a._t - b._t || a._i - b._i) : [...items];
  let vistosReceived = 0;
  cronologico.forEach((m) => {
    m._label = ESTADOS_ESPANOL[m.status] || m.status;
    if (m.status === 'RECEIVED') { m._label = vistosReceived === 0 ? BODEGA_MIAMI : BODEGA_PANAMA; vistosReceived++; }
  });
  return { items: [...cronologico].reverse(), totalReceived: vistosReceived };
}

function mostrarResultado(data) {
  const lista = Array.isArray(data.list_status_history) ? data.list_status_history : [];
  const { items, totalReceived } = prepararHistorial(lista);
  let estado = ESTADOS_ESPANOL[data.current_status] || data.current_status || 'Sin estado';
  if (data.current_status === 'RECEIVED' && totalReceived > 1) estado = BODEGA_PANAMA;

  const badge = $('estadoActual'); badge.textContent = estado; badge.className = `status-badge status-${data.current_status}`;
  $('trackingId').textContent = `Tracking: ${data.tracking_id}`;

  const historial = $('historial'); historial.replaceChildren();
  if (!items.length) {
    const p = document.createElement('p'); p.className = 'text-sm text-muted-foreground'; p.textContent = 'No hay historial disponible'; historial.appendChild(p);
  } else {
    items.forEach((m) => {
      const item = document.createElement('div'); item.className = 'history-item';
      const status = document.createElement('span'); status.className = 'history-status'; status.textContent = m._label;
      const fecha = document.createElement('span'); fecha.className = 'history-date'; fecha.textContent = formatearFecha(m.date);
      item.append(status, fecha); historial.appendChild(item);
    });
  }
  $('resultado').style.display = 'block';
}

// ===== MANEJO DE ERRORES =====
function manejarError(datos) {
  switch (datos.code) {
    case 400: mostrarError(datos.error || 'Solicitud inválida.'); break;
    case 403: mostrarError('Verificación de seguridad fallida. Recarga la página.'); break;
    case 404: mostrarError('Tracking ID no encontrado. Verifica el número.'); break;
    case 405: mostrarError('Error en el servidor.'); break;
    default: mostrarError(datos.error || datos.message || 'Error desconocido');
  }
}

// ===== UTILIDADES UI =====
function mostrarError(mensaje) { ocultarResultados(); $('mensajeError').textContent = mensaje; $('error').style.display = 'block'; }
function setBotonEstado(ocupado) { const b = $('btnConsultar'); if (!b) return; b.disabled = ocupado; b.style.opacity = ocupado ? '0.6' : ''; b.style.cursor = ocupado ? 'wait' : ''; }
function mostrarLoading() { $('loading').style.display = 'block'; }
function ocultarLoading() { $('loading').style.display = 'none'; }
function ocultarResultados() { $('resultado').style.display = 'none'; }
function ocultarError() { $('error').style.display = 'none'; }
function formatearFecha(fechaString) {
  const t = parseFecha(fechaString);
  if (t === null) return fechaString || '';
  return new Date(t).toLocaleString('es-PA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ===== INICIO =====
document.addEventListener('DOMContentLoaded', () => {
  $('btnConsultar').addEventListener('click', () => consultarTracking());
  $('trackingInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') consultarTracking(); });
  renderHistorialBusquedas();

  const ultimo = localStorage.getItem(LAST_KEY);
  if (ultimo) {
    $('trackingInput').value = ultimo;
    const cacheado = leerCache(ultimo);
    if (cacheado) mostrarResultado(cacheado);
  }

  if (typeof turnstile !== 'undefined') {
    turnstile.ready(() => {
      if (TURNSTILE_SITE_KEY === 'TU_SITE_KEY_AQUI') {
        mostrarError('Falta configurar la Site Key de Turnstile en el código.');
        return;
      }
      turnstileWidgetId = turnstile.render('#turnstile-container', {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'light',
      });
    });
  } else {
    mostrarError('No se pudo cargar el sistema de seguridad de Cloudflare.');
  }
});