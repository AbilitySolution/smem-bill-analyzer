import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";
import { BatchUploader } from "@/components/upload/batch-uploader";

/**
 * Import en lot : le ZIP est dézippé et téléversé **dans le navigateur**, jamais envoyé
 * au serveur. On a donc besoin ici de l'org et de l'utilisateur, car le chemin de
 * stockage `{org_id}/{user_id}/…` est imposé par la policy RLS du bucket.
 */
export default async function BatchUploadPage() {
  const ctx = await getUserContext();
  if (!ctx) redirect("/login");

  return <BatchUploader orgId={ctx.orgId} userId={ctx.userId} />;
}
