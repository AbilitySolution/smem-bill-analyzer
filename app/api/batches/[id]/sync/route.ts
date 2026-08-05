import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { syncBatch } from "@/lib/batches/sync";

export const runtime = "nodejs";
// L'import enchaîne un enregistrement complet par facture (site, client, contrat,
// lignes, anomalies) : sur un lot de 100, la valeur par défaut est trop courte.
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // La RLS filtre déjà par org, mais on vérifie explicitement pour renvoyer un 404
  // franc plutôt qu'une erreur « lot introuvable » venue du fond de la logique.
  const { data: batch } = await supabase
    .from("extraction_batches").select("id").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!batch) return NextResponse.json({ error: "Lot introuvable." }, { status: 404 });

  try {
    const outcome = await syncBatch(supabase, id);
    return NextResponse.json(outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Synchronisation échouée.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
