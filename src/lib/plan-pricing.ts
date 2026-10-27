/** Manual catalogue prices are decimal strings to avoid binary money rounding. */
export function parsePlanCurrency(value: unknown): "usd" | "sar" {
  const currency = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (currency !== "usd" && currency !== "sar") throw new Error("Currency must be USD or SAR.");
  return currency;
}

export function parsePlanPriceAmount(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(value.trim())) {
    throw new Error("Price must be a non-negative decimal amount with up to two decimal places.");
  }
  const [whole, fraction = ""] = value.trim().split(".");
  return whole + "." + fraction.padEnd(2, "0");
}

export function formatPlanPriceAmount(
  amount: string | null | undefined,
  currency: string | null | undefined,
  locale: "en" | "ar",
): string | null {
  if (amount == null || (currency !== "usd" && currency !== "sar")) return null;
  try {
    const canonical = parsePlanPriceAmount(amount);
    return new Intl.NumberFormat(locale === "ar" ? "ar-SA" : "en-US", {
      style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(canonical));
  } catch {
    return null;
  }
}
