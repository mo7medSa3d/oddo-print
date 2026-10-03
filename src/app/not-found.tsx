import { Compass, LayoutDashboard, Home } from "lucide-react";
import { Button } from "../components/ui";
import { getServerLocale, makeT } from "../i18n/server";

export default async function NotFound() {
  const t = makeT(await getServerLocale());
  return (
    <div className="ambient-surface flex min-h-[calc(100vh-3.5rem)] items-center justify-center py-14">
      <div className="relative z-10 mx-auto w-full max-w-[560px] px-5">
        <div className="card p-7 sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-sg border border-edge-subtle bg-surface-2 text-ink-3">
            <Compass className="h-5 w-5" aria-hidden />
          </div>

          <p className="text-eyebrow mt-5">{t("notFound.eyebrow")}</p>
          <h1 className="mt-1.5 text-2xl font-[640] tracking-[-0.02em] text-ink">
            {t("notFound.title")}
          </h1>
          <p className="mt-2 text-base leading-relaxed text-ink-2">
            {t("notFound.body")}
          </p>

          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button variant="primary" href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" aria-hidden />}>
              {t("notFound.openConsole")}
            </Button>
            <Button variant="ghost" href="/" icon={<Home className="h-4 w-4" aria-hidden />}>
              {t("notFound.backHome")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
