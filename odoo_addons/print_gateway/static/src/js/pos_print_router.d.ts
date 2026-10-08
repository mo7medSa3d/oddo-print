/** Type contract for the Odoo POS print router consumed by Gateway regression tests. */
export function renderReceiptImage(
  pos: unknown,
  currentOrder: unknown,
  basic?: boolean,
  rasterWidth?: number,
): Promise<string>;
