import { requireRole } from "@/lib/auth-guard";
import { SettingsNav } from "@/components/parametres/settings-nav";

export default async function ParametresLayout({ children }: { children: React.ReactNode }) {
  await requireRole("org_admin");

  return (
    <div className="flex min-h-full flex-col bg-[var(--kn-page)] md:flex-row">
      <SettingsNav />
      <section className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          {children}
        </div>
      </section>
    </div>
  );
}
