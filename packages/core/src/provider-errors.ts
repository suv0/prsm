/**
 * Detect provider failures that mean "this agent cannot continue usefully"
 * (credits, quota, auth) so callers can stop retrying that agent and move on.
 */
export function isFatalProviderError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b(out of credits?|no credits?|insufficient credits?)\b/.test(m) ||
    /\b(quota|billing|payment required|payment_required)\b/.test(m) ||
    /\b(usage limit|rate limit|ratelimit|too many requests)\b/.test(m) ||
    /\b(session limit|hit your session limit)\b/.test(m) ||
    /\b(subscription|plan limit|upgrade your plan)\b/.test(m) ||
    /\b(unauthorized|forbidden|invalid api key|authentication)\b/.test(m) ||
    /\b(402|429)\b/.test(m) ||
    /\bcredit(s)? (exhausted|exceeded|depleted)\b/.test(m)
  );
}

export function describeProviderFailure(message: string): string {
  if (isFatalProviderError(message)) {
    return `provider limit/auth — ${message.slice(0, 220)}`;
  }
  return message.slice(0, 280);
}
