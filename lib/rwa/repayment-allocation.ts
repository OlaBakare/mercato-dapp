import {
  BASIS_POINTS_DENOMINATOR,
  STELLAR_INT128_MAX,
  multiplyDivideFloor,
  parseTokenUnits,
  serializeTokenUnits,
} from '@/lib/rwa/amounts'

const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)

export type RwaPositionStatus = 'confirmed' | 'pending' | 'refunded' | 'cancelled'

export interface ConfirmedPositionInput {
  positionId: string
  investorWallet: string
  principalUnits: string
  status: RwaPositionStatus
}

export interface RepaymentTermsInput {
  /** Immutable financing target, expressed in the configured token's smallest units. */
  principalTargetUnits: string
  /** Flat return for the entire term, in basis points; it is not annualized. */
  flatReturnRateBps: string
  positions: ConfirmedPositionInput[]
}

export interface FinalPositionEntitlement {
  positionId: string
  investorWallet: string
  principalUnits: string
  ownershipUnits: string
  returnUnits: string
  entitlementUnits: string
}

export interface FinalRepaymentEntitlements {
  principalUnits: string
  returnUnits: string
  investorObligationUnits: string
  positions: FinalPositionEntitlement[]
}

export interface ConfirmedSettlementInput {
  positionId: string
  settledUnits: string
}

export interface CumulativeRepaymentInput extends RepaymentTermsInput {
  /** Confirmed investor distributions to date, not a pending escrow balance. */
  cumulativeDistributableUnits: string
  settled: ConfirmedSettlementInput[]
}

export interface CumulativePositionAllocation extends FinalPositionEntitlement {
  cumulativeTargetUnits: string
  settledUnits: string
  dueUnits: string
}

export interface CumulativeRepaymentAllocation extends FinalRepaymentEntitlements {
  cumulativeDistributableUnits: string
  positions: CumulativePositionAllocation[]
}

export interface ReleaseFeePolicyInput {
  version: string
  platformFeeBps: string
  protocolFeeBps: string
  /** Separately recorded funding-phase fees; not part of repayment entitlements. */
  fundingFeeUnits: string
}

export interface ReleaseFeeBreakdown {
  netInvestorEntitlementUnits: string
  grossEscrowUnits: string
  platformFeeUnits: string
  protocolFeeUnits: string
  modeledNetUnits: string
  reconciliationResidualUnits: string
  fundingFeeUnits: string
  feePolicyVersion: string
}

interface ParsedPosition {
  positionId: string
  investorWallet: string
  principalUnits: bigint
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function checkedAdd(left: bigint, right: bigint, name: string): bigint {
  const sum = left + right
  if (sum > STELLAR_INT128_MAX) {
    throw new RangeError(`${name} exceeds the unsigned Stellar int128 range`)
  }
  return sum
}

function parseRateBps(value: string): bigint {
  const rate = parseTokenUnits(value, 'Flat return rate')
  if (rate > STELLAR_INT128_MAX) {
    throw new RangeError('Flat return rate exceeds the supported range')
  }
  return rate
}

function parsePositions(inputs: ConfirmedPositionInput[]): ParsedPosition[] {
  if (inputs.length === 0) throw new RangeError('At least one confirmed position is required')

  const seen = new Set<string>()
  const positions = inputs.map((position) => {
    if (!position.positionId.trim()) throw new TypeError('Position ID cannot be empty')
    if (!position.investorWallet.trim()) throw new TypeError('Investor wallet cannot be empty')
    if (seen.has(position.positionId)) {
      throw new RangeError(`Duplicate position ID: ${position.positionId}`)
    }
    seen.add(position.positionId)

    if (position.status !== 'confirmed') {
      throw new RangeError(`Position ${position.positionId} is not confirmed`)
    }

    const principalUnits = parseTokenUnits(
      position.principalUnits,
      `Principal for position ${position.positionId}`,
    )
    if (principalUnits === ZERO) {
      throw new RangeError(`Principal for position ${position.positionId} must be positive`)
    }

    return {
      positionId: position.positionId,
      investorWallet: position.investorWallet,
      principalUnits,
    }
  })

  return positions.sort((left, right) => compareIds(left.positionId, right.positionId))
}

function largestRemainder(
  total: bigint,
  weights: Array<{ positionId: string; weight: bigint }>,
): Map<string, bigint> {
  const weightTotal = weights.reduce(
    (sum, item) => checkedAdd(sum, item.weight, 'Ownership total'),
    ZERO,
  )
  if (weightTotal === ZERO) throw new RangeError('Ownership denominator must be positive')

  const allocated = new Map<string, bigint>()
  const remainders: Array<{ positionId: string; remainder: bigint }> = []
  let floorTotal = ZERO

  for (const { positionId, weight } of weights) {
    const numerator = total * weight
    const share = numerator / weightTotal
    allocated.set(positionId, share)
    floorTotal += share
    remainders.push({ positionId, remainder: numerator % weightTotal })
  }

  remainders.sort(
    (left, right) =>
      (left.remainder > right.remainder ? -1 : left.remainder < right.remainder ? 1 : 0) ||
      compareIds(left.positionId, right.positionId),
  )

  const residual = total - floorTotal
  if (residual > BigInt(remainders.length)) {
    throw new Error('Largest-remainder allocation exceeded its residual bound')
  }
  for (let index = 0; index < Number(residual); index += 1) {
    const positionId = remainders[index].positionId
    allocated.set(positionId, allocated.get(positionId)! + ONE)
  }

  return allocated
}

export function calculateFinalRepaymentEntitlements(
  terms: RepaymentTermsInput,
): FinalRepaymentEntitlements {
  const positions = parsePositions(terms.positions)
  const rateBps = parseRateBps(terms.flatReturnRateBps)
  const principalTotal = positions.reduce(
    (sum, position) => checkedAdd(sum, position.principalUnits, 'Total principal'),
    ZERO,
  )
  const principalTarget = parseTokenUnits(terms.principalTargetUnits, 'Frozen principal target')
  if (principalTotal !== principalTarget) {
    throw new RangeError('Confirmed position principals do not equal the frozen financing target')
  }

  // Round the asset-level flat return down once; distribute its token units exactly.
  const returnTotal = multiplyDivideFloor(
    principalTotal,
    rateBps,
    BASIS_POINTS_DENOMINATOR,
    'Total return',
  )
  const ownership = positions.map(({ positionId, principalUnits }) => ({
    positionId,
    weight: principalUnits,
  }))
  const returnByPosition = largestRemainder(returnTotal, ownership)
  const investorObligation = checkedAdd(principalTotal, returnTotal, 'Investor obligation')

  return {
    principalUnits: serializeTokenUnits(principalTotal),
    returnUnits: serializeTokenUnits(returnTotal),
    investorObligationUnits: serializeTokenUnits(investorObligation),
    positions: positions.map((position) => {
      const returnUnits = returnByPosition.get(position.positionId)!
      const entitlementUnits = checkedAdd(
        position.principalUnits,
        returnUnits,
        `Entitlement for position ${position.positionId}`,
      )
      return {
        positionId: position.positionId,
        investorWallet: position.investorWallet,
        principalUnits: serializeTokenUnits(position.principalUnits),
        ownershipUnits: serializeTokenUnits(position.principalUnits),
        returnUnits: serializeTokenUnits(returnUnits),
        entitlementUnits: serializeTokenUnits(entitlementUnits),
      }
    }),
  }
}

const PRIORITY_SCALE = ONE << BigInt(256)

function monotoneApportion(
  total: bigint,
  positions: Array<{ positionId: string; weight: bigint }>,
): Map<string, bigint> {
  const result = new Map(positions.map(({ positionId }) => [positionId, ZERO]))
  if (total === ZERO) return result

  const maxAllocatable = positions.reduce(
    (sum, position) => checkedAdd(sum, position.weight, 'Entitlement total'),
    ZERO,
  )
  if (total > maxAllocatable) {
    throw new RangeError('Cumulative distribution exceeds total investor entitlements')
  }

  const maxScaledWeight =
    positions.reduce((max, position) => (position.weight > max ? position.weight : max), ZERO) *
    PRIORITY_SCALE

  const countAtLeast = (threshold: bigint): bigint => {
    let count = ZERO
    for (const position of positions) {
      count += (position.weight * PRIORITY_SCALE) / threshold
      if (count >= total) return total
    }
    return count
  }

  // D'Hondt's highest-averages sequence is house-monotone; the scale separates
  // all distinct integer weight/seat priorities within Stellar int128 bounds.
  let low = ONE
  let high = maxScaledWeight
  while (low < high) {
    const middle = (low + high + ONE) / TWO
    if (countAtLeast(middle) >= total) low = middle
    else high = middle - ONE
  }

  const cutoff = low
  let assignedAboveCutoff = ZERO
  const tiedAtCutoff: string[] = []

  for (const position of positions) {
    const scaledWeight = position.weight * PRIORITY_SCALE
    const above = scaledWeight / (cutoff + ONE)
    result.set(position.positionId, above)
    assignedAboveCutoff += above
    if (scaledWeight / (above + ONE) === cutoff) {
      tiedAtCutoff.push(position.positionId)
    }
  }

  tiedAtCutoff.sort(compareIds)
  const residual = total - assignedAboveCutoff
  if (residual > BigInt(tiedAtCutoff.length)) {
    throw new Error('Monotone allocation cutoff did not resolve exactly')
  }
  for (let index = 0; index < Number(residual); index += 1) {
    const positionId = tiedAtCutoff[index]
    result.set(positionId, result.get(positionId)! + ONE)
  }

  for (const position of positions) {
    if (result.get(position.positionId)! > position.weight) {
      throw new Error('Cumulative allocation exceeded a final entitlement')
    }
  }
  return result
}

export function calculateCumulativeRepaymentAllocation(
  input: CumulativeRepaymentInput,
): CumulativeRepaymentAllocation {
  const final = calculateFinalRepaymentEntitlements(input)
  const cumulative = parseTokenUnits(
    input.cumulativeDistributableUnits,
    'Cumulative distributable amount',
  )
  const obligation = parseTokenUnits(final.investorObligationUnits, 'Investor obligation')
  if (cumulative > obligation) {
    throw new RangeError('Cumulative repayment exceeds the investor obligation')
  }

  const settledById = new Map<string, bigint>()
  for (const settlement of input.settled) {
    if (settledById.has(settlement.positionId)) {
      throw new RangeError(`Duplicate settlement for position ${settlement.positionId}`)
    }
    settledById.set(
      settlement.positionId,
      parseTokenUnits(settlement.settledUnits, `Settlement for ${settlement.positionId}`),
    )
  }

  const validPositionIds = new Set(final.positions.map(({ positionId }) => positionId))
  for (const positionId of settledById.keys()) {
    if (!validPositionIds.has(positionId)) {
      throw new RangeError(`Settlement references unknown position ${positionId}`)
    }
  }

  const targets = monotoneApportion(
    cumulative,
    final.positions.map((position) => ({
      positionId: position.positionId,
      weight: parseTokenUnits(position.entitlementUnits),
    })),
  )

  const positions = final.positions.map((position) => {
    const target = targets.get(position.positionId)!
    const settled = settledById.get(position.positionId) ?? ZERO
    if (settled > target) {
      throw new RangeError(
        `Confirmed settlements exceed the cumulative target for ${position.positionId}`,
      )
    }
    return {
      ...position,
      cumulativeTargetUnits: serializeTokenUnits(target),
      settledUnits: serializeTokenUnits(settled),
      dueUnits: serializeTokenUnits(target - settled),
    }
  })

  const settledTotal = [...settledById.values()].reduce(
    (sum, amount) => checkedAdd(sum, amount, 'Confirmed settlements'),
    ZERO,
  )
  if (settledTotal > cumulative) {
    throw new RangeError('Confirmed settlements exceed the cumulative distribution')
  }

  return {
    ...final,
    cumulativeDistributableUnits: serializeTokenUnits(cumulative),
    positions,
  }
}

function feeForGross(gross: bigint, feeBps: bigint): bigint {
  return multiplyDivideFloor(gross, feeBps, BASIS_POINTS_DENOMINATOR, 'Release fee')
}

export function calculateReleaseFeeBreakdown(
  netInvestorEntitlementUnits: string,
  policy: ReleaseFeePolicyInput,
): ReleaseFeeBreakdown {
  if (!policy.version.trim()) throw new TypeError('Release fee policy version cannot be empty')
  const entitlement = parseTokenUnits(netInvestorEntitlementUnits, 'Net investor entitlement')
  const platformBps = parseTokenUnits(policy.platformFeeBps, 'Platform fee basis points')
  const protocolBps = parseTokenUnits(policy.protocolFeeBps, 'Protocol fee basis points')
  const fundingFees = parseTokenUnits(policy.fundingFeeUnits, 'Funding fees')

  if (platformBps + protocolBps >= BASIS_POINTS_DENOMINATOR) {
    throw new RangeError('Combined release fees must be below 100%')
  }

  const netAfterFees = (gross: bigint): bigint =>
    gross - feeForGross(gross, platformBps) - feeForGross(gross, protocolBps)

  let low = entitlement
  let high = entitlement
  while (netAfterFees(high) < entitlement) {
    if (high === STELLAR_INT128_MAX) {
      throw new RangeError('Gross escrow amount exceeds the unsigned Stellar int128 range')
    }
    high =
      high > STELLAR_INT128_MAX / TWO
        ? STELLAR_INT128_MAX
        : high * TWO
  }

  while (low < high) {
    const middle = (low + high) / TWO
    if (netAfterFees(middle) >= entitlement) high = middle
    else low = middle + ONE
  }

  const gross = low
  const platformFee = feeForGross(gross, platformBps)
  const protocolFee = feeForGross(gross, protocolBps)
  const modeledNet = gross - platformFee - protocolFee
  return {
    netInvestorEntitlementUnits: serializeTokenUnits(entitlement),
    grossEscrowUnits: serializeTokenUnits(gross),
    platformFeeUnits: serializeTokenUnits(platformFee),
    protocolFeeUnits: serializeTokenUnits(protocolFee),
    modeledNetUnits: serializeTokenUnits(modeledNet),
    reconciliationResidualUnits: serializeTokenUnits(modeledNet - entitlement),
    fundingFeeUnits: serializeTokenUnits(fundingFees),
    feePolicyVersion: policy.version,
  }
}
