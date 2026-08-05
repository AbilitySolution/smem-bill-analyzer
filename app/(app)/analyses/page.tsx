import { redirect } from "next/navigation";

interface LegacyAnalysesSearchParams {
  vue?: string;
  commune?: string;
  site?: string;
  cat?: string;
}

export default async function LegacyAnalysesPage({
  searchParams,
}: {
  searchParams: Promise<LegacyAnalysesSearchParams>;
}) {
  const { vue, commune, site, cat } = await searchParams;
  const destination = vue === "couverture" ? "/analyses/couverture" : "/analyses/consommation";
  const filters = new URLSearchParams();

  if (commune) filters.set("commune", commune);
  if (site) filters.set("site", site);
  if (cat) filters.set("cat", cat);

  redirect(`${destination}${filters.size ? `?${filters.toString()}` : ""}`);
}
