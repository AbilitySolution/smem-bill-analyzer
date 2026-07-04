import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("file_request_links")
    .select("id, label, communes(nom), expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!link || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 404 });
  }

  return NextResponse.json({ link });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: link } = await admin
    .from("file_request_links")
    .select("id, commune_id, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!link || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 404 });
  }

  const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]);

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json({ error: "Type de fichier non autorisé. Formats acceptés : PDF, JPEG, PNG, TIFF." }, { status: 415 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "Fichier trop volumineux (max 20 Mo)." }, { status: 413 });
  }

  const safeName = file.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_");
  const storagePath = `${link.commune_id}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await admin.storage
    .from("pending-uploads")
    .upload(storagePath, await file.arrayBuffer(), { contentType: file.type });

  if (uploadError) {
    return NextResponse.json({ error: `Upload échoué: ${uploadError.message}` }, { status: 500 });
  }

  await admin.from("pending_uploads").insert({
    commune_id: link.commune_id,
    file_request_link_id: link.id,
    file_path: storagePath,
    original_name: file.name,
  });

  return NextResponse.json({ success: true });
}
