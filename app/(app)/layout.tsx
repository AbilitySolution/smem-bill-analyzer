import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { getPlatformOperator } from "@/lib/auth-platform";
import { ROLE_LABELS } from "@/lib/authz";
import { AbilitySidebar } from "@/components/koncile/kn-sidebar";
import { TopBar } from "@/components/app-shell/top-bar";

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");
  const operator = await getPlatformOperator();

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[var(--kn-page)] text-[var(--kn-text)]">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <AbilitySidebar
          user={{ email: ctx.email, roleLabel: ROLE_LABELS[ctx.role] ?? ctx.role }}
          role={ctx.role}
          isPlatformOperator={operator !== null}
        />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
