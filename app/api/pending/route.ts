import { NextResponse } from "next/server";
import { getUserContext } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pending_uploads")
    .select("*, communes(nom)")
    .eq("org_id", ctx.orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pending: data });
}
