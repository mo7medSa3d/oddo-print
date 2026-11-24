/** Explicit fresh Agent proof projection for tests that exercise unrelated health/ACL rules. */
export function verifiedPrinterState(id = "verified-test-printer", now = new Date()) {
  return { id, verificationState: "verified" as const, verificationVerifiedAt: now, verificationReceivedAt: now,
    verificationBindingDigest: "a".repeat(64), logicalQueueKey: "a".repeat(64), physicalDeviceKey: null,
    verificationReason: null, outputMedium: "physical" as const };
}
