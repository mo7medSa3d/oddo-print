import { validateAgent } from "./agent-auth";
import { validateWorkspaceManager, type ManagerClaims } from "./manager-auth";

type AgentClaims = NonNullable<Awaited<ReturnType<typeof validateAgent>>>;

export type ConsoleAuth =
  | { kind: "manager"; claims: ManagerClaims }
  | { kind: "agent"; agent: AgentClaims };

export async function validateConsoleAuth(req: Request): Promise<ConsoleAuth | null> {
  const manager = await validateWorkspaceManager(req);
  if (manager) return { kind: "manager", claims: manager };

  const agent = await validateAgent(req.headers.get("Authorization"));
  if (agent) return { kind: "agent", agent };

  return null;
}
