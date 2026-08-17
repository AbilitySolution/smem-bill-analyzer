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

/** Lignes par page. Tient dans un écran sans défilement interminable, et garde le HTML
 *  rendu côté serveur léger — cette liste n'est pas virtualisée. */
const PAGE_SIZE = 20;

export default async function CorrectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  const { page } = await searchParams;
  const allItems = await getCorrectionItems();
  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  // Page hors bornes (lien périmé, saisie manuelle) ramenée dans l'intervalle plutôt
  // que rendue vide : une liste vide sans explication passerait pour un bug.
  const currentPage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const items = allItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <CorrectionsView
      items={items}
      allItemIds={allItems.map((item) => item.id)}
      currentPage={currentPage}
      totalPages={totalPages}
      totalItems={allItems.length}
    />
  );
}
