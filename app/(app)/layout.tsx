import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { AbilitySidebar } from "@/components/koncile/kn-sidebar";

const ROLE_LABELS: Record<string, string> = {
  admin_smem: "Admin SMEM",
  agent_commune: "Agent commune",
};

export default async function AppGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white text-[#1a1a1a]">
      <AbilitySidebar
        user={{ email: ctx.email, roleLabel: ROLE_LABELS[ctx.role] ?? ctx.role }}
        isAdmin={ctx.role === "admin_smem"}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
