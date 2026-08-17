import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { DocumentQueue } from "@/components/upload/document-queue";

/**
 * Import de factures : une seule page pour un document comme pour deux cents.
 *
 * Le mode de traitement est déduit du volume déposé (voir `processingModeFor`) et non
 * choisi par l'utilisateur : petit lot = extraction rapide, gros lot = tarif réduit.
 *
 * `org_id` et `user_id` sont résolus ici : le premier pour l'abonnement Realtime, les
 * deux pour construire le chemin de dépôt direct navigateur → Supabase Storage
 * (`{org_id}/{user_id}/…`, imposé par la policy RLS `org_upload_invoice_files`).
 */
export default async function UploadPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  return <DocumentQueue orgId={ctx.orgId} userId={ctx.userId} />;
}
