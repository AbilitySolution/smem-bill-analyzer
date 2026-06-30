import { redirect } from "next/navigation";

// Ancienne route détail — redirige vers l'onglet Extraction du hub « Mes documents ».
export default async function FactureDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/documents/extraction?id=${id}`);
}
