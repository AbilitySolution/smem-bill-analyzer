import { redirect } from "next/navigation";

// « Champs d'extraction » est désormais un onglet de la page Documentation.
export default function ChampsRedirect() {
  redirect("/documentation/champs");
}
