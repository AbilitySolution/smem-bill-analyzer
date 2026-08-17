import type { DetectedInvoice } from "@/lib/anthropic/invoice-splitting";

/**
 * Découpage d'un scan multi-factures et rendu des aperçus, côté navigateur.
 *
 * Le découpage se fait ici plutôt que côté serveur pour une raison simple : le
 * navigateur a déjà le fichier en main. Le faire côté serveur imposerait de lui
 * renvoyer le PDF entier (jusqu'à 11,5 Mo, au-delà du plafond de corps de requête
 * d'une Vercel Function), puis de retélécharger les morceaux.
 *
 * `pdf-lib` et `pdfjs-dist` sont importés dynamiquement : ils pèsent lourd et ne
 * servent qu'aux dépôts multi-pages, une minorité des imports. Un import statique les
 * ferait payer à chaque visite de la page.
 */

/** Configuré une seule fois par session : réassigner le worker à chaque rendu le relancerait. */
let workerConfigured = false;

/** Nombre de pages du PDF, sans le charger entièrement en mémoire côté appelant. */
export async function countPdfPages(file: File): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  return document.getPageCount();
}

/**
 * Un fichier par facture détectée, nommé d'après le document d'origine.
 *
 * Le nom porte la plage de pages plutôt qu'un simple numéro d'ordre : si l'utilisateur
 * retrouve la facture plus tard, il peut la relier à sa page dans le scan d'archive.
 */
export async function splitPdfByRanges(file: File, invoices: DetectedInvoice[]): Promise<File[]> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  const baseName = file.name.replace(/\.pdf$/i, "");
  const parts: File[] = [];

  for (const invoice of invoices) {
    const target = await PDFDocument.create();
    // `copyPages` attend des index 0-indexés ; les plages détectées sont 1-indexées.
    const indices = Array.from(
      { length: invoice.end_page - invoice.start_page + 1 },
      (_, offset) => invoice.start_page - 1 + offset,
    ).filter((index) => index >= 0 && index < source.getPageCount());
    if (!indices.length) continue;

    const pages = await target.copyPages(source, indices);
    pages.forEach((page) => target.addPage(page));
    const bytes = await target.save();

    const suffix = invoice.start_page === invoice.end_page
      ? `p${invoice.start_page}`
      : `p${invoice.start_page}-${invoice.end_page}`;
    parts.push(
      new File([bytes as BlobPart], `${baseName}-${suffix}.pdf`, { type: "application/pdf" }),
    );
  }

  return parts;
}

/**
 * Miniature de la première page de chaque facture détectée, en data URL.
 *
 * Sert l'écran de confirmation : l'utilisateur doit pouvoir vérifier d'un coup d'œil
 * que le découpage tombe juste, sans ouvrir chaque fichier. Rendu à faible échelle —
 * il s'agit de reconnaître un en-tête de facture, pas de lire les montants.
 */
export async function renderPagePreviews(
  file: File,
  pageNumbers: number[],
  scale = 0.4,
): Promise<Array<string | null>> {
  const pdfjs = await import("pdfjs-dist");
  // Même résolution de worker que `components/documents/pdf-thumb.tsx` : le worker est
  // servi depuis le bundle, jamais depuis un CDN — le document reste local.
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    workerConfigured = true;
  }

  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const previews: Array<string | null> = [];

  for (const pageNumber of pageNumbers) {
    try {
      const page = await document.getPage(Math.max(1, Math.min(document.numPages, pageNumber)));
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) { previews.push(null); continue; }
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      previews.push(canvas.toDataURL("image/jpeg", 0.7));
    } catch {
      // Une page qui ne se rend pas ne doit pas faire échouer tout l'écran de
      // confirmation : la facture reste listée, sans vignette.
      previews.push(null);
    }
  }

  return previews;
}
