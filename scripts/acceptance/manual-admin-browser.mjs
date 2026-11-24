import {customerBrowserAcceptance} from './manual-customer-browser.mjs';
/** Real production browser hook for platform-browser.mjs. Synthetic data only.
 * Capture baseline with YASEIR_BROWSER_BASELINE=1 and YASEIR_BROWSER_ROOT pointing
 * at the verified V3 source; no absent baseline pages/revision are fabricated. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const labels={en:{subscriptions:'Plans & subscriptions',type:'Subscription type',quota:'Monthly job quota',term:'Duration',status:'Status',reason:'Administrative reason',preview:'Review changes',confirm:'Confirm and save',password:'Confirm your password',reject:'Reject request',saved:'Change saved and recorded in the audit history.'},ar:{subscriptions:'الباقات والاشتراكات'}};
export async function adminBrowserAcceptance({page,context,browser,db,origin,output,check,password,sensitive,baseline}){
 const tenantId='browser_palm_cafe',ownerId='browser_palm_owner',email='palm-owner@example.invalid',name='مقهى النخيل — Palm Café',plan='browser_monthly';
 const captures=[];let customerContext;
 const request=async(target,endpoint,body,method=body===undefined?'GET':'POST',key)=>target.evaluate(async({endpoint,body,method,key})=>{
  const r=await fetch(endpoint,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json().catch(()=>null)};
 },{endpoint,body,method,key});
 const settle=async()=>{await page.waitForFunction(()=>!document.body.innerText.includes('Loading…')&&!document.body.innerText.includes('جارٍ التحميل…'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 async function capture(slug,locale,width,url){
  await page.setViewportSize({width,height:width===390?844:1100});
  await context.addCookies([{name:'__Host-yaseir_locale',value:locale,url:origin,secure:true,sameSite:'Lax'}]);
  await page.evaluate(locale=>localStorage.setItem('yaseir:locale',locale),locale);
  await page.goto(origin+url,{waitUntil:'networkidle'});await settle();
  if(!baseline&&slug==='requests'){const refreshed=page.waitForResponse(r=>r.url().includes('/api/platform/subscription-requests?status=all'));void refreshed.catch(()=>{});await page.getByRole('combobox').selectOption('all');assert.equal((await refreshed).status(),200);await settle();}
  assert.equal(await page.locator('html').getAttribute('dir'),locale==='ar'?'rtl':'ltr');
  for(const input of await page.locator('input[type="password"]').all())assert.equal(await input.inputValue(),'');
  const text=await page.locator('body').innerText();assert.ok(!text.includes('v4.admin.'),'No untranslated admin key');
  if(!baseline&&slug.startsWith('workspace360')){
   const reset=(await db.query("SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 month','YYYY-MM-DD') AS day")).rows[0].day;
   const expected=await page.evaluate(({reset,locale})=>new Intl.DateTimeFormat(locale==='ar'?'ar-u-nu-latn':'en',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(reset+'T00:00:00Z')),{reset,locale});
   assert.ok(text.includes(expected),`UTC monthly reset date remains ${expected} in browser local timezone`);
  }
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(dimensions.scroll<=dimensions.width+2,`${slug}/${locale}/${width}: horizontal document overflow ${JSON.stringify(dimensions)}`);
  const file=`${baseline?'before':'after'}-${slug}-${locale}-${width}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});
  captures.push({file,path:url,locale,width,height:width===390?844:1100,documentWidth:dimensions.scroll,synthetic:true});
 }
 try {
  await db.query("INSERT INTO tenants(id,name) VALUES($1,$2)",[tenantId,name]);
  await db.query("INSERT INTO users(id,email,password_hash,email_verified_at) SELECT $1,$2,password_hash,clock_timestamp() FROM users WHERE is_platform_owner=true",[ownerId,email]);
  if(!baseline)await db.query('UPDATE users SET display_name=$1 WHERE id=$2',['سارة العتيبي',ownerId]);
  await db.query("INSERT INTO tenant_users(user_id,tenant_id,role) VALUES($1,$2,'owner')",[ownerId,tenantId]);
  await db.query("INSERT INTO plans(id,name,description,entitlements,is_active,is_public) VALUES($1,$2,$3,$4::jsonb,true,true)",[plan,'الباقة المرنة — Flexible','حصة شهرية لمهام الطباعة',JSON.stringify({max_agents:'unlimited',max_printers:'unlimited',max_jobs_per_minute:120,max_concurrent_jobs:100,max_prints_per_period:1500})]);
  if(baseline){
   await db.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'active',clock_timestamp()-interval '1 month',clock_timestamp()+interval '11 months')",[tenantId,plan]);
   check('Verified V3 baseline renders its actual original screens; unavailable V4 requests/360 are not fabricated');
  } else {
   customerContext=await browser.newContext({...(process.env.YASEIR_BROWSER_TIMEZONE?{timezoneId:process.env.YASEIR_BROWSER_TIMEZONE}:{}),locale:'en-US',viewport:{width:1440,height:1000},ignoreHTTPSErrors:false});
   await customerContext.addCookies([{name:'__Host-yaseir_locale',value:'en',url:origin,secure:true,sameSite:'Lax'}]);
   const customer=await customerContext.newPage();await customer.goto(origin+'/login?next=%2Fonboarding');
   await customer.locator('#email').fill(email);await customer.locator('#password').fill(password);
   const login=customer.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');void login.catch(()=>{});
   await customer.locator('form button[type="submit"]').click();assert.equal((await login).status(),200);await customer.waitForURL('**/onboarding');await customer.waitForLoadState('networkidle');
   const requestKey=randomUUID();const activation=await request(customer,'/api/subscription-requests',{planId:plan,term:'yearly',requestedMonthlyQuota:750},'POST',requestKey);
   assert.equal(activation.status,201);const requestId=activation.data.request.id;
   const pending=(await db.query('SELECT * FROM subscription_requests WHERE id=$1',[requestId])).rows[0];assert.equal(pending.requester_user_id,ownerId);assert.equal(pending.tenant_id,tenantId);assert.equal(pending.status,'pending');
   assert.equal((await request(customer,'/api/billing/status')).data.hasSubscription,false);
   check('Real password-authenticated customer creates one traceable pending activation request without granting access');
   await page.goto(origin+'/platform/subscription-requests');await page.getByText(email,{exact:true}).waitFor();await page.getByText('سارة العتيبي',{exact:true}).waitFor();
   await page.screenshot({path:path.join(output,'after-request-authenticated-en-1440.png'),fullPage:true});
   await page.getByRole('link',{name:'Review and activate',exact:true}).click();
   await page.getByRole('tab',{name:labels.en.subscriptions,exact:true}).click();
   await page.getByLabel(labels.en.type).selectOption('free');await page.getByLabel(labels.en.quota,{exact:true}).fill('750');
   await page.getByLabel(labels.en.term).selectOption('yearly');await page.getByLabel(labels.en.status).selectOption('active');
   await page.getByLabel(labels.en.reason,{exact:true}).first().fill('شراكة مجانية مع اعتماد الحصة السنوية');
   await page.getByRole('button',{name:labels.en.preview,exact:true}).click();
   assert.equal(await page.getByLabel(labels.en.password,{exact:true}).inputValue(),'');
   await page.screenshot({path:path.join(output,'after-subscription-review-en-1440.png'),fullPage:true});
   // Expire proof before confirmation: the UI must actually reauthenticate.
   await db.query("UPDATE platform_session_security SET password_verified_at=clock_timestamp()-interval '6 minutes'");
   const confirmation=page.waitForResponse(r=>r.url().endsWith('/api/platform/auth/reauth')&&r.request().method()==='POST');void confirmation.catch(()=>{});
   const activated=page.waitForResponse(r=>r.url().endsWith(`/api/platform/tenants/${tenantId}/subscription`)&&r.request().method()==='POST');void activated.catch(()=>{});
   await page.getByLabel(labels.en.password,{exact:true}).fill(password);await page.getByRole('button',{name:labels.en.confirm,exact:true}).click();
   assert.equal((await confirmation).status(),200);const saved=await activated;assert.equal(saved.status(),200);await page.getByText(labels.en.saved,{exact:true}).waitFor();
   const savedBody=saved.request().postDataJSON(),savedKey=(await saved.request().allHeaders())['idempotency-key'];
   const sub=(await db.query('SELECT * FROM tenant_subscriptions WHERE tenant_id=$1',[tenantId])).rows[0];assert.equal(sub.status,'active');assert.equal(sub.subscription_type,'free');assert.equal(sub.monthly_quota,750);assert.equal(sub.term,'yearly');
   assert.equal((await db.query('SELECT status FROM subscription_requests WHERE id=$1',[requestId])).rows[0].status,'approved');
   assert.equal((await request(customer,'/api/billing/status')).data.hasSubscription,true);
   check('Real admin editor previews and approves a free annual subscription with actual recent password reauthentication and recorded requester linkage');
   const replay=await request(page,`/api/platform/tenants/${tenantId}/subscription`,savedBody,'POST',savedKey);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
   const stale=await request(page,`/api/platform/tenants/${tenantId}/subscription`,savedBody,'POST',randomUUID());assert.equal(stale.status,409);assert.equal(stale.data.code,'SUBSCRIPTION_REVISION_CONFLICT');
   assert.equal((await db.query('SELECT count(*)::int AS n FROM subscription_changes WHERE tenant_id=$1',[tenantId])).rows[0].n,1);
   check('Browser API replay cannot duplicate activation/history and stale revisions are rejected');
   const renewal=await request(customer,'/api/subscription-requests',{planId:plan,term:'monthly'},'POST',randomUUID());assert.equal(renewal.status,201);
   await page.reload();await page.getByRole('tab',{name:labels.en.subscriptions,exact:true}).click();await page.getByRole('button',{name:labels.en.reject,exact:true}).click();
   const rejectForm=page.locator('form').filter({has:page.getByRole('button',{name:labels.en.reject,exact:true})});
   await rejectForm.getByLabel(labels.en.reason,{exact:true}).fill('طلب مكرر؛ الاشتراك السنوي نشط');await rejectForm.getByLabel(labels.en.password,{exact:true}).fill(password);
   const rejected=page.waitForResponse(r=>r.url().endsWith('/api/platform/subscription-requests')&&r.request().method()==='POST');void rejected.catch(()=>{});await rejectForm.getByRole('button',{name:labels.en.reject,exact:true}).click();const rejection=await rejected;assert.equal(rejection.status(),200);
   const rejectedBody=rejection.request().postDataJSON(),rejectedKey=(await rejection.request().allHeaders())['idempotency-key'];
   assert.equal((await request(page,'/api/platform/subscription-requests',rejectedBody,'POST',rejectedKey)).status,200);
   assert.equal((await request(page,'/api/platform/subscription-requests',{...rejectedBody,reason:'different'},'POST',rejectedKey)).status,409);
   check('Real request rejection form records its reason; compatible replay is safe and changed-reason replay conflicts');
   await customerBrowserAcceptance({customer,customerContext,origin,output,check});
   sensitive.push(...(await customerContext.cookies()).map(c=>c.value));
   await customerContext.close();customerContext=null;
  }
  const views=baseline?[
   ['overview','/platform/dashboard'],['workspaces','/platform/tenants'],['subscriptions','/platform/subscriptions'],['plans','/platform/plans'],['operations','/platform/fleet'],['security','/platform/security'],
  ]:[
   ['overview','/platform/dashboard'],['workspaces','/platform/tenants'],['requests','/platform/subscription-requests?status=all'],['subscriptions','/platform/subscriptions'],['security','/platform/security'],['workspace360',`/platform/tenants/${tenantId}`],['plans','/platform/plans'],
  ];
  for(const locale of ['en','ar'])for(const width of [1440,390])for(const [slug,url] of views)await capture(slug,locale,width,url);
  if(!baseline)for(const locale of ['en','ar'])for(const width of [1440,390]){
   await capture('workspace360-subscription-shell',locale,width,`/platform/tenants/${tenantId}`);
   await page.getByRole('tab',{name:labels[locale].subscriptions,exact:true}).click();await settle();
   const file=`after-workspace360-subscription-${locale}-${width}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});captures.push({file,locale,width,path:`/platform/tenants/${tenantId}`,tab:'subscription',synthetic:true});
  }
  check(`${captures.length} real ${baseline?'V3 baseline':'V4'} Arabic/English desktop/mobile captures with correct direction, empty password fields and no document overflow`);
 } catch(error) {
  await page.screenshot({path:path.join(output,"failure-admin.png"),fullPage:true,mask:[page.locator("input[type=password]")]}).catch(()=>{});
  fs.writeFileSync(path.join(output,"failure-admin.txt"),await page.locator("body").innerText().catch(()=>"Page unavailable"));
  throw error;
 } finally {
  await customerContext?.close();
  fs.writeFileSync(path.join(output,'admin-captures.json'),JSON.stringify({baseline,synthetic:true,captures,unavailableBaselineViews:baseline?['subscription requests','Workspace 360']:[]},null,2)+'\n');
 }
}
