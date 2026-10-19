const ZERO = BigInt(0)
const ONE = BigInt(1)

export const STELLAR_INT128_MAX = (ONE << BigInt(127)) - ONE
export const BASIS_POINTS_DENOMINATOR = BigInt(10_000)

function validateDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError('Token decimals must be an integer from 0 to 18')
  }
}

function assertTokenUnits(units: bigint, name = 'Token units'): void {
  if (units < ZERO || units > STELLAR_INT128_MAX) {
    throw new RangeError(`${name} must fit an unsigned Stellar int128`)
  }
}

export function parseTokenUnits(value: string, name = 'Token units'): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${name} must be a non-negative integer string`)
  }

  const units = BigInt(value)
  assertTokenUnits(units, name)
  return units
}

export function serializeTokenUnits(units: bigint): string {
  assertTokenUnits(units)
  return units.toString()
}

export function parseTokenAmount(value: string, decimals: number): bigint {
  validateDecimals(decimals)
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value)
  if (!match) {
    throw new TypeError('Token amount must be a non-negative decimal string')
  }

  const fraction = match[2] ?? ''
  if (fraction.length > decimals) {
    throw new RangeError(`Token amount exceeds the configured ${decimals} decimals`)
  }

  const scale = tokenScale(decimals)
  const units = BigInt(match[1]) * scale + BigInt(fraction.padEnd(decimals, '0') || '0')
  assertTokenUnits(units, 'Token amount')
  return units
}

export function formatTokenAmount(units: bigint, decimals: number): string {
  validateDecimals(decimals)
  assertTokenUnits(units)

  if (decimals === 0) return units.toString()

  const scale = tokenScale(decimals)
  const whole = units / scale
  const fraction = (units % scale).toString().padStart(decimals, '0')
  const trimmedFraction = fraction.replace(/0+$/, '')
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString()
}

export function multiplyDivideFloor(
  left: bigint,
  right: bigint,
  denominator: bigint,
  name = 'Calculated amount',
): bigint {
  if (left < ZERO || right < ZERO || denominator <= ZERO) {
    throw new RangeError('Integer ratio operands must be non-negative with a positive denominator')
  }

  const result = (left * right) / denominator
  assertTokenUnits(result, name)
  return result
}

function tokenScale(decimals: number): bigint {
  let scale = ONE
  for (let index = 0; index < decimals; index += 1) {
    scale *= BigInt(10)
  }
  return scale
}
