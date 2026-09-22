import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import { ThemeToggle } from "./ThemeToggle";

export function AuthShell({
  children,
  subtitle = "Secure workspace access",
}: {
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-app px-4 py-10 sm:px-6">
      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle />
      </div>
      <div className="relative z-10 w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <BrandMark size="lg" title="Yasser" subtitle={subtitle} />
        </div>
        {children}
        <p className="mt-5 text-center text-[11px] text-ink-4">
          Yasser Cloud Printing Platform
        </p>
      </div>
    </main>
  );
}
