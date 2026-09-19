import { validateAgent } from "./agent-auth";
import { validateManager, type ManagerClaims } from "./manager-auth";

export type ConsoleAuth =
  | { kind: "manager"; claims: ManagerClaims }
  | { kind: "agent"; agent: Awaited<ReturnType<typeof validateAgent>> };

export async function validateConsoleAuth(req: Request): Promise<ConsoleAuth | null> {
  const manager = await validateManager(req);
  if (manager) return { kind: "manager", claims: manager };

  const agent = await validateAgent(req.headers.get("Authorization"));
  if (agent) return { kind: "agent", agent };

  return null;
}
