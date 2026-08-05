import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { DocumentQueue } from "@/components/upload/document-queue";

/**
 * Import de factures : une seule page pour un document comme pour deux cents.
 *
 * Le mode de traitement est déduit du volume déposé (voir `processingModeFor`) et non
 * choisi par l'utilisateur : petit lot = extraction rapide, gros lot = tarif réduit.
 *
 * L'`org_id` est résolu ici pour que le composant client puisse s'abonner au flux
 * Realtime de son organisation.
 */
export default async function UploadPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  return <DocumentQueue orgId={ctx.orgId} />;
}
