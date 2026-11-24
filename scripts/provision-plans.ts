import { db,pool } from "../src/db";
import { plans } from "../src/db/schema";
import { parseManualPlan } from "../src/lib/manual-plans";
import { writeAuditEvent } from "../src/lib/audit";
/** Bootstrap catalog only; never creates or activates a customer subscription. */
async function main(){
 const raw=process.env.YASEIR_PLAN_CATALOG;
 if(!raw)throw new Error('YASEIR_PLAN_CATALOG must be a JSON array of {id,name,description,monthlyQuota}');
 const parsed=JSON.parse(raw);if(!Array.isArray(parsed)||!parsed.length)throw new Error('Invalid catalog');
 for(const input of parsed){const plan=parseManualPlan(input);await db.transaction(async tx=>{
  const inserted=await tx.insert(plans).values(plan).onConflictDoNothing().returning({id:plans.id});
  if(inserted.length)await writeAuditEvent({tenantId:null,actorType:'platform',action:'plan.bootstrap',resourceType:'plan',resourceId:plan.id,metadata:{after:plan}},tx);
 });}
 console.log(`Processed ${parsed.length} manual plans; existing plans preserved.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());
