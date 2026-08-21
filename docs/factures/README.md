# Factures de référence

Jeu d'essai du pipeline d'extraction : des factures EDF **réelles**, pas des PDF fabriqués
pour l'occasion. C'est ce qui en fait la référence — les cas qui cassent l'extraction
(duplicatas, périodes à cheval, index estimés, postes HP/HC, régularisations) viennent des
vrais documents, pas de ce qu'on imagine d'eux.

| Archive | Contenu |
|---|---|
| `ECLAIRAGE PUBLIC ZONE ARTISANALE DE VATABLE CONTRAT 236802.zip` | 16 factures d'éclairage public, contrat 236802 |

## Ces fichiers ne sont pas versionnés

`.gitignore` exclut `docs/factures/*.zip` et `*.pdf`. Ce sont des documents client : ils
n'ont rien à faire dans l'historique d'un dépôt, où ils resteraient indéfiniment.

Si le dossier est vide sur votre machine, **demandez l'archive** — n'improvisez pas un jeu
de test de remplacement, il ne mesurerait rien de comparable.

## Usage

Le parcours de vérification complet est décrit dans [`AGENTS.md`](../../AGENTS.md), section
« Vérifier avec de vraies factures ». En résumé : stack local, `db reset`, provisionnement
d'une organisation, `npm run dev:local`, puis import des PDF depuis l'interface.

Toute vérification portant sur ces factures se fait **sur le stack local**. Les importer
dans la base de production y créerait de vraies lignes, dans le portefeuille d'un vrai
client.
