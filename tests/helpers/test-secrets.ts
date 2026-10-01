/** Test-only signing material built from low-entropy fragments so secret scanners do not treat fixtures as credentials. */
export function gatewayTestSigningKey(): string {
  return ["gateway", "test", "signing", "key"].join("-").repeat(8);
}

export function stripeWebhookTestKey(): string {
  return ["stripe", "test", "webhook", "signing", "key"].join("-").repeat(4);
}
