import { redirect } from "next/navigation";

// Ancien onglet — l'export Excel est désormais une page dédiée « Rapport Excel ».
export default async function ExportRedirect({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids } = await searchParams;
  redirect(ids ? `/rapport-excel?ids=${ids}` : "/rapport-excel");
}
