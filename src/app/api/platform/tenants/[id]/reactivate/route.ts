import { platformWorkspaceLifecycle } from "../../../../../../lib/platform-workspace-lifecycle";
export async function POST(req:Request,context:{params:Promise<{id:string}>}){
 return platformWorkspaceLifecycle(req,(await context.params).id,'active');
}
