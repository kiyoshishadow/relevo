export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

const MAX_CENTS = 100_000_000_00; // USD 100.000.000,00

/**
 * Convierte un importe decimal de la API a centavos enteros.
 * Acepta como máximo dos decimales y rechaza negativos, notación científica
 * y valores por encima del límite conservador del dominio.
 */
export function parseMoneyToCents(value, { allowZero = true } = {}) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError('Importe inválido');
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new MoneyError('El importe debe ser una cadena decimal o un número');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new MoneyError('El importe debe tener formato decimal con hasta dos decimales');
  }

  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new MoneyError('El importe excede el límite permitido');
  }
  if (!allowZero && cents === 0) {
    throw new MoneyError('El importe debe ser mayor que cero');
  }
  return cents;
}

export function formatCents(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) throw new MoneyError('Centavos inválidos');
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

export function sumCents(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new MoneyError('Centavos inválidos');
    total += value;
    if (!Number.isSafeInteger(total)) throw new MoneyError('Total monetario fuera de rango');
  }
  return total;
}
