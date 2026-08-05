import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { saveInvoice, saveRequestSchema } from "@/lib/invoices/save";

export async function POST(request: Request) {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = saveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Données invalides.", details: parsed.error.format() },
      { status: 400 },
    );
  }

  // Toute la logique d'enregistrement vit dans lib/invoices/save.ts, partagée avec
  // l'import en lot. Statut par défaut `reviewed` : l'utilisateur vient de relire.
  const result = await saveInvoice(supabase, ctx, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ invoice_id: result.invoiceId });
}

export async function GET(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const communeId = searchParams.get("commune_id");
  const categorie = searchParams.get("categorie");
  const siteId = searchParams.get("site_id");

  let query = supabase
    .from("invoices")
    .select(
      "*, sites(nom, categorie, commune_id), communes(nom), invoice_tags(tags(id, label, color))",
    )
    .eq("org_id", ctx.orgId)
    .order("facture_date", { ascending: false });

  if (communeId) query = query.eq("commune_id", communeId);
  if (categorie) query = query.eq("categorie", categorie);
  if (siteId) query = query.eq("site_id", siteId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ invoices: data });
}
