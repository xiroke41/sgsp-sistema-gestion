const INCENTIVE_BANDS = Object.freeze([
  { tier: 10, min: 0, max: 0.06, factor: 7337, tone: 'optimal', label: 'Optimo' },
  { tier: 9, min: 0.06, max: 0.16, factor: 6243, tone: 'optimal', label: 'Optimo' },
  { tier: 8, min: 0.16, max: 0.28, factor: 5172, tone: 'acceptable', label: 'Aceptable' },
  { tier: 7, min: 0.28, max: 0.40, factor: 4342, tone: 'acceptable', label: 'Aceptable' },
  { tier: 6, min: 0.40, max: 0.52, factor: 3729, tone: 'alert', label: 'Alerta' },
  { tier: 5, min: 0.52, max: 0.64, factor: 3270, tone: 'critical', label: 'Critico' },
  { tier: 4, min: 0.64, max: 0.74, factor: 2507, tone: 'critical', label: 'Critico' },
  { tier: 3, min: 0.74, max: 0.84, factor: 1816, tone: 'critical', label: 'Critico' },
  { tier: 2, min: 0.84, max: 0.94, factor: 1198, tone: 'critical', label: 'Critico' },
  { tier: 1, min: 0.94, max: Number.POSITIVE_INFINITY, factor: 0, tone: 'penalized', label: 'Penalizado' }
]);

export function calculateGiveaway(actualWeight, targetWeight) {
  const actual = Number(actualWeight);
  const target = Number(targetWeight);
  if (!Number.isFinite(actual) || !Number.isFinite(target) || target <= 0 || actual < 0) {
    throw new RangeError('Los pesos deben ser numeros validos y el objetivo debe ser mayor que cero.');
  }
  return ((actual - target) / target) * 100;
}

export function evaluateIncentive(giveaway) {
  const value = Number(giveaway);
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('El Giveaway debe ser un porcentaje mayor o igual a cero.');
  }
  const band = INCENTIVE_BANDS.find(({ min, max }) => value >= min && value < max) ?? INCENTIVE_BANDS.at(-1);
  return { ...band, giveaway: value };
}

export function calculatePerformance(actualWeight, targetWeight) {
  const giveaway = calculateGiveaway(actualWeight, targetWeight);
  return { giveaway, ...evaluateIncentive(giveaway) };
}

export { INCENTIVE_BANDS };
