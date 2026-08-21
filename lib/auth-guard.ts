import { redirect } from "next/navigation";
import { getUserContext, type UserContext } from "@/lib/auth";
import { hasAtLeast } from "@/lib/authz";
import type { UserRole } from "@/lib/types/database";

/**
 * Gardes de rôle pour Server Components et Server Actions.
 *
 * Séparé de `lib/auth.ts` parce qu'il importe `next/navigation` : `lib/auth.ts` doit
 * rester importable là où `redirect()` n'existe pas.
 *
 * Ce fichier ne porte pas `import "server-only"` : le paquet n'est pas installé et le
 * projet est hors ligne. `redirect()` de next/navigation lève de toute façon à l'appel
 * côté client, la protection est donc effective, simplement pas au moment de la
 * compilation. À ajouter au prochain `pnpm add server-only`.
 */

/** Redirige vers /login si pas de session, vers /documents si le rôle est insuffisant. */
export async function requireRole(required: UserRole): Promise<UserContext> {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");
  // Pas de page 403 : renvoyer vers /documents évite de confirmer à un utilisateur qui
  // tâtonne l'existence d'une page qu'il n'a pas à connaître, et le remet sur un écran
  // utile plutôt que sur un cul-de-sac.
  if (!hasAtLeast(ctx.role, required)) redirect("/documents");
  return ctx;
}
