import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { createAnthropicClient } from "@/lib/anthropic/client";
import { buildExtractionParams } from "@/lib/anthropic/extraction-request";
import {
  MAX_FILES_PER_BATCH,
  MAX_BATCH_BASE64_BYTES,
  mediaTypeFromName,
} from "@/lib/batches/constants";

export const runtime = "nodejs";
// Télécharger et encoder jusqu'à 100 PDF prend du temps ; la valeur par défaut est trop courte.
export const maxDuration = 300;

const submitSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      original_name: z.string().min(1),
    }),
  ).min(1),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = submitSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides.", details: parsed.error.format() }, { status: 400 });
  }
  const { files } = parsed.data;

  if (files.length > MAX_FILES_PER_BATCH) {
    return NextResponse.json(
      { error: `${files.length} fichiers : maximum ${MAX_FILES_PER_BATCH} par import. Scindez votre archive.` },
      { status: 400 },
    );
  }

  // Le client choisit le chemin de stockage : sans ce contrôle, il pourrait désigner le
  // fichier d'une autre organisation et le faire extraire à son profit. La policy RLS du
  // bucket empêche l'écriture ailleurs, mais rien n'empêcherait la LECTURE via ce chemin
  // puisque l'extraction tourne côté serveur.
  const expectedPrefix = `${ctx.orgId}/${ctx.userId}/`;
  const foreign = files.find((f) => !f.path.startsWith(expectedPrefix));
  if (foreign) {
    return NextResponse.json({ error: "Chemin de fichier non autorisé." }, { status: 403 });
  }

  const unsupported = files.find((f) => mediaTypeFromName(f.original_name) === null);
  if (unsupported) {
    return NextResponse.json(
      { error: `Format non supporté : ${unsupported.original_name}` },
      { status: 400 },
    );
  }

  // 1. Créer le lot et ses items AVANT d'appeler Anthropic : si la soumission échoue,
  //    les lignes restent en base avec l'erreur, plutôt que de disparaître sans trace.
  const { data: batch, error: batchError } = await supabase
    .from("extraction_batches")
    .insert({
      org_id: ctx.orgId,
      status: "preparing",
      total_count: files.length,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ error: `Création du lot: ${batchError?.message}` }, { status: 500 });
  }
  const batchId = batch.id as string;

  const { data: items, error: itemsError } = await supabase
    .from("extraction_batch_items")
    .insert(
      files.map((f) => ({
        batch_id: batchId,
        org_id: ctx.orgId,
        file_path: f.path,
        original_name: f.original_name,
        status: "pending",
      })),
    )
    .select("id, file_path, original_name");

  if (itemsError || !items) {
    await supabase.from("extraction_batches")
      .update({ status: "failed", error: `Création des items: ${itemsError?.message}` })
      .eq("id", batchId);
    return NextResponse.json({ error: `Création des items: ${itemsError?.message}` }, { status: 500 });
  }

  // 2. Construire une requête d'extraction par document. `custom_id` = id de l'item :
  //    c'est la seule clé qui relie une réponse du batch à sa ligne en base, les
  //    résultats revenant dans un ordre quelconque.
  try {
    const requests: Array<{ custom_id: string; params: ReturnType<typeof buildExtractionParams> }> = [];
    let totalBase64 = 0;

    for (const item of items) {
      const { data: blob, error: dlError } = await supabase.storage
        .from("invoice-files")
        .download(item.file_path);

      if (dlError || !blob) {
        throw new Error(`Lecture de ${item.original_name}: ${dlError?.message ?? "fichier introuvable"}`);
      }

      const base64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
      totalBase64 += base64.length;
      if (totalBase64 > MAX_BATCH_BASE64_BYTES) {
        throw new Error(
          "Volume total trop important pour un seul lot. Scindez votre archive en plusieurs imports.",
        );
      }

      const mediaType = mediaTypeFromName(item.original_name);
      if (!mediaType) throw new Error(`Format non supporté : ${item.original_name}`);

      requests.push({ custom_id: item.id, params: buildExtractionParams(base64, mediaType) });
    }

    const anthropic = createAnthropicClient();
    const messageBatch = await anthropic.messages.batches.create({ requests });

    const { error: updateError } = await supabase
      .from("extraction_batches")
      .update({
        anthropic_batch_id: messageBatch.id,
        status: "submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId);

    if (updateError) {
      // Le lot tourne chez Anthropic mais on a perdu son identifiant : le signaler
      // explicitement plutôt que de laisser une ligne muette.
      console.error("[batches] identifiant de lot non enregistré", {
        batchId, anthropicBatchId: messageBatch.id, error: updateError.message,
      });
      return NextResponse.json({ error: "Lot soumis mais non enregistré. Contactez le support." }, { status: 500 });
    }

    return NextResponse.json({
      batch_id: batchId,
      anthropic_batch_id: messageBatch.id,
      total_count: files.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Soumission du lot échouée.";
    await supabase.from("extraction_batches")
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", batchId);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("extraction_batches")
    .select("id, status, total_count, imported_count, failed_count, error, created_at, completed_at")
    .eq("org_id", ctx.orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ batches: data });
}
