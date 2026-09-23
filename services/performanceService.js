import { Decimal128 } from 'mongodb';

function decimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    const error = new Error('El peso debe ser un número mayor o igual que cero.');
    error.statusCode = 400;
    error.code = 'INVALID_WEIGHT';
    throw error;
  }
  return number;
}

export async function calculateShiftPerformance(database, actualWeightInput, targetWeightInput) {
  const actualWeight = decimal(actualWeightInput);
  const targetWeight = Number(targetWeightInput);
  if (!Number.isFinite(targetWeight) || targetWeight <= 0) {
    const error = new Error('El peso objetivo debe ser mayor que cero.');
    error.statusCode = 400;
    error.code = 'INVALID_TARGET_WEIGHT';
    throw error;
  }

  const giveaway = ((actualWeight - targetWeight) / targetWeight) * 100;
  if (giveaway < 0) {
    const error = new Error('El Giveaway calculado no puede ser negativo.');
    error.statusCode = 400;
    error.code = 'NEGATIVE_GIVEAWAY';
    throw error;
  }

  const giveawayDecimal = Decimal128.fromString(giveaway.toFixed(4));
  const band = await database.collection('tramosGiveawayTarifa').findOne({
    giveawayMin: { $lte: giveawayDecimal },
    $or: [{ giveawayMax: null }, { giveawayMax: { $gt: giveawayDecimal } }]
  });
  if (!band) {
    const error = new Error('No existe un tramo tarifario para el Giveaway calculado.');
    error.statusCode = 422;
    error.code = 'TARIFF_BAND_NOT_FOUND';
    throw error;
  }

  return {
    kilogramosProcesados: Decimal128.fromString(actualWeight.toFixed(3)),
    kilogramosObjetivo: Decimal128.fromString(targetWeight.toFixed(3)),
    giveaway: Decimal128.fromString(giveaway.toFixed(4)),
    giveawayNumber: giveaway,
    tramoId: band._id,
    tramo: band.tramo,
    tarifa: band.tarifa,
    total: band.tarifa,
    tono: band.tono
  };
}

export async function calculateShiftPerformanceFromGiveaway(database, actualWeightInput, giveawayInput) {
  const actualWeight = decimal(actualWeightInput);
  const giveaway = Number(giveawayInput);
  if (!Number.isFinite(giveaway) || giveaway < 0) {
    const error = new Error('El Giveaway debe ser un porcentaje mayor o igual que cero.');
    error.statusCode = 400;
    error.code = 'INVALID_GIVEAWAY';
    throw error;
  }
  const targetWeight = actualWeight / (1 + giveaway / 100);
  const giveawayDecimal = Decimal128.fromString(giveaway.toFixed(4));
  const band = await database.collection('tramosGiveawayTarifa').findOne({ giveawayMin: { $lte: giveawayDecimal }, $or: [{ giveawayMax: null }, { giveawayMax: { $gt: giveawayDecimal } }] });
  if (!band) {
    const error = new Error('No existe un tramo tarifario para el Giveaway calculado.');
    error.statusCode = 422;
    error.code = 'TARIFF_BAND_NOT_FOUND';
    throw error;
  }
  return {
    kilogramosProcesados: Decimal128.fromString(actualWeight.toFixed(3)),
    kilogramosObjetivo: Decimal128.fromString(targetWeight.toFixed(3)),
    giveaway: giveawayDecimal,
    giveawayNumber: giveaway,
    tramoId: band._id,
    tramo: band.tramo,
    tarifa: band.tarifa,
    total: band.tarifa,
    tono: band.tono
  };
}
