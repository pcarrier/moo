type ErrorProvider = { name?: string | null; baseUrl?: string | null };

/** Diagnose only Z.ai's standard billing route, never coding endpoints or gateways. */
export function providerErrorHint(
  provider: ErrorProvider | null | undefined,
  code: unknown,
): string | null {
  if (provider?.name !== "glm" || (code !== "1113" && code !== 1113))
    return null;

  // URL is unavailable in the harness runtime. Match the authority separately
  // so the host is case-insensitive but the endpoint path remains exact.
  const endpoint = /^https:\/\/api\.z\.ai(?::443)?(\/.*)$/i.exec(provider.baseUrl ?? "");
  if (endpoint?.[1].replace(/\/+$/, "") !== "/api/paas/v4") return null;

  return (
    "Z.ai Coding Plan subscription quota is separate from pay-as-you-go API balance. " +
    "If you are using the subscription, choose Settings > Providers > GLM > Plan > " +
    "Coding Plan (subscription) and save. This sets https://api.z.ai/api/coding/paas/v4 " +
    "automatically, replacing any URL override without changing your API key. " +
    "Z.ai restricts subscriptions to supported tools; " +
    "Moo is not currently listed, so confirm eligibility with Z.ai. " +
    "Check model availability on the selected endpoint."
  );
}
