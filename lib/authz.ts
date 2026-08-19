import type { UserRole } from "@/lib/types/database";

/**
 * Source unique de vérité des autorisations par rôle.
 *
 * Ce module ne dépend ni de React, ni de next/navigation, ni de Supabase : il est importé
 * par le middleware (runtime Edge), par des Server Components et par les tests Vitest. Y
 * introduire une dépendance serveur casserait le middleware sans que rien ne le signale
 * avant l'exécution.
 */

/**
 * Les rôles sont hiérarchiques : un niveau supérieur peut tout ce que peut le niveau
 * inférieur. Ce choix évite la combinatoire d'un modèle à permissions unitaires, qui
 * n'est pas justifié tant que les besoins se rangent sur une seule échelle.
 */
export const ROLE_LEVEL: Record<UserRole, number> = {
  org_member: 1,
  org_supervisor: 2,
  org_admin: 3,
};

/** Libellés affichés. Découplés des valeurs en base, qui, elles, ne bougent pas. */
export const ROLE_LABELS: Record<UserRole, string> = {
  org_admin: "Administrateur",
  org_supervisor: "Superviseur",
  org_member: "Membre",
};

export function hasAtLeast(role: UserRole, required: UserRole): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

/** `true` si la chaîne est bien un rôle connu — utile face à une valeur venue de la base. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && value in ROLE_LEVEL;
}

export interface RouteRule {
  /** Préfixe de chemin, sans barre oblique finale. */
  prefix: string;
  role: UserRole;
}

/**
 * Matrice d'accès par préfixe, ordonnée du plus spécifique au moins spécifique : la
 * première règle qui correspond gagne. L'ordre est porteur de sens, pas cosmétique —
 * `/documents/extraction` doit précéder toute règle sur `/documents`, sinon la section
 * Extraction retomberait au niveau de `/documents` (ouvert à tous).
 *
 * Tout ce qui n'est pas listé est accessible à n'importe quel utilisateur authentifié :
 * l'isolation multi-tenant par `org_id` reste la frontière de sécurité, le rôle ne fait
 * que restreindre à l'intérieur d'une organisation.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  { prefix: "/parametres", role: "org_admin" },
  { prefix: "/champs", role: "org_admin" },
  { prefix: "/connecteurs", role: "org_admin" },
  { prefix: "/api/custom-fields", role: "org_admin" },
  { prefix: "/qualite-extraction", role: "org_supervisor" },
  { prefix: "/corrections", role: "org_supervisor" },
  { prefix: "/documents/extraction", role: "org_supervisor" },
  { prefix: "/exploitation", role: "org_supervisor" },
  { prefix: "/documentation", role: "org_supervisor" },
  { prefix: "/api/export/extraction", role: "org_supervisor" },
] as const;

/**
 * Routes API dont la LECTURE reste ouverte à tout utilisateur authentifié, alors que le
 * chemin est par ailleurs réservé.
 *
 * `/api/custom-fields` est le seul cas : la définition des champs personnalisés est une
 * affaire d'administrateur, mais `/upload/review` — page ouverte à tous les rôles — la lit
 * pour afficher le formulaire de révision. La réserver entièrement à l'admin casserait
 * l'import de documents pour les membres, c'est-à-dire leur usage principal.
 */
export const API_LECTURE_OUVERTE: readonly string[] = ["/api/custom-fields"] as const;

/**
 * Routes délibérément ABSENTES de la matrice, parce qu'un préfixe ne sait pas les
 * découper, et gardées dans leur handler :
 *
 * - `PATCH /api/invoices/[id]` — correction d'une facture, réservée au superviseur.
 *   Un préfixe `/api/invoices` capturerait aussi le `POST` de collection, qui est
 *   l'enregistrement d'une facture depuis /upload/review : l'usage principal du membre.
 * - `dismissCorrections()` (app/(app)/corrections/actions.ts) — un Server Action ne
 *   traverse pas le proxy, aucune règle de chemin ne peut l'atteindre.
 *
 * Ajouter une règle ici pour l'une des deux ne les protégerait pas mieux et casserait
 * l'import de documents. Cette liste est documentaire : elle existe pour que la prochaine
 * lecture de la matrice ne conclue pas à un oubli.
 */

/** Correspondance sur segment complet : `/champs` ne doit pas capturer `/champs-perso`. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** Rôle minimum requis pour un chemin. `null` = accessible à tout utilisateur authentifié. */
export function requiredRoleFor(pathname: string): UserRole | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const rule of ROUTE_RULES) {
    if (matchesPrefix(normalized, rule.prefix)) return rule.role;
  }
  return null;
}

/** `true` si cette requête est une lecture explicitement exemptée (voir API_LECTURE_OUVERTE). */
export function estLectureOuverte(pathname: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return API_LECTURE_OUVERTE.some((prefix) => matchesPrefix(pathname, prefix));
}
