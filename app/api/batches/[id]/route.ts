import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: batch } = await supabase
    .from("extraction_batches")
    .select("id, status, total_count, imported_count, failed_count, error, created_at, completed_at")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();

  if (!batch) return NextResponse.json({ error: "Lot introuvable." }, { status: 404 });

  const { data: items, error } = await supabase
    .from("extraction_batch_items")
    .select("id, original_name, status, invoice_id, suggested_commune_id, input_tokens, output_tokens, error")
    .eq("batch_id", id)
    .order("original_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ batch, items });
}
