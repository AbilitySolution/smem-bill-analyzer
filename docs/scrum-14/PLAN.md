# SCRUM-14 — [Feature] Permettre d'ajouter une commune

Analyse préalable + plan d'action pour agent de code IA.
Repo : `Projet_pilote_bill/smem-bill-analyzer` · DB : Supabase `smem-bill-analyzer` (prod) / `-staging`
Date : 2026-08-16 · Auteur : Sulayman

---

## 1. Constat : la moitié du ticket est déjà faite

Vérifié directement en base et dans le code, pas supposé.

| Élément | État réel |
|---|---|
| Table `communes` | Existe. `id, nom, code_insee, points_lumineux, armoires, travaux_debut, travaux_fin, travaux_estimes, latitude, longitude, org_id` |
| Contrainte anti-doublon | `UNIQUE (org_id, nom)` déjà en place |
| Multi-tenant | `org_id NOT NULL` + FK sur `communes`, `sites`, `clients`, `invoices`, `user_roles`, etc. |
| RLS écriture | `org_admin_insert_communes` / `update` / `delete` existent déjà, conditionnées à `is_org_admin()` + `current_user_org_id()` |
| API | `GET /api/communes` (lecture seule, filtrée par org) |
| UI Paramètres | `/parametres` affiche déjà les communes en lecture seule + les rôles. Réservée à `org_admin` |
| Rattachement facture → commune | `lib/extraction/matching.ts` (`normalizeComm`, `scoreCommune`, seuil 0,5 / auto-save 0,96) |
| Données | 1 seule org (`SMEM`), 20 communes, 21 sites, 5 users |

**Conséquence : il ne reste pas grand-chose à construire côté données.** Ce qui manque c'est
un `POST/PATCH/DELETE`, un formulaire, et surtout **les effets de bord** listés en §3, qui sont
la vraie difficulté du ticket.

⚠️ Point à noter : `app/(app)/parametres/page.tsx` lit les communes **sans filtre `org_id` explicite**
(il s'appuie sur RLS seul, contrairement à `/api/communes` qui filtre explicitement). Ça marche
aujourd'hui, mais c'est incohérent avec le reste. À harmoniser.

---

## 2. Réponses aux deux questions du ticket

### Q1 — « C'est quoi le niveau de séparation entre les deux comptes ? 25 communes vs 35 ? Des vues différentes ? »

**Réponse : l'isolation est déjà totale, et il ne faut rien ajouter.**

Le modèle est `organizations 1—n communes`, avec RLS `org_id = current_user_org_id()` sur toutes
les tables. Concrètement :

- Compte A avec 25 communes et compte B avec 35 : ça marche aujourd'hui, sans une ligne de code.
- Aucune donnée ne peut fuiter d'une org à l'autre — c'est la base qui l'empêche, pas l'UI.
- `communes_org_nom_key` est `(org_id, nom)` : deux orgs peuvent avoir une commune du même nom
  sans conflit. Correct.

**Des « vues différentes » par compte : à refuser en l'état.** C'est de la personnalisation
par tenant, ça multiplie le code par le nombre de clients et ça ne tient pas. Si le besoin
derrière c'est « chaque client n'a pas les mêmes typologies / champs », la réponse existe déjà :
`custom_field_definitions` est scopé par `org_id`. Il faut faire remonter le besoin réel, pas
la solution proposée. → à instruire dans SCRUM-18 (scalabilité / multi-tenant), pas ici.

### Q2 — « Créer un utilisateur SMEM avec l'adresse de Laurent ? »

**Bonne direction, mais il manque une décision structurante avant.**

Aujourd'hui les **5 utilisateurs sont dans l'org SMEM** — donc les comptes Ability aussi.
Il n'existe **aucun rôle super-admin cross-org** (`user_roles.role` = `org_admin` | `org_member`,
et `user_roles.user_id` est `UNIQUE` : un user = une seule org, définitivement).

Si Laurent devient `org_admin` de l'org SMEM, il voit et gère les rôles de toute l'org — y compris
les comptes Ability qui y sont. Et le jour où un 2e client arrive, Ability n'a plus de moyen
propre d'accéder aux deux orgs pour le support.

Trois options, par ordre de préférence :

1. **Recommandé — Laurent = `org_admin` de l'org SMEM, Ability sort de cette org.**
   Ability se crée une org interne + accède au support via la service-role key / le dashboard
   Supabase, hors application. Propre, zéro code, décision immédiate.
2. Laurent = `org_member` (lecture + dépôt), création de commune faite par Ability sur demande.
   Sûr, mais ça vide le ticket de son intérêt : la feature ne sert à personne.
3. Ajouter un rôle `platform_admin` cross-org. **Ne pas faire maintenant.** C'est de
   l'architecture multi-tenant → SCRUM-18. Le faire ici gonflerait le ticket de 3x.

→ **Ce point se tranche avec Anthony/Ahmed avant de coder**, pas pendant.

---

## 3. Les points d'ombre que le ticket ne mentionne pas (et qui sont les vrais risques)

### 3.1 🔴 La heatmap / couverture ne lit PAS la table `communes`

`lib/data/coverage.ts` construit sa liste de communes **à partir des factures existantes**
(`communesMap` alimentée en itérant sur `invoices`). Une commune créée mais sans aucune facture
**n'apparaîtra nulle part** dans la vue couverture.

C'est précisément le cas d'usage d'une commune fraîchement ajoutée. Sans correctif, la feature
donne l'impression de ne pas marcher. → à traiter dans le ticket, lot 4.

### 3.2 🔴 Latitude / longitude : dette silencieuse

La migration `20260728000000_communes-latlng.sql` a rempli lat/lng **à la main, en dur, pour les
20 communes de Martinique**. Les colonnes sont nullables et il n'y a **aucun mécanisme de
géocodage**. Une commune créée via le futur formulaire arrivera donc avec `latitude = NULL`
→ le module de prévision (longueur de nuit pour l'éclairage public, Open-Meteo pour les bâtiments)
tombera ou renverra du vide, silencieusement.

**✅ Résolu par le référentiel fermé (§3.2bis).** Pas besoin de géocodage API : les 14 communes
restantes sont connues à l'avance, leurs coordonnées sont fournies dans le référentiel et
recopiées à l'insert. Le lot « géocodage » du plan initial est supprimé.

### 3.2bis ✅ Le domaine est fermé : 34 communes, 20 en base, 14 restantes

**C'est l'information qui change tout le ticket.** La Martinique compte 34 communes. 20 sont déjà
en base. L'utilisateur ne pourra donc jamais ajouter que **14 communes, toutes connues d'avance**,
avec leur `code_insee` et leurs coordonnées.

Conséquences directes sur la conception :

- Le formulaire n'est **pas un champ texte libre** mais un **sélecteur dans une liste fermée**,
  alimenté par un référentiel statique versionné dans le code.
- La liste proposée = les 34 du référentiel **moins** celles déjà présentes dans l'org. Quand les
  34 sont créées, le bouton « Ajouter » se désactive avec un message explicite.
- `nom`, `code_insee`, `latitude`, `longitude` sont **recopiés du référentiel**, jamais saisis.
  Zéro faute de frappe, zéro variante d'orthographe, zéro coordonnée manquante.
- Restent saisissables par l'utilisateur : `points_lumineux`, `armoires`, `travaux_debut`,
  `travaux_fin`, `travaux_estimes` — les seules données qui lui appartiennent réellement.

**Le référentiel ne s'affiche nulle part dans l'outil** en dehors du sélecteur d'ajout. Les 14
communes non créées n'existent pas pour les analyses, la heatmap, les rapports ou le matching de
factures. Elles ne sont **pas** pré-insérées en base (pas de seed `archived = true`) : elles vivent
uniquement dans le fichier de référentiel jusqu'à ce que quelqu'un en crée une.

→ Contenu complet du référentiel en **§8**.

### 3.3 🟠 Doublons : neutralisé côté saisie, à garder en défense

`UNIQUE (org_id, nom)` bloque `"Le Robert"` deux fois — mais pas `"Le Robert"` vs `"Robert"` vs
`"LE ROBERT "`. Or `scoreCommune()` retourne **100 pour toute inclusion de sous-chaîne**. Deux
communes quasi-homonymes en base = matching ambigu (`pickBestCommuneScored` prend le premier
meilleur score, non déterministe sur ex-æquo) = factures rattachées à la mauvaise commune,
**silencieusement**, sur tout l'historique à venir.

**Le sélecteur fermé règle 95 % du problème** : on ne saisit plus de texte, donc plus de variante
d'orthographe possible. Le risque résiduel vient des 20 communes **déjà en base**, dont les noms
ont été saisis sans accent ni tiret (`"Le Prêcheur"`, `"Les Trois Ilets"`, `"Grand Rivière"`).

→ Le rapprochement référentiel ↔ base doit donc se faire **par `code_insee` en priorité**, et par
`normalizeComm()` en secours — jamais par égalité de chaîne brute. Sinon l'outil proposera d'ajouter
« Les Trois-Îlets » alors que « Les Trois Ilets » existe déjà. C'est le point technique n°1 du lot 1.

La contrainte `UNIQUE (org_id, slug)` reste utile comme filet de sécurité en base, mais elle n'est
plus la ligne de défense principale.

### 3.4 🟠 Suppression et renommage : effets de bord non triviaux

FK entrantes sur `communes(id)` :

| Table | ON DELETE |
|---|---|
| `sites` | CASCADE |
| `file_request_links` | CASCADE |
| `pending_uploads` | CASCADE |
| `document_jobs.suggested_commune_id` | SET NULL |
| `invoices` | **RESTRICT (défaut)** |
| `clients` | **RESTRICT (défaut)** |
| `user_roles` | **RESTRICT (défaut)** |

Donc supprimer une commune ayant des factures **échouera** avec une erreur Postgres brute.
Et supprimer une commune sans facture **détruit ses sites en cascade** sans avertissement.

**Le renommage disparaît du périmètre** : le `nom` vient du référentiel, il n'est plus éditable.
Ça supprime d'un coup le risque de casser le matching par un renommage. Seuls les champs métier
(`points_lumineux`, `armoires`, dates de travaux) restent modifiables.

### 3.5 🟡 Questions produit ouvertes

- ~~Quels champs sont obligatoires ?~~ → **tranché** : `nom`, `code_insee`, `latitude`, `longitude`
  viennent du référentiel ; le reste est optionnel et éditable après coup.
- `points_lumineux` / `armoires` / `travaux_debut` / `travaux_fin` : saisis à la création,
  ou remplis plus tard ? (ils alimentent les analyses avant/après travaux) → recommandation :
  optionnels à la création, éditables ensuite. Ne pas bloquer l'ajout d'une commune sur des
  données que Laurent n'a peut-être pas sous la main.
- La création de commune est-elle réservée à `org_admin` ? (RLS dit oui aujourd'hui — à confirmer
  côté produit, c'est cohérent)
- ~~Import en masse (CSV) ?~~ → **sans objet** : 14 communes maximum, une par une suffit largement.

---

## 4. Décisions à prendre AVANT de lancer l'agent

| # | Décision | Recommandation |
|---|---|---|
| D1 | Rôle de Laurent + sortie d'Ability de l'org SMEM | Option 1 (§2 Q2) — **seule décision réellement ouverte** |
| D2 | ~~Géocodage lat/lng~~ | ✅ **Tranché** : référentiel statique des 34 communes avec coordonnées (§8). Pas d'API |
| D3 | `code_insee` obligatoire et unique par org ? | ✅ **Oui** — il vient du référentiel, c'est la clé de rapprochement référentiel ↔ base |
| D4 | Suppression autorisée ? | **Non** en v1. Remplacer par « archiver » (colonne `archived`, comme `invoices`). Le CASCADE sur `sites` est trop dangereux |
| D5 | ~~Renommage autorisé ?~~ | ✅ **Sans objet** : le `nom` vient du référentiel, non éditable |
| D6 | ~~Import CSV en masse~~ | ✅ **Sans objet** : 14 communes max |
| D7 | « Vues différentes par compte » | Refuser / renvoyer vers SCRUM-18 |
| D8 | Portée du référentiel | Martinique seule pour l'instant. Structurer le fichier pour qu'un autre territoire s'ajoute sans refactor, mais **ne pas généraliser maintenant** |

---

## 5. Plan d'action pour l'agent de code IA

Découpage en 5 lots, séquentiels. **Un lot = une PR.** L'agent ne passe au lot suivant qu'une
fois le précédent vert (typecheck + lint + `vitest`).

> **Rappel de cadrage (§3.2bis)** : domaine fermé de 34 communes, 20 en base, 14 ajoutables.
> Le formulaire est un **sélecteur**, pas une saisie libre. Le référentiel (§8) est la source de
> vérité pour `nom`, `code_insee`, `latitude`, `longitude`.

### Contraintes globales à donner à l'agent

- Next.js version du repo — lire `node_modules/next/dist/docs/` avant d'écrire (cf. `AGENTS.md`).
- Toute écriture passe par une **Server Action** dans `app/(app)/parametres/actions.ts`,
  pattern existant (`assignUserRole`, `createFileRequestLink`).
- Toujours `getUserContext()` + vérif `ctx.role === "org_admin"` **en plus** de RLS. Ceinture et bretelles.
- Toujours écrire `org_id: ctx.orgId` explicitement à l'insert.
- Ne **jamais** utiliser `createAdminClient()` pour les communes : le client RLS suffit et
  protège. L'admin client n'est justifié que pour `auth.admin.*`.
- Migrations : `supabase/migrations/`, nommage `YYYYMMDDHHMMSS_description.sql`, appliquées
  **d'abord sur `smem-bill-analyzer-staging`**.
- FR partout dans l'UI et les messages d'erreur.

---

### Lot 1 — Référentiel + socle données

**Fichiers** :
- `lib/communes/referentiel-martinique.ts` *(nouveau)* — les 34 communes, cf. §8
- `supabase/migrations/<ts>_communes_creation.sql` *(nouveau)*

**1a. Le référentiel (fichier TS, pas une table)**

34 entrées statiques `{ codeInsee, nom, latitude, longitude }`, `as const`, avec un type exporté.
Pas de table en base : c'est de la donnée de référence publique, immuable, qui n'a aucune raison
d'être requêtable. Un fichier versionné est plus simple à relire, à tester et à faire évoluer.

✅ **Fait.** Les 34 `code_insee` ont été vérifiés contre le COG INSEE officiel : **31 étaient
faux** et ont été corrigés (cf. §8). L'hypothèse « ordre alphabétique 97201→97234 » était l'erreur.
C'est exactement le genre de bug qu'on ne détecte que six mois plus tard, une fois les factures
rattachées au mauvais code.

**1b. Rapprochement référentiel ↔ base (le point délicat)**

Les 20 communes en base ont un `code_insee` potentiellement nul ou incohérent, et des noms sans
accents ni tirets. L'agent doit :

1. Écrire un script de vérification (`scripts/check-communes-referentiel.ts`) qui, pour chacune des
   20 communes en base, retrouve son entrée du référentiel via `normalizeComm()`, et **échoue
   bruyamment** s'il reste une commune non appariée ou une entrée appariée deux fois.
2. Lancer ce script contre staging **et** prod, et **corriger manuellement les cas ambigus avant
   d'écrire la migration**. Ne pas automatiser un rapprochement dont on n'a pas vérifié le résultat
   sur 20 lignes — c'est 10 minutes de relecture humaine.
3. Ensuite seulement : backfill `code_insee` depuis le référentiel.

**1c. Migration**

1. `ALTER TABLE communes ADD COLUMN archived boolean NOT NULL DEFAULT false;`
2. `ALTER TABLE communes ADD COLUMN slug text;` — résultat de `normalizeComm(nom)`, backfill des
   20 existantes, puis `UNIQUE (org_id, slug)`. Filet de sécurité en base.
3. Backfill `code_insee` (issu de 1b) → `NOT NULL` + `UNIQUE (org_id, code_insee)`.
4. **Ne pas normaliser les noms existants.** Renommer `"Les Trois Ilets"` en `"Les Trois-Îlets"`
   changerait le comportement de `scoreCommune` sur les factures futures. On garde les noms tels
   quels, le rapprochement se fait par `code_insee`. À traiter séparément si le besoin apparaît.
5. Index : `communes(org_id, archived)`.
6. Confirmer que les policies RLS existantes couvrent les nouvelles colonnes (elles portent sur la
   ligne entière — juste vérifier, ne rien réécrire).

**Critères d'acceptation** :
- le script de vérification apparie 20/20 sans ambiguïté, sur staging et sur prod ;
- les 34 entrées du référentiel ont un `code_insee` unique et des coordonnées non nulles ;
- après migration, `select count(*) from communes where code_insee is null` → 0 ;
- aucun `nom` modifié (`select nom from communes` identique avant/après).

---

### Lot 2 — Backend : validation + Server Actions

**Fichiers** :
- `lib/communes/validation.ts` *(nouveau)*
- `app/(app)/parametres/actions.ts` *(étendre)*
- `app/api/communes/route.ts` *(ajouter POST — optionnel, si l'UI passe par Server Action, s'en passer)*

1. `lib/communes/disponibles.ts` : `getCommunesDisponibles(orgId)` → les entrées du référentiel
   **dont le `code_insee` n'est pas déjà présent dans l'org**, triées par nom. C'est ce qui alimente
   le sélecteur. Rapprochement **par `code_insee`**, jamais par nom.
2. `lib/communes/validation.ts` : schéma Zod. L'entrée de `createCommune` est
   `{ codeInsee } + champs métier optionnels` — **`nom`, `latitude`, `longitude` ne sont pas dans
   l'input** : le serveur les résout depuis le référentiel. Un client malveillant ne peut donc pas
   injecter une commune arbitraire.
   Valider : `codeInsee` ∈ référentiel, entiers ≥ 0, `travaux_fin >= travaux_debut`.
3. `createCommune(input)` : auth `org_admin` → validation → **résolution du référentiel** →
   vérification que le `code_insee` n'existe pas déjà dans l'org → insert avec `org_id`, `slug`,
   `nom`/`lat`/`lng` issus du référentiel → `revalidatePath("/parametres")`.
   Retour `{ error }` ou `{ success, commune }`, comme les actions existantes.
4. `updateCommune(id, input)` : **champs métier uniquement** (`points_lumineux`, `armoires`,
   `travaux_*`). Rejeter toute tentative de modifier `nom`, `code_insee`, `latitude`, `longitude`.
5. `archiveCommune(id)` : passe `archived = true`. **Pas de DELETE.**
6. Garde-fou conservé malgré le référentiel : avant insert, calculer `scoreCommune` du nom candidat
   contre les communes existantes de l'org. Si ≥ 0,8 alors que le `code_insee` diffère, **bloquer et
   logger** — ça signifie que le rapprochement du lot 1 a raté quelque chose. Ce cas ne doit jamais
   se produire ; s'il se produit, on veut le savoir, pas le contourner.
7. Mapper les erreurs Postgres en messages FR lisibles, pas de fuite de message brut.

**Tests** (`vitest`, à côté des tests existants du module matching) :
- les 34 entrées du référentiel ont un `code_insee` unique, un nom unique, des coordonnées dans les
  bornes de la Martinique (lat ∈ [14.3, 15.0], lng ∈ [-61.3, -60.7]) — test de garde sur les données ;
- `getCommunesDisponibles` retourne 14 entrées face aux 20 communes actuelles, et 0 quand les 34 sont créées ;
- `code_insee` déjà présent dans l'org → rejeté ;
- `code_insee` absent du référentiel → rejeté ;
- `nom` / `latitude` passés dans l'input → ignorés, valeurs du référentiel utilisées ;
- deux orgs peuvent créer le même `code_insee` ;
- `org_member` refusé ; non authentifié refusé ;
- `travaux_fin < travaux_debut` refusé.

---

### Lot 3 — ~~Géocodage~~ → **supprimé**

Rendu inutile par le référentiel (§3.2bis). Les coordonnées des 14 communes restantes sont connues
et livrées dans le fichier de référentiel ; elles sont recopiées à l'insert. Aucune API tierce,
aucun cas « coordonnées manquantes » à gérer.

**Le seul reliquat à conserver** : un test de garde vérifiant qu'aucune commune ne peut être créée
avec `latitude`/`longitude` nulles, pour que la dette de §3.2 ne puisse pas réapparaître.
→ intégré au lot 2.

Le plan passe donc de 5 à **4 lots**.

---

### Lot 4 — UI Paramètres

**Fichiers** :
- `components/parametres/commune-form.tsx` *(nouveau)* — dialog shadcn : **`Select` des communes
  disponibles** + champs métier optionnels
- `components/parametres/commune-card.tsx` *(nouveau)* — extraire la carte existante de
  `page.tsx`, y ajouter action Modifier (champs métier) / Archiver
- `app/(app)/parametres/page.tsx` *(refactor)*

1. Bouton « Ajouter une commune » dans le `CardHeader` de la section Communes, visible
   `org_admin` uniquement.
2. Le dialog affiche un **`Select` alimenté par `getCommunesDisponibles(orgId)`** — pas de champ
   texte pour le nom. Les 14 restantes y apparaissent par ordre alphabétique.
3. Une fois la commune choisie, afficher en lecture seule son `code_insee` (rassure sur le bon
   choix) et **ne pas afficher les coordonnées** — c'est de la plomberie, ça n'intéresse pas
   l'utilisateur (conforme à la demande : le référentiel ne s'affiche pas dans l'outil).
4. Champs métier optionnels, tous saisissables plus tard : points lumineux, armoires, dates de
   travaux, travaux estimés.
5. **Quand les 34 sont créées** : bouton désactivé + message « Toutes les communes de Martinique
   sont déjà enregistrées. » Cas réel et atteignable ici, à ne pas oublier.
6. Filtrer `archived = false` par défaut, avec bascule « afficher les archivées ». Une commune
   archivée redevient disponible dans le sélecteur → prévoir le cas : proposer de la **désarchiver**
   plutôt que d'en créer une seconde (le `UNIQUE (org_id, code_insee)` bloquerait de toute façon,
   autant donner un message utile).
7. **Corriger l'incohérence** relevée en §1 : ajouter `.eq("org_id", ctx.orgId)` explicite sur
   les requêtes `communes` et `sites` de la page.
8. États : loading, erreur, succès (toast), formulaire désactivé pendant soumission.

---

### Lot 4bis (ex-lot 5) — Propagation dans les vues existantes ⚠️ le lot qui compte

1. **`lib/data/coverage.ts`** : arrêter de dériver la liste des communes depuis les factures.
   Charger la liste depuis `communes` (org, non archivées) et faire un **left join** logique
   avec les agrégats de factures → une commune sans facture apparaît avec 0. Sinon la feature
   est invisible (§3.1).
2. **`lib/extraction/matching.ts`** : vérifier que la liste des communes candidates est bien
   rechargée à chaque extraction (pas de cache module) et **exclure les communes archivées**.
3. **`components/rapports/report-picker.tsx`**, `app/(app)/rapport-excel/page.tsx`,
   `app/(app)/analyses/consommation/page.tsx`, `components/analyses/analyses-view.tsx` :
   confirmer que la nouvelle commune apparaît dans les sélecteurs, exclure les archivées.
4. **`app/(app)/upload/review/page.tsx`** et `app/api/document-jobs/*` : la nouvelle commune doit
   être proposable au rattachement manuel immédiatement après création.
5. `api/internal/generate-report.py` : vérifier qu'une commune sans facture ne fait pas planter
   la génération du rapport Excel.

**Critère d'acceptation du ticket** (scénario de recette, à dérouler sur staging, en utilisant
**Le Lamentin** comme commune de test — 14 communes réelles disponibles, pas besoin de données
bidon) :

1. Le sélecteur propose exactement 14 communes, dont Le Lamentin, et aucune des 20 existantes.
2. Créer Le Lamentin → `code_insee = 97213`, `latitude`/`longitude` renseignées automatiquement.
3. Elle apparaît dans Paramètres, dans le sélecteur de rapport, dans la vue couverture (à 0),
   dans le sélecteur de rattachement de facture.
4. Le sélecteur ne propose plus que 13 communes.
5. Déposer une facture portant « LAMENTIN » → elle est proposée automatiquement par le matching,
   sans confusion avec une autre commune.
6. L'analyse et le rapport Excel la prennent en compte.
7. L'archiver → elle disparaît des vues, et le sélecteur propose de la **désarchiver**, pas d'en
   créer une seconde.

---

## 6. Ce qui reste hors périmètre (à dire explicitement à Laurent)

- ~~Import CSV de communes en masse~~ → sans objet (14 communes max).
- Territoires hors Martinique → le référentiel est volontairement limité à la Martinique. Un autre
  territoire = un autre référentiel, à ajouter le jour où un client le demande.
- Normalisation orthographique des 20 noms existants (`"Les Trois Ilets"` → `"Les Trois-Îlets"`)
  → volontairement écartée, elle perturberait le matching des factures. Ticket séparé si Laurent
  le remarque et que ça le gêne.
- Rôle super-admin cross-org → SCRUM-18.
- Vues / analyses personnalisées par compte → SCRUM-18, besoin à requalifier.
- Suppression définitive d'une commune → volontairement non implémentée (archivage à la place).

---

## 7. Prochaine étape immédiate

1. Trancher **D1** — c'est la seule décision encore réellement ouverte (D2, D3, D5, D6 sont
   résolues par le référentiel). 15 min avec Anthony et Ahmed.
2. Reporter les réponses **en commentaire du ticket SCRUM-14** — les deux questions ouvertes y
   sont depuis le début, elles doivent être fermées noir sur blanc.
3. Confirmer avec Laurent : le rôle qu'il souhaite (créer lui-même vs demander à Ability).
4. ~~Vérifier les 34 `code_insee` contre le COG INSEE~~ → ✅ fait au lot 1a, 31 codes corrigés.

---

## 8. Référentiel des 34 communes de Martinique

Contenu de `lib/communes/referentiel-martinique.ts`.

**Statut des données** : ✅ **vérifié et corrigé au lot 1a** contre deux sources officielles
concordantes (COG INSEE 2026 `v_commune_2026.csv` et `geo.api.gouv.fr`, département 972).

⚠️ **La version initiale de ce tableau était fausse sur 31 des 34 codes.** Elle supposait une
séquence strictement alphabétique 97201→97234. Le COG ne l'est pas : **Le Morne-Vert (97233)** et
**Bellefontaine (97234)** ont été créées tardivement (détachées du Carbet et de Case-Pilote) et
numérotées à la fin. D'où un décalage de −1 à partir du Carbet, puis de −2 à partir du Prêcheur.
Le décalage n'étant pas uniforme, **tout remapping doit se faire par nom, jamais par arithmétique
sur le code**. Ne pas « ranger » ce tableau par ordre alphabétique en réattribuant les codes :
`lib/communes/referentiel-martinique.test.ts` échoue si on le fait.

Coordonnées = centroïdes des polygones communaux renvoyés par `geo.api.gouv.fr`, arrondis à 4
décimales. Elles remplacent les valeurs approximatives initiales, fausses de plus de 3 km sur 7
communes et de plus de 10 km sur Case-Pilote, Ducos et Le Marigot (points hors du territoire
communal). Ces mêmes valeurs fausses sont en base depuis `20260728000000_communes-latlng.sql` :
le lot 1c les corrige.

**Colonne « État »** : `en base` = déjà dans l'org SMEM (20) · `à ajouter` = proposable dans le
sélecteur (14).

| code_insee | Nom (référentiel) | Latitude | Longitude | État | Nom en base |
|---|---|---|---|---|---|
| 97201 | L'Ajoupa-Bouillon | 14.8160 | -61.1305 | **à ajouter** | — |
| 97202 | Les Anses-d'Arlet | 14.4996 | -61.0736 | en base | Les Anses d'Arlet |
| 97203 | Basse-Pointe | 14.8410 | -61.1237 | **à ajouter** | — |
| 97204 | Le Carbet | 14.7041 | -61.1583 | en base | Carbet |
| 97205 | Case-Pilote | 14.6594 | -61.1297 | en base | Case Pilote |
| 97206 | Le Diamant | 14.4787 | -61.0165 | **à ajouter** | — |
| 97207 | Ducos | 14.5785 | -60.9685 | en base | Ducos |
| 97208 | Fonds-Saint-Denis | 14.7228 | -61.1207 | en base | Fonds Saint Denis |
| 97209 | Fort-de-France | 14.6492 | -61.0686 | **à ajouter** | — |
| 97210 | Le François | 14.6093 | -60.8976 | **à ajouter** | — |
| 97211 | Grand'Rivière | 14.8470 | -61.1836 | en base | Grand Rivière |
| 97212 | Gros-Morne | 14.7084 | -61.0303 | en base | Gros Morne |
| 97213 | Le Lamentin | 14.6231 | -60.9923 | **à ajouter** | — |
| 97214 | Le Lorrain | 14.7995 | -61.0740 | **à ajouter** | — |
| 97215 | Macouba | 14.8474 | -61.1465 | en base | Macouba |
| 97216 | Le Marigot | 14.7795 | -61.0530 | en base | Le Marigot |
| 97217 | Le Marin | 14.4822 | -60.8589 | **à ajouter** | — |
| 97218 | Le Morne-Rouge | 14.7695 | -61.1217 | en base | Le Morne Rouge |
| 97219 | Le Prêcheur | 14.8221 | -61.1963 | en base | Le Prêcheur |
| 97220 | Rivière-Pilote | 14.5027 | -60.8970 | **à ajouter** | — |
| 97221 | Rivière-Salée | 14.5262 | -60.9623 | **à ajouter** | — |
| 97222 | Le Robert | 14.6786 | -60.9243 | en base | Le Robert |
| 97223 | Saint-Esprit | 14.5617 | -60.9233 | en base | Saint Esprit |
| 97224 | Saint-Joseph | 14.6835 | -61.0407 | **à ajouter** | — |
| 97225 | Saint-Pierre | 14.7717 | -61.1735 | **à ajouter** | — |
| 97226 | Sainte-Anne | 14.4314 | -60.8516 | en base | Sainte Anne |
| 97227 | Sainte-Luce | 14.4904 | -60.9467 | **à ajouter** | — |
| 97228 | Sainte-Marie | 14.7730 | -61.0084 | en base | Sainte Marie |
| 97229 | Schœlcher | 14.6518 | -61.1001 | **à ajouter** | — |
| 97230 | La Trinité | 14.7518 | -60.9469 | en base | La Trinité |
| 97231 | Les Trois-Îlets | 14.5329 | -61.0376 | en base | Les Trois Ilets |
| 97232 | Le Vauclin | 14.5420 | -60.8595 | en base | Le Vauclin |
| 97233 | Le Morne-Vert | 14.7046 | -61.1362 | en base | Le Morne Vert |
| 97234 | Bellefontaine | 14.6747 | -61.1460 | en base | Bellefontaine |

**Total : 34 · en base : 20 · à ajouter : 14** ✅

### Pièges de rapprochement à traiter au lot 1b

Les noms en base diffèrent du référentiel sur 9 des 20 communes (tirets, accents, article manquant).
`normalizeComm()` gère la plupart des cas, mais l'agent doit vérifier explicitement :

- `Carbet` ↔ `Le Carbet` et `Case Pilote` ↔ `Case-Pilote` — article/tiret manquants ;
- `Grand Rivière` ↔ `Grand'Rivière` — apostrophe ;
- `Les Trois Ilets` ↔ `Les Trois-Îlets` — accent circonflexe ;
- `Saint Esprit` ↔ `Saint-Esprit` et `Sainte Anne` ↔ `Sainte-Anne` — attention, `normalizeComm`
  **neutralise le genre** (`sainte` → `saint`) : `Saint-Esprit`, `Sainte-Anne` et `Sainte-Marie`
  se normalisent en `saint esprit` / `saint anne` / `saint marie`. Pas de collision ici, mais c'est
  fragile — raison de plus pour rapprocher par `code_insee` une fois le backfill fait.

### Vigilance particulière sur le matching des 14 nouvelles

Trois entrées à ajouter risquent de perturber `scoreCommune`, qui retourne **100 sur simple
inclusion de sous-chaîne** :

- **Le Marin** (97218) vs **Le Marigot** (97217, déjà en base) — préfixe commun `mari`.
- **Rivière-Pilote** (97222) et **Rivière-Salée** (97223) vs **Grand'Rivière** (97212, en base) et
  **Case-Pilote** (97206, en base) — le mot `riviere` et le mot `pilote` deviennent ambigus.
- **Saint-Pierre** / **Saint-Joseph** vs les trois `Saint*` déjà en base, avec la neutralisation de
  genre évoquée ci-dessus.

→ **Test de non-régression obligatoire au lot 4bis** : avec les 34 communes en base, vérifier que
`pickBestCommuneScored` retourne toujours la bonne commune pour un jeu d'étiquettes réalistes
(`"CASE PILOTE"`, `"RIVIERE PILOTE"`, `"RIVIERE SALEE"`, `"LE MARIN"`, `"MARIGOT"`, `"ST PIERRE"`,
`"ST ESPRIT"`). C'est le risque le plus concret introduit par l'ajout des 14 communes, et il ne se
manifestera qu'une fois les factures mal rattachées en production.
