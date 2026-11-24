"use client";
import { useState } from "react";
import { Button } from "../ui";
import { adminJson,controlClass } from "./ManualAdmin";
import { useI18n } from "../../i18n/react";
import type { MessageKey } from "../../i18n/messages/en";
/** Existing audited lifecycle API retains the tenant dispatch fence. */
export function WorkspaceLifecycle({tenantId,lifecycle,updatedAt,onSaved}:{tenantId:string;lifecycle:string;updatedAt:string;onSaved:()=>void}){
 const {t}=useI18n(),[key,setKey]=useState(''),[open,setOpen]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 if(lifecycle==='deleted')return null;
 const action=lifecycle==='suspended'?'reactivate':'suspend';
 async function submit(e:React.FormEvent){e.preventDefault();if(busy)return;setBusy(true);try{await adminJson(`/api/platform/tenants/${encodeURIComponent(tenantId)}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({reason,expectedLifecycle:lifecycle,expectedUpdatedAt:updatedAt})});setOpen(false);onSaved();}catch{setError(t("v4.admin.saveError"));}finally{setBusy(false);}}
 return <div className="mt-5 border-t border-edge pt-4">{error&&<p role="alert" className="mb-3 text-sm text-bad">{error}</p>}{open?<form onSubmit={submit} aria-busy={busy||undefined} className="space-y-3"><p className="text-sm font-medium">{t(`v4.admin.${action==='suspend'?'suspendWorkspace':'reactivateWorkspace'}` as MessageKey)}</p><label className="block space-y-1.5 text-sm"><span className="block font-medium text-ink-2">{t("v4.admin.reason")}</span><textarea className={controlClass} disabled={busy} maxLength={500} required value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="flex flex-wrap gap-2"><Button disabled={busy||!reason.trim()} loading={busy} type="submit">{busy?t("common.saving"):t("v4.admin.confirm")}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>{setOpen(false);setError('');}}>{t("v4.admin.cancel")}</Button></div></form>:<Button variant="secondary" onClick={()=>{setKey(crypto.randomUUID());setError('');setOpen(true);}}>{t(`v4.admin.${action==='suspend'?'suspendWorkspace':'reactivateWorkspace'}` as MessageKey)}</Button>}</div>;
}
