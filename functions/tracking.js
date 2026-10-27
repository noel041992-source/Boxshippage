const UPSTREAM_URL = 'https://nelconcargo.elizaapp.com/api/tracking/status';
const UPSTREAM_TIMEOUT_MS = 10000;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ID_PATTERN = /^[\w.\-]{3,64}$/;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

async function validateTurnstile(token, secret, remoteip) {
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);
  if (remoteip) formData.append('remoteip', remoteip);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
    });
    return await response.json();
  } catch (error) {
    console.error('Turnstile validation error:', error);
    return { success: false, 'error-codes': ['internal-error'] };
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return json({ code: 405, error: 'Método no permitido' }, 405, { Allow: 'POST' });
  }

  const origin = request.headers.get('Origin');
  if (origin) {
    let sameSite = false;
    try { sameSite = new URL(origin).host === new URL(request.url).host; } catch (_) {}
    if (!sameSite) return json({ code: 403, error: 'Origen no permitido' }, 403);
  }

  if (!env.API_ACCESS_KEY || !env.TURNSTILE_SECRET_KEY) {
    console.error('Faltan variables de entorno');
    return json({ code: 500, error: 'Servicio no configurado' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ code: 400, error: 'Solicitud inválida' }, 400);
  }

  const trackingId = String(body.tracking_id ?? '').trim();
  const turnstileToken = String(body.turnstile_token ?? '').trim();

  if (!trackingId || !turnstileToken) {
    return json({ code: 400, error: 'Faltan datos de verificación' }, 400);
  }
  if (!ID_PATTERN.test(trackingId)) {
    return json({ code: 400, error: 'Formato de tracking no válido' }, 400);
  }

  // 1. VALIDAR TURNSTILE PRIMERO (Seguridad)
  const clientIP = request.headers.get('CF-Connecting-IP');
  const turnstileResult = await validateTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIP);

  if (!turnstileResult.success) {
    console.warn('Turnstile falló:', turnstileResult['error-codes']);
    return json({ 
      code: 403, 
      error: 'Verificación de seguridad fallida. Recarga la página e intenta de nuevo.' 
    }, 403);
  }

  // 2. SI TURNSTILE ES VÁLIDO, CONSULTAR A ELIZAAPP
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_access_key: env.API_ACCESS_KEY, tracking_id: trackingId }),
      signal: controller.signal,
    });

    let data;
    try {
      data = await upstream.json();
    } catch (_) {
      return json({ code: 502, error: 'Respuesta inválida del proveedor' }, 502);
    }

    if (data && typeof data === 'object' && typeof data.code !== 'number') {
      data.code = upstream.ok ? 200 : upstream.status;
    }
    return json(data, 200);
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    return json(
      { code: timeout ? 504 : 500, error: timeout ? 'El proveedor tardó demasiado' : 'Error del servidor' },
      timeout ? 504 : 500
    );
  } finally {
    clearTimeout(timer);
  }
}