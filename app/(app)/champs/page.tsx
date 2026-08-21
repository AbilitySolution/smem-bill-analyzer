import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth-guard";

// « Champs d'extraction » est désormais un onglet de la page Documentation.
// La garde est celle de la matrice (/champs = administrateur) et non celle de la page
// d'arrivée : sans elle, ce chemin resté public dans les favoris contournerait le
// middleware si la matrice venait à changer.
export default async function ChampsRedirect() {
  await requireRole("org_admin");
  redirect("/documentation/champs");
}
