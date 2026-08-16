import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { getCorrectionItems } from "@/lib/data/corrections";
import { CorrectionsView } from "@/components/corrections/corrections-view";

/**
 * Rattrapage des factures enregistrées automatiquement mais lues avec un doute.
 *
 * Complète la révision de dépôt (`/upload/review`) sans la recouvrir : celle-ci
 * traite un document AVANT enregistrement, celle-là corrige ce qui est DÉJÀ en base
 * et compté dans les analyses. Les deux ne se disputent donc jamais le même document.
 */
export const dynamic = "force-dynamic";

export default async function CorrectionsPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  const items = await getCorrectionItems();
  return <CorrectionsView items={items} />;
}
