import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: pending } = await supabase
    .from("pending_uploads")
    .select("*, communes(nom)")
    .eq("id", id)
    .single();

  if (!pending) return NextResponse.json({ error: "Introuvable" }, { status: 404 });

  const { data: signed } = await supabase.storage
    .from("pending-uploads")
    .createSignedUrl(pending.file_path, 600);

  return NextResponse.json({ pending, signedUrl: signed?.signedUrl ?? null });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json();
  await supabase.from("pending_uploads").update({ status: body.processed ? "done" : "pending" }).eq("id", id);
  return NextResponse.json({ success: true });
}
