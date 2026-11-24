import { redirect } from "next/navigation";

/** Legacy setup links resolve inside the unified customer billing page, never Platform Admin. */
export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{ plan?: string | string[]; term?: string | string[] }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const query = new URLSearchParams();
  if (typeof params?.plan === "string" && params.plan) query.set("plan", params.plan);
  if (params?.term === "monthly" || params?.term === "yearly") query.set("term", params.term);
  const suffix = query.toString();
  redirect(suffix ? `/billing?${suffix}` : "/billing");
  return null;
}
