import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserContext } from "@/lib/auth";
import { createAnthropicClient, retryWithBackoff } from "@/lib/anthropic/client";
import {
  MAX_PAGES_PER_DETECTION,
  buildSplitDetectionParams,
  parseDetectedInvoices,
} from "@/lib/anthropic/invoice-splitting";

export const runtime = "nodejs";
/**
 * Un scan de 58 pages représente environ 135 000 tokens en vision : l'appel se compte
 * en dizaines de secondes. Le plafond est pris large — l'utilisateur attend devant
 * l'écran de confirmation, mieux vaut aboutir que retomber sur un timeout.
 */
export const maxDuration = 300;

/**
 * Détection des factures contenues dans un scan multi-pages.
 *
 * Appelée depuis la page d'import après le dépôt direct du fichier dans le bucket, et
 * AVANT toute mise en file : l'utilisateur voit ce qui a été détecté et valide avant
 * que le moindre job ne soit créé. Rien n'est découpé ici — la route ne fait que
 * rendre un verdict de frontières, le découpage se fait côté navigateur une fois
 * l'utilisateur d'accord.
 *
 * Le fichier transite par l'API Files du fournisseur plutôt qu'inliné dans la requête :
 * ces scans pèsent jusqu'à 11,5 Mo, très au-delà du plafond de corps de requête d'une
 * Vercel Function (4,5 Mo, fixe et non configurable).
 */
export async function POST(request: Request) {
  const ctx = await getUserContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const filePath = typeof body?.file_path === "string" ? body.file_path : null;
  if (!filePath) return NextResponse.json({ error: "Chemin de fichier manquant." }, { status: 400 });

  // Même garde que `POST /api/document-jobs` : la policy RLS a déjà empêché d'ÉCRIRE
  // ailleurs que sous son propre préfixe, mais rien n'empêche de référencer ici le
  // chemin d'un autre client — la lecture doit être revérifiée côté serveur.
  if (!filePath.startsWith(`${ctx.orgId}/${ctx.userId}/`)) {
    return NextResponse.json({ error: "Chemin de dépôt invalide." }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: blob, error: downloadError } = await admin.storage.from("invoice-files").download(filePath);
  if (downloadError || !blob) {
    return NextResponse.json({ error: "Fichier introuvable dans le dépôt." }, { status: 404 });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let pageCount: number;
  try {
    pageCount = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    return NextResponse.json({ error: "PDF illisible ou protégé." }, { status: 422 });
  }

  if (pageCount > MAX_PAGES_PER_DETECTION) {
    return NextResponse.json(
      { error: `Document de ${pageCount} pages — au-delà de ${MAX_PAGES_PER_DETECTION}, scindez-le avant l'import.` },
      { status: 413 },
    );
  }

  const anthropic = createAnthropicClient();
  let uploadedFileId: string | null = null;
  try {
    const uploaded = await retryWithBackoff(() =>
      anthropic.beta.files.upload({
        file: new File([bytes], "document.pdf", { type: "application/pdf" }),
        betas: ["files-api-2025-04-14"],
      }),
    );
    uploadedFileId = uploaded.id;

    const message = await retryWithBackoff(() =>
      anthropic.beta.messages.create(buildSplitDetectionParams(uploaded.id)),
    );

    const invoices = parseDetectedInvoices(message.content, pageCount);
    return NextResponse.json({
      page_count: pageCount,
      invoices,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error("[detect-invoices] échec", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Analyse du document impossible. Réessayez." }, { status: 502 });
  } finally {
    // Le document reste confidentiel : le fichier distant est retiré dans tous les cas,
    // succès comme échec. Non bloquant — un échec de suppression ne doit pas faire
    // perdre à l'utilisateur une analyse qui a abouti.
    if (uploadedFileId) {
      await anthropic.beta.files
        .delete(uploadedFileId, { betas: ["files-api-2025-04-14"] })
        .catch(() => {});
    }
  }
}
