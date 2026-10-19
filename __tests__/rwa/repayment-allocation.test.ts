import { describe, expect, test } from 'bun:test'
import { parseTokenAmount } from '@/lib/rwa/amounts'
import {
  calculateCumulativeRepaymentAllocation,
  calculateFinalRepaymentEntitlements,
  calculateReleaseFeeBreakdown,
  type ConfirmedPositionInput,
  type RepaymentTermsInput,
} from '@/lib/rwa/repayment-allocation'

const USDC_DECIMALS = 7
const amount = (value: string) => parseTokenAmount(value, USDC_DECIMALS).toString()

function position(
  positionId: string,
  principal: string,
  status: ConfirmedPositionInput['status'] = 'confirmed',
): ConfirmedPositionInput {
  return {
    positionId,
    investorWallet: `G${positionId}`,
    principalUnits: amount(principal),
    status,
  }
}

function rawPosition(
  positionId: string,
  principalUnits: string,
): ConfirmedPositionInput {
  return {
    positionId,
    investorWallet: `G${positionId}`,
    principalUnits,
    status: 'confirmed',
  }
}

const twoInvestors: RepaymentTermsInput = {
  principalTargetUnits: amount('1000'),
  flatReturnRateBps: '500',
  positions: [position('position-b', '400'), position('position-a', '600')],
}

describe('final RWA repayment entitlements', () => {
  test('allocates a 50 flat-term return pro rata for 600/400 contributions', () => {
    const result = calculateFinalRepaymentEntitlements(twoInvestors)
    expect(result.principalUnits).toBe(amount('1000'))
    expect(result.returnUnits).toBe(amount('50'))
    expect(result.investorObligationUnits).toBe(amount('1050'))
    expect(result.positions).toEqual([
      {
        positionId: 'position-a',
        investorWallet: 'Gposition-a',
        principalUnits: amount('600'),
        ownershipUnits: amount('600'),
        returnUnits: amount('30'),
        entitlementUnits: amount('630'),
      },
      {
        positionId: 'position-b',
        investorWallet: 'Gposition-b',
        principalUnits: amount('400'),
        ownershipUnits: amount('400'),
        returnUnits: amount('20'),
        entitlementUnits: amount('420'),
      },
    ])
  })

  test('allocates final indivisible return units by largest remainder and stable position ID', () => {
    const input: RepaymentTermsInput = {
      principalTargetUnits: '3',
      flatReturnRateBps: '10000',
      positions: [rawPosition('z', '1'), rawPosition('b', '1'), rawPosition('a', '1')],
    }
    const result = calculateFinalRepaymentEntitlements(input)
    expect(result.returnUnits).toBe('3')
    expect(result.positions.map(({ positionId, returnUnits }) => [positionId, returnUnits]))
      .toEqual([['a', '1'], ['b', '1'], ['z', '1']])
  })

  test('is independent of input position ordering', () => {
    const first = calculateFinalRepaymentEntitlements(twoInvestors)
    const second = calculateFinalRepaymentEntitlements({
      ...twoInvestors,
      positions: [...twoInvestors.positions].reverse(),
    })
    expect(second).toEqual(first)
  })

  test('rejects pending, refunded, cancelled, zero, duplicate, and empty positions', () => {
    for (const status of ['pending', 'refunded', 'cancelled'] as const) {
      expect(() =>
        calculateFinalRepaymentEntitlements({
          principalTargetUnits: amount('1'),
          flatReturnRateBps: '500',
          positions: [position('p', '1', status)],
        }),
      ).toThrow(RangeError)
    }
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: '2',
        flatReturnRateBps: '500',
        positions: [position('p', '0')],
      }),
    ).toThrow(RangeError)
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: amount('2'),
        flatReturnRateBps: '500',
        positions: [position('p', '1'), position('p', '1')],
      }),
    ).toThrow(RangeError)
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: '0',
        flatReturnRateBps: '500',
        positions: [],
      }),
    ).toThrow(RangeError)
  })

  test('rejects return and aggregate values that exceed Stellar int128', () => {
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: ((1n << 127n) - 1n).toString(),
        flatReturnRateBps: '10000',
        positions: [{ ...position('p', '1'), principalUnits: ((1n << 127n) - 1n).toString() }],
      }),
    ).toThrow(RangeError)
  })

  test('rejects confirmed position totals that differ from the frozen financing target', () => {
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: amount('1000'),
        flatReturnRateBps: '500',
        positions: [position('position-a', '999')],
      }),
    ).toThrow(RangeError)
  })

  test('keeps entitlements exact above JavaScript safe-integer limits', () => {
    const positions = [
      rawPosition('large', '9007199254740993'),
      rawPosition('small', '5'),
    ]
    const result = calculateFinalRepaymentEntitlements({
      principalTargetUnits: '9007199254740998',
      flatReturnRateBps: '500',
      positions,
    })
    const totalEntitlements = result.positions.reduce(
      (sum, item) => sum + BigInt(item.entitlementUnits),
      0n,
    )
    expect(totalEntitlements.toString()).toBe(result.investorObligationUnits)
    expect(BigInt(result.positions[0].entitlementUnits)).toBeGreaterThan(
      BigInt(Number.MAX_SAFE_INTEGER),
    )
  })
})

describe('cumulative RWA repayments', () => {
  const terms: RepaymentTermsInput = {
    principalTargetUnits: '9',
    flatReturnRateBps: '0',
    positions: [rawPosition('a', '5'), rawPosition('b', '3'), rawPosition('c', '1')],
  }

  test('uses a house-monotone allocation instead of non-monotone largest remainder', () => {
    const atFour = calculateCumulativeRepaymentAllocation({
      ...terms,
      cumulativeDistributableUnits: '4',
      settled: [],
    })
    const atFive = calculateCumulativeRepaymentAllocation({
      ...terms,
      cumulativeDistributableUnits: '5',
      settled: atFour.positions.map(({ positionId, cumulativeTargetUnits }) => ({
        positionId,
        settledUnits: cumulativeTargetUnits,
      })),
    })

    expect(atFour.positions.map(({ cumulativeTargetUnits }) => cumulativeTargetUnits))
      .toEqual(['3', '1', '0'])
    expect(atFive.positions.map(({ cumulativeTargetUnits }) => cumulativeTargetUnits))
      .toEqual(['3', '2', '0'])
    expect(atFive.positions.map(({ dueUnits }) => dueUnits)).toEqual(['0', '1', '0'])
  })

  test('cumulative targets never decrease, stay capped, and finish at final entitlements', () => {
    const final = calculateFinalRepaymentEntitlements(terms)
    const previous = new Map(final.positions.map(({ positionId }) => [positionId, 0n]))
    const obligation = BigInt(final.investorObligationUnits)

    for (let cumulative = 0n; cumulative <= obligation; cumulative += 1n) {
      const allocation = calculateCumulativeRepaymentAllocation({
        ...terms,
        cumulativeDistributableUnits: cumulative.toString(),
        settled: [],
      })
      expect(
        allocation.positions.reduce(
          (sum, position) => sum + BigInt(position.cumulativeTargetUnits),
          0n,
        ),
      ).toBe(cumulative)

      for (const position of allocation.positions) {
        const target = BigInt(position.cumulativeTargetUnits)
        expect(target).toBeGreaterThanOrEqual(previous.get(position.positionId)!)
        expect(target).toBeLessThanOrEqual(BigInt(position.entitlementUnits))
        previous.set(position.positionId, target)
      }
    }

    expect(
      final.positions.map(({ entitlementUnits }) => entitlementUnits),
    ).toEqual(terms.positions.map(({ principalUnits }) => principalUnits))
  })

  test('confirmed partial settlements are subtracted once and final installments conserve entitlements', () => {
    const first = calculateCumulativeRepaymentAllocation({
      ...twoInvestors,
      cumulativeDistributableUnits: amount('100'),
      settled: [],
    })
    const final = calculateCumulativeRepaymentAllocation({
      ...twoInvestors,
      cumulativeDistributableUnits: amount('1050'),
      settled: first.positions.map(({ positionId, cumulativeTargetUnits }) => ({
        positionId,
        settledUnits: cumulativeTargetUnits,
      })),
    })

    expect(
      final.positions.reduce((sum, position) => sum + BigInt(position.dueUnits), 0n),
    ).toBe(
      BigInt(final.investorObligationUnits) -
        BigInt(first.cumulativeDistributableUnits),
    )
    expect(final.positions.map(({ dueUnits }) => dueUnits)).toEqual(
      final.positions.map(
        ({ entitlementUnits, settledUnits }) =>
          (BigInt(entitlementUnits) - BigInt(settledUnits)).toString(),
      ),
    )
  })

  test('rejects overpayment, unknown/duplicate settlements, and settlements ahead of targets', () => {
    const allocation = (overrides: {
      cumulativeDistributableUnits?: string
      settled?: Array<{ positionId: string; settledUnits: string }>
    }) =>
      calculateCumulativeRepaymentAllocation({
        ...terms,
        cumulativeDistributableUnits: overrides.cumulativeDistributableUnits ?? '1',
        settled: overrides.settled ?? [],
      })

    expect(() => allocation({ cumulativeDistributableUnits: '10' })).toThrow(RangeError)
    expect(() =>
      allocation({ settled: [{ positionId: 'unknown', settledUnits: '0' }] }),
    ).toThrow(RangeError)
    expect(() =>
      allocation({
        settled: [
          { positionId: 'a', settledUnits: '0' },
          { positionId: 'a', settledUnits: '0' },
        ],
      }),
    ).toThrow(RangeError)
    expect(() =>
      allocation({ settled: [{ positionId: 'a', settledUnits: '2' }] }),
    ).toThrow(RangeError)
  })

  test('allocates many positions and conserves tiny token-unit distributions', () => {
    const positions = Array.from({ length: 50 }, (_, index) =>
      position(`position-${index.toString().padStart(2, '0')}`, `${(index % 7) + 1}`),
    )
    const target = positions.reduce(
      (sum, item) => sum + BigInt(item.principalUnits),
      0n,
    )
    const final = calculateFinalRepaymentEntitlements({
      principalTargetUnits: target.toString(),
      flatReturnRateBps: '1337',
      positions,
    })
    const cumulative = calculateCumulativeRepaymentAllocation({
      principalTargetUnits: target.toString(),
      flatReturnRateBps: '1337',
      positions,
      cumulativeDistributableUnits: '17',
      settled: [],
    })
    expect(
      cumulative.positions.reduce(
        (sum, position) => sum + BigInt(position.cumulativeTargetUnits),
        0n,
      ),
    ).toBe(17n)
    expect(
      final.positions.reduce((sum, position) => sum + BigInt(position.returnUnits), 0n),
    ).toBe(BigInt(final.returnUnits))
  })

  test('rejects a corrupted ownership total that would overflow int128', () => {
    expect(() =>
      calculateFinalRepaymentEntitlements({
        principalTargetUnits: ((1n << 127n) - 1n).toString(),
        flatReturnRateBps: '0',
        positions: [
          { ...position('a', '1'), principalUnits: ((1n << 127n) - 1n).toString() },
          position('b', '1'),
        ],
      }),
    ).toThrow(RangeError)
  })

  test('property-checks conservation and monotonicity across varied small position sets', () => {
    for (let sample = 1; sample <= 12; sample += 1) {
      const positions = Array.from({ length: (sample % 5) + 2 }, (_, index) =>
        rawPosition(
          `sample-${sample}-position-${index}`,
          `${((sample * 3 + index * 5) % 9) + 1}`,
        ),
      )
      const target = positions.reduce(
        (sum, item) => sum + BigInt(item.principalUnits),
        0n,
      )
      const terms: RepaymentTermsInput = {
        principalTargetUnits: target.toString(),
        flatReturnRateBps: `${sample * 173}`,
        positions,
      }
      const final = calculateFinalRepaymentEntitlements(terms)
      const previous = new Map(final.positions.map(({ positionId }) => [positionId, 0n]))

      for (
        let cumulative = 0n;
        cumulative <= BigInt(final.investorObligationUnits);
        cumulative += 1n
      ) {
        const allocation = calculateCumulativeRepaymentAllocation({
          ...terms,
          cumulativeDistributableUnits: cumulative.toString(),
          settled: [],
        })
        expect(
          allocation.positions.reduce(
            (sum, item) => sum + BigInt(item.cumulativeTargetUnits),
            0n,
          ),
        ).toBe(cumulative)
        for (const item of allocation.positions) {
          const targetUnits = BigInt(item.cumulativeTargetUnits)
          expect(targetUnits).toBeGreaterThanOrEqual(previous.get(item.positionId)!)
          expect(targetUnits).toBeLessThanOrEqual(BigInt(item.entitlementUnits))
          previous.set(item.positionId, targetUnits)
        }
      }

      expect(
        calculateFinalRepaymentEntitlements({
          ...terms,
          positions: [...positions].reverse(),
        }),
      ).toEqual(final)
    }
  })
})

describe('RWA Trustless Work fee accounting model', () => {
  test('reports net, gross, each release fee, funding fees, and any residual separately', () => {
    const breakdown = calculateReleaseFeeBreakdown('10500000000', {
      version: 'example-v1',
      platformFeeBps: '100',
      protocolFeeBps: '30',
      fundingFeeUnits: '250',
    })
    const gross = BigInt(breakdown.grossEscrowUnits)
    const platform = BigInt(breakdown.platformFeeUnits)
    const protocol = BigInt(breakdown.protocolFeeUnits)
    const modeledNet = BigInt(breakdown.modeledNetUnits)

    expect(gross).toBe(platform + protocol + modeledNet)
    expect(modeledNet).toBe(
      BigInt(breakdown.netInvestorEntitlementUnits) +
        BigInt(breakdown.reconciliationResidualUnits),
    )
    expect(breakdown.fundingFeeUnits).toBe('250')
    expect(breakdown.feePolicyVersion).toBe('example-v1')

    const previousGross = gross - 1n
    const previousNet =
      previousGross -
      (previousGross * 100n) / 10_000n -
      (previousGross * 30n) / 10_000n
    expect(previousNet).toBeLessThan(BigInt(breakdown.netInvestorEntitlementUnits))
  })

  test('rejects invalid fee policy and reports excessive fee rounding as a residual', () => {
    expect(() =>
      calculateReleaseFeeBreakdown('1', {
        version: 'bad',
        platformFeeBps: '9000',
        protocolFeeBps: '1000',
        fundingFeeUnits: '0',
      }),
    ).toThrow(RangeError)
    expect(() =>
      calculateReleaseFeeBreakdown('1', {
        version: '',
        platformFeeBps: '0',
        protocolFeeBps: '0',
        fundingFeeUnits: '0',
      }),
    ).toThrow(TypeError)
  })
})
