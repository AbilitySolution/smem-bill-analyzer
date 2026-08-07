"""
Fonction Vercel (runtime Python) — génération du classeur Excel Ability.

Pourquoi cette fonction existe
------------------------------
Le runtime Node de Vercel n'embarque pas d'interpréteur Python : l'ancien
`execFile("python3", ...)` dans app/api/reports/route.ts échouait en ENOENT sur
tous les déploiements. La logique métier (scripts/reports/generate_report.py)
est donc exposée ici comme une vraie fonction Python, appelée en HTTP par la
route Next.

FRONTIÈRE DE SÉCURITÉ — à lire avant toute modification
-------------------------------------------------------
Toute fonction Vercel est routable publiquement ; il n'existe pas de fonction
« interne ». Or le générateur interroge Supabase avec la service-role key, donc
RLS contournée : le filtre `orgId` est la SEULE protection contre une fuite de
données inter-organisations.

`orgId` est résolu côté Next par getUserContext() à partir de la session
Supabase, jamais lu depuis le body du client. Le secret partagé vérifié
ci-dessous est ce qui empêche un tiers d'appeler cette fonction directement avec
un orgId arbitraire. Ne jamais le retirer, ne jamais le rendre optionnel.

Même pattern que /api/cron/ dans proxy.ts : route exclue du contrôle de session,
donc responsable de sa propre authentification.
"""

import hmac
import json
import os
import sys
import tempfile
import traceback
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# ── Alias des variables d'environnement ──────────────────────────────────────
# generate_report.py lit SUPABASE_URL / SUPABASE_SERVICE_KEY dans des CONSTANTES
# DE MODULE (SB_URL / SB_KEY), évaluées au moment de l'import. L'aliasing doit
# donc impérativement précéder l'import, sinon les deux valent "" et toutes les
# requêtes Supabase partent sans clé.
if not os.environ.get("SUPABASE_URL"):
    os.environ["SUPABASE_URL"] = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
if not os.environ.get("SUPABASE_SERVICE_KEY"):
    os.environ["SUPABASE_SERVICE_KEY"] = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# ── Import du générateur ─────────────────────────────────────────────────────
# Le module vit hors du dossier api/ : il est embarqué via "includeFiles" dans
# vercel.json, qui préserve l'arborescence relative à la racine du projet.
# generate_report.py résout aussi le logo par Path(__file__).parents[2], d'où
# l'obligation de conserver l'emplacement scripts/reports/.
_HERE = Path(__file__).resolve()
_CANDIDATES = [
    _HERE.parents[2] / "scripts" / "reports",   # racine du projet
    Path.cwd() / "scripts" / "reports",         # repli selon le cwd du builder
]
for _candidate in _CANDIDATES:
    if (_candidate / "generate_report.py").exists():
        sys.path.insert(0, str(_candidate))
        break

try:
    import generate_report  # noqa: E402
    _IMPORT_ERROR = None
except Exception as _exc:  # ModuleNotFoundError (bundling) ou ImportError (openpyxl)
    generate_report = None
    _IMPORT_ERROR = f"{type(_exc).__name__}: {_exc}"

# Les params sont petits (au pire ~1200 UUID de factures présélectionnées).
MAX_BODY_BYTES = 2 * 1024 * 1024


class handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 — signature imposée par BaseHTTPRequestHandler
        secret = os.environ.get("REPORTS_INTERNAL_SECRET", "")
        if not secret:
            return self._json(500, "REPORTS_INTERNAL_SECRET absent de la fonction Python.")

        provided = self.headers.get("Authorization", "")
        if provided.startswith("Bearer "):
            provided = provided[len("Bearer "):]
        # compare_digest sur des bytes : évite le ValueError sur caractères non-ASCII
        # et garde la comparaison en temps constant (pas de fuite par timing).
        if not hmac.compare_digest(provided.encode("utf-8"), secret.encode("utf-8")):
            return self._json(401, "Unauthorized")

        if generate_report is None:
            print(f"[generate-report] import impossible : {_IMPORT_ERROR}", file=sys.stderr)
            return self._json(500, f"Générateur indisponible ({_IMPORT_ERROR}).")

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, "Content-Length invalide.")
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._json(400, "Corps de requête absent ou trop volumineux.")

        try:
            params = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json(400, "JSON invalide.")

        # Ceinture et bretelles : la route Next injecte toujours orgId depuis la
        # session. S'il manque, on refuse plutôt que de générer sans filtre.
        if not isinstance(params, dict) or not params.get("orgId"):
            return self._json(400, "orgId manquant.")

        # inject_pivots() rouvre le classeur par CHEMIN (manipulation du zip) et
        # écrit un <chemin>.tmp : impossible de travailler en BytesIO. /tmp est le
        # seul répertoire inscriptible d'une fonction Vercel.
        out_path = os.path.join(tempfile.gettempdir(), f"ability-report-{uuid.uuid4().hex}.xlsx")
        try:
            generate_report.build(params, out_path)
            with open(out_path, "rb") as fh:
                payload = fh.read()
        except SystemExit as exc:
            # build() signale ses erreurs métier attendues par SystemExit("message")
            # (« Aucune facture… », « date de bascule… ») : ce sont des 4xx, pas des bugs.
            return self._json(422, str(exc) or "Échec de la génération du rapport.")
        except Exception:
            # Trace complète dans les runtime logs Vercel, message générique au client.
            traceback.print_exc()
            return self._json(500, "Échec de la génération du rapport.")
        finally:
            for leftover in (out_path, out_path + ".tmp"):
                try:
                    os.unlink(leftover)
                except OSError:
                    pass

        self.send_response(200)
        self.send_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        self._json(405, "Method Not Allowed")

    def _json(self, status: int, error: str):
        raw = json.dumps({"error": error}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        # Silence le log d'accès par défaut : Vercel journalise déjà chaque requête.
        pass
