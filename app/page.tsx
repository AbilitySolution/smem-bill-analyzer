import { redirect } from "next/navigation";
import { getUserContext } from "@/lib/auth";

export default async function Home() {
  const ctx = await getUserContext();
  redirect(ctx ? "/upload" : "/accueil");
}
