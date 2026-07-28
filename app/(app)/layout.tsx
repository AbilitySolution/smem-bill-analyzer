import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { AbilitySidebar } from "@/components/koncile/kn-sidebar";
import { TopBar } from "@/components/app-shell/top-bar";

const ROLE_LABELS: Record<string, string> = {
  org_admin: "Administrateur",
  org_member: "Membre",
};

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[var(--kn-page)] text-[var(--kn-text)]">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <AbilitySidebar
          user={{ email: ctx.email, roleLabel: ROLE_LABELS[ctx.role] ?? ctx.role }}
          isAdmin={ctx.role === "org_admin"}
        />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
