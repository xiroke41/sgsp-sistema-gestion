const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function clientKey(request) {
  const forwarded = request.headers['x-forwarded-for'];
  return String(forwarded || request.ip || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

export function loginRateLimit(request, response, next) {
  const key = clientKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    loginAttempts.set(key, { startedAt: now, count: 1 });
    return next();
  }
  if (current.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - current.startedAt)) / 1000);
    response.set('Retry-After', String(retryAfter));
    return response.status(429).json({ success: false, error: 'RATE_LIMITED', message: 'Demasiados intentos de inicio de sesión. Intenta nuevamente más tarde.' });
  }
  current.count += 1;
  return next();
}

export function securityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (process.env.NODE_ENV === 'production') response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
