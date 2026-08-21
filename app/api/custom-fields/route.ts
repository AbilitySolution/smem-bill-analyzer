import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";

/**
 * Lecture des définitions de champs personnalisés.
 *
 * La matrice (lib/authz.ts) classe /api/custom-fields en administrateur, parce que
 * *définir* un champ personnalisé est un acte d'administration. La lecture, elle, reste
 * ouverte à tout utilisateur authentifié : /upload/review l'appelle pour construire son
 * formulaire, et la réserver casserait l'import de documents pour les membres — c'est-à-dire
 * leur usage principal. L'exemption est explicite dans API_LECTURE_OUVERTE ; toute méthode
 * d'écriture ajoutée ici retombera d'office sous la garde administrateur du middleware.
 */
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
