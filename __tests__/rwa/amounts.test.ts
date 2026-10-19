import { describe, expect, test } from 'bun:test'
import {
  STELLAR_INT128_MAX,
  formatTokenAmount,
  parseTokenAmount,
  parseTokenUnits,
  serializeTokenUnits,
} from '@/lib/rwa/amounts'

describe('RWA token amounts', () => {
  test('parses and formats exact USDC SAC amounts at explicitly supplied decimals', () => {
    const units = parseTokenAmount('600.1234567', 7)
    expect(units).toBe(6_001_234_567n)
    expect(formatTokenAmount(units, 7)).toBe('600.1234567')
    expect(parseTokenAmount('600.1234567', 7)).toBe(units)
  })

  test('accepts arbitrary precision beyond JavaScript safe integers', () => {
    const units = parseTokenAmount('9007199254740993.1234567', 7)
    expect(units).toBe(90_071_992_547_409_931_234_567n)
    expect(formatTokenAmount(units, 7)).toBe('9007199254740993.1234567')
  })

  test('serializes bounded integer token units as decimal strings', () => {
    expect(serializeTokenUnits(STELLAR_INT128_MAX)).toBe(STELLAR_INT128_MAX.toString())
    expect(parseTokenUnits(STELLAR_INT128_MAX.toString())).toBe(STELLAR_INT128_MAX)
    expect(() => serializeTokenUnits(STELLAR_INT128_MAX + 1n)).toThrow(RangeError)
    expect(() => parseTokenUnits((STELLAR_INT128_MAX + 1n).toString())).toThrow(RangeError)
  })

  test('rejects excessive precision, signs, exponent notation, and invalid decimals', () => {
    expect(() => parseTokenAmount('1.00000001', 7)).toThrow(RangeError)
    expect(() => parseTokenAmount('-1', 7)).toThrow(TypeError)
    expect(() => parseTokenAmount('1e3', 7)).toThrow(TypeError)
    expect(() => parseTokenAmount('01.2', 7)).toThrow(TypeError)
    expect(() => parseTokenAmount('1', -1)).toThrow(RangeError)
  })

  test('formats whole values without unnecessary fractional zeros', () => {
    expect(formatTokenAmount(parseTokenAmount('10.5000000', 7), 7)).toBe('10.5')
    expect(formatTokenAmount(parseTokenAmount('10.0000000', 7), 7)).toBe('10')
  })
})
