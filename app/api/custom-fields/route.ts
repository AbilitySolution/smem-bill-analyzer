import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";

export async function GET(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const section = searchParams.get("section");

  let query = supabase
    .from("custom_field_definitions")
    .select("id, section, label, field_type")
    .eq("org_id", ctx.orgId)
    .order("label");
  if (section) query = query.eq("section", section);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ definitions: data });
}
