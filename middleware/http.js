export function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

export function validateBody(requiredFields) {
  return (request, response, next) => {
    const missing = requiredFields.filter((field) => {
      const value = request.body?.[field];
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    });
    if (missing.length) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: `Faltan campos: ${missing.join(', ')}.` });
    next();
  };
}

export function errorHandler(error, request, response, next) {
  console.error(JSON.stringify({ event: 'request_error', path: request.path, message: error.message }));
  if (response.headersSent) return next(error);
  return response.status(error.statusCode || 500).json({ success: false, error: error.code || 'INTERNAL_ERROR', message: 'No fue posible procesar la solicitud.' });
}
