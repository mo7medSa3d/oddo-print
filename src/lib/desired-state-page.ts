import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import { printers } from "../db/schema";
import { readFleetCursorId } from "./fleet-cursor";

export const DESIRED_STATE_PAGE_ROWS = 64;
export const DESIRED_STATE_PAGE_BYTES = 512 * 1024;
const columns = { id: true, name: true, printerType: true, deviceClass: true, connectionType: true, protocol: true, lifecycle: true, config: true, desiredRevision: true } as const;
type DesiredPrinter = Pick<typeof printers.$inferSelect, keyof typeof columns>;
type DesiredQuery = { columns: typeof columns; where: SQL | undefined; orderBy: SQL[]; limit: number };

export async function getDesiredPrinterPage(
  tenantId: string,
  agentId: string,
  cursor: string | undefined,
  read: (options: DesiredQuery) => Promise<DesiredPrinter[]>,
): Promise<{ items: DesiredPrinter[]; nextCursor: string | null }> {
  const afterId = cursor === undefined ? null : readFleetCursorId(new URLSearchParams({ beforeIdEncoded: cursor }));
  const rows = await read({
    columns,
    where: and(eq(printers.tenantId, tenantId), eq(printers.agentId, agentId), eq(printers.managementSource, "manager"), afterId === null ? undefined : gt(printers.id, afterId)),
    orderBy: [asc(printers.id)],
    limit: DESIRED_STATE_PAGE_ROWS + 1,
  });
  const items: DesiredPrinter[] = [];
  let bytes = 2;
  for (const row of rows.slice(0, DESIRED_STATE_PAGE_ROWS)) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + (items.length ? 1 : 0);
    if (bytes + size > DESIRED_STATE_PAGE_BYTES) {
      if (items.length === 0) throw new Error("Desired printer configuration exceeds the response page byte limit");
      break;
    }
    items.push(row);
    bytes += size;
  }
  const last = items.at(-1);
  return { items, nextCursor: rows.length > items.length && last ? Buffer.from(last.id, "utf8").toString("base64url") : null };
}
