# Prompt Claude Code — SCRUM-14

## ⚠️ Règle non négociable : rien sur `main`

Tout le travail de SCRUM-14 va sur la branche **`feat/scrum-14-ajout-commune`**, poussée sur le
remote, et se termine par une PR. `main` n'est jamais touchée directement — ni par toi, ni par
Claude Code.

Le repo est actuellement sur `main` avec des modifs de config non commitées
(`.claude/launch.json`, `.github/workflows/ci.yml`, `.gitignore`, `.npmrc`, `.nvmrc`).
Elles ne font pas partie du ticket : les stash avant de créer la branche.

```bash
cd "C:\Users\sulay\OneDrive\Bureau\Projets\Ability\Clients\Smem\Projet_pilote_bill\smem-bill-analyzer"

git stash push -m "config wip (hors SCRUM-14)"   # met de côté les modifs de config
git checkout -b feat/scrum-14-ajout-commune
git add docs/scrum-14
git commit -m "docs(scrum-14): analyse, plan et référentiel des 34 communes"
git push -u origin feat/scrum-14-ajout-commune

claude
```

Puis coller le prompt ci-dessous.

Si un lot est mergé entre deux sessions, repartir de branches filles
(`feat/scrum-14-lot-2`, etc.) plutôt que d'empiler 4 lots dans une PR unique — la revue sera
bien plus simple, surtout sur le lot 4 qui touche au matching.

---

## Prompt (lot 1 — à coller tel quel)

```
Tu implémentes le ticket Jira SCRUM-14 « Permettre d'ajouter une commune » sur ce repo
(Next.js + Supabase, outil d'analyse de factures énergie pour le SMEM en Martinique).

AVANT TOUTE CHOSE, lis dans cet ordre :
1. docs/scrum-14/PLAN.md — analyse complète et plan en 4 lots. C'est la spec, fais-la
   autorité sur tes propres intuitions.
2. docs/scrum-14/referentiel-martinique.data.ts — les 34 communes, prêtes à l'emploi.
3. AGENTS.md — cette version de Next.js a des breaking changes, lis
   node_modules/next/dist/docs/ avant d'écrire du code Next.

CADRAGE ESSENTIEL (§3.2bis du PLAN) :
Le domaine est FERMÉ. La Martinique compte 34 communes, 20 sont déjà en base, l'utilisateur
ne pourra jamais en ajouter que 14, toutes connues d'avance avec leur code INSEE et leurs
coordonnées. Le formulaire est donc un SÉLECTEUR dans un référentiel statique, PAS un champ
texte libre. nom / code_insee / latitude / longitude sont résolus côté serveur depuis le
référentiel, jamais envoyés par le client.

Ne réinvente pas ce cadrage. Si tu penses avoir une meilleure idée, dis-le-moi avant de coder,
ne l'implémente pas unilatéralement.

═══════════════════════════════════════════
PÉRIMÈTRE DE CETTE SESSION : LOT 1 UNIQUEMENT
═══════════════════════════════════════════

Le PLAN décrit 4 lots. Tu fais UNIQUEMENT le lot 1 (§5 « Lot 1 — Référentiel + socle données »).
Tu t'arrêtes à la fin du lot 1 et tu me fais un rapport. Les lots 2, 3 et 4 feront l'objet de
sessions séparées.

Étapes du lot 1, dans l'ordre :

1a. RÉFÉRENTIEL
   - Vérifie les 34 codes INSEE contre le COG INSEE officiel (WebFetch sur les données
     publiques INSEE). Si un code diffère de docs/scrum-14/referentiel-martinique.data.ts,
     ARRÊTE-TOI et signale-le-moi — ne corrige pas silencieusement.
   - Déplace le référentiel vers lib/communes/referentiel-martinique.ts (garde le type
     CommuneReferentiel et la constante REFERENTIEL_MARTINIQUE, retire l'avertissement
     « fichier de travail » une fois vérifié).
   - Écris les tests de garde sur les données (vitest) :
     * 34 entrées exactement
     * codeInsee unique, nom unique
     * latitude ∈ [14.3, 15.0] et longitude ∈ [-61.3, -60.7] pour toutes les entrées
     * aucune coordonnée nulle ou undefined

1b. RAPPROCHEMENT RÉFÉRENTIEL ↔ BASE — c'est le point délicat, prends ton temps
   - Écris scripts/check-communes-referentiel.ts : pour chacune des 20 communes en base,
     retrouve son entrée du référentiel via normalizeComm() importé de
     lib/extraction/matching.ts (NE LA RÉIMPLÉMENTE PAS).
   - Le script doit ÉCHOUER BRUYAMMENT (exit code ≠ 0, message clair) si une commune reste
     non appariée, ou si une entrée du référentiel est appariée deux fois.
   - Attention aux 9 cas de divergence orthographique listés en §8 du PLAN
     (« Carbet » vs « Le Carbet », « Grand Rivière » vs « Grand'Rivière », « Les Trois Ilets »
     vs « Les Trois-Îlets », etc.) et à la neutralisation de genre dans normalizeComm
     (sainte → saint).
   - LANCE le script contre staging ET prod, et MONTRE-MOI le résultat des 20 appariements
     avant d'écrire la migration. Je veux relire les 20 lignes. Ne passe pas à 1c sans ça.

1c. MIGRATION — seulement après validation de 1b
   Fichier supabase/migrations/<timestamp>_communes_creation.sql :
   - ALTER TABLE communes ADD COLUMN archived boolean NOT NULL DEFAULT false;
   - ALTER TABLE communes ADD COLUMN slug text; backfill avec normalizeComm(nom) sur les 20
     existantes, puis UNIQUE (org_id, slug).
   - Backfill code_insee depuis le référentiel (mapping validé en 1b), puis NOT NULL +
     UNIQUE (org_id, code_insee).
   - Index communes(org_id, archived).
   - NE RENOMME AUCUNE COMMUNE EXISTANTE. Renommer changerait le comportement de scoreCommune
     sur les factures futures. Les noms restent tels quels, le rapprochement se fait par
     code_insee. C'est délibéré, ne le « corrige » pas.
   - Vérifie (sans les réécrire) que les policies RLS existantes couvrent les nouvelles
     colonnes.

   Applique la migration sur le projet Supabase `smem-bill-analyzer-staging` UNIQUEMENT.
   NE TOUCHE PAS à la prod (`smem-bill-analyzer`). Si tu penses devoir toucher la prod,
   demande-moi d'abord.

CRITÈRES D'ACCEPTATION DU LOT 1 :
- le script apparie 20/20 sans ambiguïté sur staging et prod
- les 34 entrées ont un codeInsee unique et des coordonnées non nulles
- après migration sur staging : select count(*) from communes where code_insee is null → 0
- aucun nom modifié : select nom from communes identique avant/après
- pnpm test et pnpm lint passent

CONTRAINTES TECHNIQUES (valables pour tous les lots) :
- Français partout : UI, messages d'erreur, commentaires.
- Toute écriture future passera par une Server Action dans app/(app)/parametres/actions.ts,
  pattern existant (assignUserRole, createFileRequestLink).
- Toujours getUserContext() + vérif ctx.role === "org_admin" EN PLUS de RLS.
- Toujours écrire org_id: ctx.orgId explicitement à l'insert.
- Ne JAMAIS utiliser createAdminClient() pour les communes : le client RLS suffit et protège.
- Migrations nommées YYYYMMDDHHMMSS_description.sql.

GIT — RÈGLE STRICTE :
- Tout le travail va sur la branche feat/scrum-14-ajout-commune, qui est déjà créée et poussée.
  Vérifie-le avec `git branch --show-current` avant ta première modification.
- Tu ne commit JAMAIS sur main. Tu ne fais JAMAIS de merge vers main, ni de rebase de main.
  Si tu te retrouves sur main pour une raison quelconque, arrête-toi et signale-le.
- Commit atomique par étape (1a, 1b, 1c), message descriptif en français, préfixé SCRUM-14.
- `git push` sur la branche après chaque commit — je veux pouvoir suivre l'avancement à distance.
- À la fin du lot, ouvre une PR vers main (gh pr create) avec un résumé de ce qui a été fait,
  ce qui reste, et les points qui demandent ma relecture. Ne la merge pas.
- Ne committe rien qui ne concerne pas SCRUM-14. Si tu vois des modifs de config traîner
  (.claude/launch.json, ci.yml, .gitignore, .npmrc, .nvmrc), laisse-les tranquilles.

MÉTHODE :
- Lance `pnpm test` et `pnpm lint` avant chaque commit.
- Si quelque chose dans le PLAN te paraît faux ou infaisable, dis-le-moi au lieu de bricoler
  un contournement.

Commence par lire les 3 fichiers, puis expose-moi ton plan d'attaque du lot 1 avant de coder.
```

---

## Prompts des lots suivants (sessions séparées)

Chacun de ces prompts commence par la vérification de branche. Ne pas la retirer.

### Lot 2 — Backend

```
Suite de SCRUM-14. Le lot 1 est terminé.

GIT D'ABORD : vérifie `git branch --show-current`. Tu dois être sur
feat/scrum-14-ajout-commune (ou une branche fille feat/scrum-14-lot-2 partant d'elle).
Si tu es sur main, arrête-toi et signale-le. Aucun commit sur main, aucun merge vers main.
Push après chaque commit, PR à la fin, sans merger.

Relis docs/scrum-14/PLAN.md §5 « Lot 2 — Backend : validation + Server Actions ».

Implémente UNIQUEMENT le lot 2 :
- lib/communes/disponibles.ts : getCommunesDisponibles(orgId) → entrées du référentiel dont
  le code_insee n'est pas déjà dans l'org. Rapprochement PAR CODE INSEE, jamais par nom.
- lib/communes/validation.ts : schéma Zod. L'input de createCommune est { codeInsee } + champs
  métier optionnels. nom / latitude / longitude NE SONT PAS dans l'input — le serveur les résout
  depuis le référentiel, pour qu'un client ne puisse pas injecter une commune arbitraire.
- Server Actions dans app/(app)/parametres/actions.ts : createCommune, updateCommune
  (champs métier UNIQUEMENT), archiveCommune (archived = true, PAS de DELETE).
- Le garde-fou du §5 point 6 : si scoreCommune ≥ 0,8 contre une commune existante alors que le
  code_insee diffère → bloquer ET logger. Ce cas ne doit jamais arriver ; s'il arrive on veut
  le savoir, pas le contourner.

Écris tous les tests listés dans le PLAN pour ce lot. Stop à la fin du lot 2.
```

### Lot 3 — UI Paramètres

```
Suite de SCRUM-14. Lots 1 et 2 terminés.

GIT D'ABORD : vérifie `git branch --show-current`. Tu dois être sur
feat/scrum-14-ajout-commune (ou une branche fille). Jamais sur main, jamais de merge vers main.
Push après chaque commit, PR à la fin, sans merger.

Relis docs/scrum-14/PLAN.md §5 « Lot 4 — UI Paramètres » (renuméroté lot 3, le géocodage a été
supprimé du plan).

Implémente UNIQUEMENT l'UI :
- components/parametres/commune-form.tsx : dialog shadcn avec un Select alimenté par
  getCommunesDisponibles. PAS de champ texte pour le nom. N'affiche PAS les coordonnées
  (demande client explicite : le référentiel ne s'affiche pas dans l'outil).
- components/parametres/commune-card.tsx : extraire la carte existante de page.tsx,
  + actions Modifier / Archiver.
- app/(app)/parametres/page.tsx : bouton « Ajouter une commune » (org_admin uniquement),
  filtre archived = false + bascule, et corriger l'incohérence relevée en §1 du PLAN
  (ajouter .eq("org_id", ctx.orgId) explicite sur les requêtes communes et sites).

Cas à ne pas oublier (ils sont atteignables ici, contrairement à un domaine ouvert) :
- les 34 communes créées → bouton désactivé + message « Toutes les communes de Martinique
  sont déjà enregistrées. »
- commune archivée → proposer de la DÉSARCHIVER, pas d'en créer une seconde.

Stop à la fin du lot.
```

### Lot 4 — Propagation ⚠️ le lot qui compte

```
Suite de SCRUM-14. Lots 1 à 3 terminés.

GIT D'ABORD : vérifie `git branch --show-current`. Tu dois être sur
feat/scrum-14-ajout-commune (ou une branche fille). Jamais sur main, jamais de merge vers main.
Push après chaque commit, PR à la fin, sans merger.

Relis docs/scrum-14/PLAN.md §5 « Lot 4bis — Propagation dans les vues existantes » et §8
« Vigilance particulière sur le matching des 14 nouvelles ».

C'est le lot le plus important : sans lui la feature semble ne pas marcher.

1. lib/data/coverage.ts : il dérive aujourd'hui la liste des communes DEPUIS LES FACTURES.
   Une commune créée sans facture n'apparaît donc nulle part. Charge la liste depuis la table
   communes (org, non archivées) et fais un left join logique avec les agrégats de factures →
   une commune sans facture apparaît à 0.
2. lib/extraction/matching.ts : vérifie que les communes candidates sont rechargées à chaque
   extraction (pas de cache module) et EXCLUS les communes archivées.
3. Vérifie que la nouvelle commune apparaît dans : components/rapports/report-picker.tsx,
   app/(app)/rapport-excel/page.tsx, app/(app)/analyses/consommation/page.tsx,
   components/analyses/analyses-view.tsx, app/(app)/upload/review/page.tsx,
   app/api/document-jobs/*. Exclus les archivées partout.
4. api/internal/generate-report.py : vérifie qu'une commune sans facture ne fait pas planter
   la génération du rapport Excel.

TEST DE NON-RÉGRESSION OBLIGATOIRE sur le matching (§8 du PLAN) :
scoreCommune retourne 100 sur simple inclusion de sous-chaîne. Ajouter les 14 communes crée
des ambiguïtés réelles : « Le Marin » vs « Le Marigot », « Rivière-Pilote » / « Rivière-Salée »
vs « Grand'Rivière » / « Case-Pilote », et les Saint* avec la neutralisation de genre.
Écris un test qui, avec les 34 communes en base, vérifie que pickBestCommuneScored retourne
la BONNE commune pour : "CASE PILOTE", "RIVIERE PILOTE", "RIVIERE SALEE", "LE MARIN",
"MARIGOT", "ST PIERRE", "ST ESPRIT", "STE MARIE", "STE ANNE".
Si un cas échoue, ne bricole pas le seuil : dis-le-moi, c'est une décision de conception.

Termine par le scénario de recette complet du PLAN (§ « Critère d'acceptation du ticket »),
déroulé sur staging avec Le Lamentin. Rapporte-moi chaque étape.
```

---

## Rappels avant de lancer

- **D1 n'est pas tranchée** (rôle de Laurent, sortie d'Ability de l'org SMEM). Ce n'est pas
  bloquant pour coder : ça concerne qui utilise la feature, pas comment elle est faite.
  Mais il faut la trancher avant de livrer à Laurent.
- Les codes INSEE sont à vérifier contre le COG officiel — c'est la première tâche du lot 1.
- Claude Code a accès au MCP Supabase : il peut appliquer les migrations sur staging seul.
  Le prompt lui interdit explicitement de toucher la prod.
- **Branche `feat/scrum-14-ajout-commune`, jamais `main`.** La consigne est répétée dans chaque
  prompt de lot, mais vérifie `git branch --show-current` au début de chaque session — c'est
  l'erreur la plus facile à commettre entre deux sessions.
- Les modifs de config non commitées sont stashées par la commande de setup. Ne pas oublier
  `git stash pop` sur `main` une fois le ticket terminé, sinon elles se perdent.
