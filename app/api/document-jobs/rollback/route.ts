import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Annule un lot d'enregistrements automatiques : supprime les factures auto-enregistrées concernées
 * (uniquement celles de l'utilisateur, marquées auto_saved) et remet les jobs en révision manuelle.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const invoiceIds: string[] = Array.isArray(body?.invoice_ids) ? body.invoice_ids.filter((x: unknown) => typeof x === "string") : [];
  const jobIds: string[] = Array.isArray(body?.job_ids) ? body.job_ids.filter((x: unknown) => typeof x === "string") : [];

  const admin = createAdminClient();

  if (invoiceIds.length) {
    // Sécurité : ne supprimer QUE des factures auto-enregistrées appartenant à l'utilisateur.
    const { data: owned } = await supabase
      .from("invoices")
      .select("id")
      .in("id", invoiceIds)
      .eq("created_by", authData.user.id)
      .eq("auto_saved", true);
    const deletableIds = (owned ?? []).map((r) => r.id);

    if (deletableIds.length) {
      // Enfants d'abord (au cas où pas de cascade), puis les factures.
      await admin.from("anomalies").delete().in("invoice_id", deletableIds);
      await admin.from("invoice_tags").delete().in("invoice_id", deletableIds);
      await admin.from("invoice_charges").delete().in("invoice_id", deletableIds);
      await admin.from("consumption_periods").delete().in("invoice_id", deletableIds);
      await admin.from("invoices").delete().in("id", deletableIds);
    }
  }

  if (jobIds.length) {
    // Remettre les jobs en révision manuelle pour que l'utilisateur les reprenne.
    await admin
      .from("document_jobs")
      .update({ status: "needs_review", processed_invoice_id: null, updated_at: new Date().toISOString() })
      .in("id", jobIds)
      .eq("created_by", authData.user.id);
  }

  return NextResponse.json({ success: true });
}
