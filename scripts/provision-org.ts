/**
 * Provisionne une nouvelle organisation cliente + son premier utilisateur org_admin.
 * Usage : npx tsx scripts/provision-org.ts --org "Acme Corp" --email admin@acme.com
 *
 * Seed le socle des 20 communes de Martinique (SCRUM-14) : un nouveau client démarre
 * avec la même base que le SMEM, puis complète lui-même parmi les 14 restantes depuis
 * la page Paramètres. Les noms, codes INSEE et coordonnées viennent du référentiel —
 * une organisation neuve n'a aucun historique d'orthographe à préserver.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { communesDuSocle } from "../lib/communes/socle";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const DEFAULT_TAGS = [
  { label: "À vérifier", color: "amber" },
  { label: "Validée", color: "green" },
  { label: "Anomalie", color: "red" },
  { label: "Duplicata", color: "gray" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgName = arg("--org");
  const email = arg("--email");
  if (!orgName || !email) {
    console.error("Usage: npx tsx scripts/provision-org.ts --org <nom> --email <email-admin>");
    process.exit(1);
  }

  const env = loadEnv();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: org, error: orgErr } = await admin.from("organizations").insert({ nom: orgName }).select().single();
  if (orgErr || !org) throw new Error(`Création organisation échouée: ${orgErr?.message}`);

  const tempPassword = randomBytes(12).toString("base64url");
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });
  if (userErr || !userData.user) {
    // Pas de transaction cross-service possible — nettoyage compensatoire.
    await admin.from("organizations").delete().eq("id", org.id);
    throw new Error(`Création utilisateur échouée: ${userErr?.message}`);
  }

  const { error: roleErr } = await admin.from("user_roles").insert({
    user_id: userData.user.id,
    role: "org_admin",
    org_id: org.id,
  });
  if (roleErr) throw new Error(`Insertion user_roles échouée: ${roleErr.message}`);

  const { error: tagErr } = await admin
    .from("tags")
    .insert(DEFAULT_TAGS.map((t) => ({ ...t, org_id: org.id })));
  if (tagErr) console.warn(`Avertissement seed tags: ${tagErr.message}`);

  // Socle des 20 communes. Échec bloquant, contrairement aux tags : une organisation
  // sans commune ne peut ni recevoir de facture ni afficher la moindre analyse.
  const socle = communesDuSocle();
  const { error: communeErr } = await admin.from("communes").insert(
    socle.map((c) => ({
      org_id: org.id,
      nom: c.nom,
      code_insee: c.codeInsee,
      latitude: c.latitude,
      longitude: c.longitude,
    })),
  );
  if (communeErr) throw new Error(`Seed des communes échoué: ${communeErr.message}`);

  console.log(`✔ Organisation "${orgName}" créée (id: ${org.id})`);
  console.log(`✔ ${socle.length} communes du socle Martinique créées (14 restantes ajoutables depuis /parametres)`);
  console.log(`✔ Utilisateur admin ${email} créé (id: ${userData.user.id})`);
  console.log(`  Mot de passe temporaire (à transmettre de façon sécurisée, forcer un reset à la 1ère connexion) : ${tempPassword}`);
}

main().catch((e) => { console.error("✖ Échec du provisioning :", e.message ?? e); process.exit(1); });
