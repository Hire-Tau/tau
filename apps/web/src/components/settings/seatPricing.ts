import type { SeatPricing } from '../../api/users'

/**
 * The wording the Users page uses to tell an admin what their user list costs.
 *
 * Pure and separately tested because the numbers are the whole point: a line
 * that is off by the one included seat misstates someone's bill. Every figure
 * comes from the server payload (see apps/core/src/services/platform/seat-pricing.ts);
 * nothing here invents a price, a seat count, or a rounding rule.
 */

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/**
 * "$10" / "$10.50". Whole amounts drop the cents so the line reads as prose
 * rather than an invoice. Falls back to a plain "10.00 XYZ" if the server ever
 * sends a currency code Intl doesn't know — a settings page must not white-screen
 * over a price label.
 */
export function formatSeatPrice(cents: number, currency: string): string {
  const amount = cents / 100
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/** "$10/month" — the per-seat rate, as it appears in both lines below. */
export function seatRate(pricing: SeatPricing): string {
  return `${formatSeatPrice(pricing.seatPriceCents, pricing.currency)}/month`
}

/**
 * True when the NEXT invite lands on a billed seat. False only while the head
 * count is still inside the plan's included seats, where one more user is free.
 */
export function nextSeatIsBilled(pricing: SeatPricing): boolean {
  return pricing.userCount >= pricing.includedSeats
}

/**
 * The standing summary, e.g.
 *   "3 users · 2 billed seats (the first seat is included) · $10/month per billed seat"
 *
 * The included-seat clause is what makes the arithmetic checkable — without it
 * "3 users · 2 billed seats" just looks like an off-by-one. It is dropped when
 * the plan includes no seats, where there is nothing to explain.
 */
export function seatUsageLine(pricing: SeatPricing): string {
  const included =
    pricing.includedSeats === 0
      ? null
      : pricing.includedSeats === 1
        ? '(the first seat is included)'
        : `(the first ${pricing.includedSeats} seats are included)`
  return [
    plural(pricing.userCount, 'user'),
    [plural(pricing.billedSeats, 'billed seat'), included].filter(Boolean).join(' '),
    `${seatRate(pricing)} per billed seat`,
  ].join(' · ')
}

/**
 * The line at the point of decision — inside the invite form, where the cost is
 * actually incurred. Three honest cases, because they are genuinely different
 * facts and a single generic sentence would be wrong in two of them:
 *
 *  - the invite is still covered by an included seat → it costs nothing;
 *  - it is the FIRST one that isn't → this is where the bill starts;
 *  - the instance already pays for seats → it is one more of the same.
 */
export function inviteCostLine(pricing: SeatPricing): string {
  const rate = seatRate(pricing)
  if (!nextSeatIsBilled(pricing)) {
    return `Your plan includes ${plural(pricing.includedSeats, 'seat')} and ${pricing.userCount} ${
      pricing.userCount === 1 ? 'is' : 'are'
    } in use, so this invite adds nothing to your subscription.`
  }
  if (pricing.billedSeats === 0) {
    return `This is the first invite that adds to your bill: sending it increases your subscription by ${rate}.`
  }
  return `Sending this invite increases your subscription by ${rate}, on top of the ${plural(
    pricing.billedSeats,
    'seat'
  )} you are billed for today.`
}
