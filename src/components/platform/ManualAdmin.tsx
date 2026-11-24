"use client";
import { formatManualCalendarDate } from "../../lib/manual-calendar-date";
import { useCallback } from "react";
import { useI18n } from "../../i18n/react";
import type { MessageKey } from "../../i18n/messages/en";
import { fetchWithTimeout } from "../../lib/fetch-timeout";
export function useAdminText(){const i18n=useI18n();const {t}=i18n;const formatDate=useCallback((value:Date|string|number|null|undefined)=>formatManualCalendarDate(value,i18n.locale)??t("common.notAvailable"),[i18n.locale,t]);return {...i18n,formatDate};}
export async function adminJson(url:string,options?:RequestInit){const res=await fetchWithTimeout(url,{credentials:'same-origin',cache:'no-store',...options});const data=await res.json().catch(()=>({}));if(!res.ok){if((res.status===401||data.code==='PLATFORM_AUTHORITY_CHANGED')&&typeof window!=="undefined"){const next=window.location.pathname+window.location.search+window.location.hash;window.location.replace(`/platform/login?next=${encodeURIComponent(next)}`);}throw new Error(data.code??'MANUAL_SUBSCRIPTION_UNAVAILABLE');}return data;}
export const controlClass='w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-ink focus:outline-none focus:ring-2 focus:ring-brand/40';
export function AdminMetric({label,value,detail,icon}:{label:string;value:React.ReactNode;detail?:React.ReactNode;icon?:React.ReactNode}){
  return <div className="rounded-xl border border-edge-subtle bg-surface p-5">
    <div className="flex items-start justify-between gap-3">
      <p className="text-sm font-medium text-ink-3">{label}</p>
      {icon&&<span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand" aria-hidden="true">{icon}</span>}
    </div>
    <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
    {detail&&<div className="mt-2 text-sm tabular-nums text-ink-3">{detail}</div>}
  </div>;
}
export function AdminStatus({status}:{status:string}){const {t}=useI18n();return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${status==='active'||status==='approved'?'bg-ok/10 text-ok':status==='suspended'||status==='expired'||status==='rejected'?'bg-warn/10 text-warn':'bg-surface-2 text-ink-2'}`}>{t(`v4.admin.${status}` as MessageKey)}</span>;}
