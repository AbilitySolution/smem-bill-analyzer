#!/usr/bin/env python3
"""
Générateur de rapports Excel Ability (démo SMEM).

Usage : python3 generate_report.py '<params-json>' <sortie.xlsx>
Env   : SUPABASE_URL, SUPABASE_SERVICE_KEY

params-json :
{
  "report": "commune" | "site" | "synthese" | "avant_apres" | "tarifs",
  "communeId": "...uuid (report=commune)",
  "siteId": "...uuid (report=site)",
  "from": "YYYY-MM-DD" (optionnel), "to": "YYYY-MM-DD" (optionnel),
  "dataLogger": true|false
}

Points clés :
- NORMALISATION DES PÉRIODES : chaque période de facturation (souvent août→février,
  à cheval sur deux semestres calendaires) est ventilée PRO-RATA JOURS sur les
  buckets S1 (janv–juin) / S2 (juil–déc). Aucune somme naïve.
- Décomposition tarifaire : Base / HP / HC (part variable) + Part fixe + Taxes.
- Graphiques natifs Excel (openpyxl) + TCD natifs (injection XML pivotCache
  refreshOnLoad=1 : Excel reconstruit le cache à l'ouverture). En cas d'échec
  d'injection, le classeur reste valide (feuilles d'agrégats équivalentes).
"""
import json
import math
import os
import re
import sys
import urllib.request
import urllib.parse
import zipfile
import shutil
import tempfile
from datetime import date, datetime, timedelta
from collections import defaultdict

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, DoughnutChart, Reference, Series
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ── Styles Ability ────────────────────────────────────────────────────────────
ORANGE = "F97316"
ORANGE_DARK = "EA580C"
SOFT = "FFEDD5"
GREY = "585E74"
HDR_FILL = PatternFill("solid", fgColor=ORANGE)
HDR_FONT = Font(bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(bold=True, size=15, color=ORANGE_DARK)
SUB_FONT = Font(italic=True, size=10, color=GREY)
KPI_FILL = PatternFill("solid", fgColor=SOFT)
THIN = Border(bottom=Side(style="thin", color="E8EAED"))
EUR_FMT = '#,##0.00" €"'
KWH_FMT = '#,##0" kWh"'
CENT_FMT = '0.00" c€"'
PCT_FMT = '0.0"%"'

# ── Accès Supabase (REST, paginé) ────────────────────────────────────────────
SB_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

def sb_get(path: str, params: dict) -> list:
    rows, start = [], 0
    while True:
        qs = urllib.parse.urlencode(params)
        req = urllib.request.Request(f"{SB_URL}/rest/v1/{path}?{qs}")
        req.add_header("apikey", SB_KEY)
        req.add_header("Authorization", f"Bearer {SB_KEY}")
        req.add_header("Range", f"{start}-{start + 999}")
        with urllib.request.urlopen(req, timeout=60) as r:
            batch = json.loads(r.read().decode())
        rows.extend(batch)
        if len(batch) < 1000:
            return rows
        start += 1000

def load_data(p: dict):
    inv_params = {
        "select": "id,facture_number,facture_date,total_ht,tva,autres_taxes,total_ttc,categorie,commune_id,site_id,communes(nom),sites(nom,pdl,kva)",
        "archived": "eq.false", "order": "facture_date.asc",
    }
    if p.get("communeId"):
        inv_params["commune_id"] = f"eq.{p['communeId']}"
    if p.get("siteId"):
        inv_params["site_id"] = f"eq.{p['siteId']}"
    if p.get("from"):
        inv_params["facture_date"] = f"gte.{p['from']}"
    invoices = sb_get("invoices", inv_params)
    if p.get("to"):
        invoices = [i for i in invoices if i["facture_date"] <= p["to"]]
    ids = {i["id"] for i in invoices}
    periods = [r for r in sb_get("consumption_periods", {
        "select": "invoice_id,poste_tarifaire,period_start,period_end,consommation_kwh,prix_unitaire_ckwh,montant_eur"}) if r["invoice_id"] in ids]
    charges = [r for r in sb_get("invoice_charges", {
        "select": "invoice_id,category,libelle,period_start,period_end,montant_eur"}) if r["invoice_id"] in ids]
    return invoices, periods, charges

# ── Normalisation pro-rata sur semestres calendaires ─────────────────────────
def classify(poste: str) -> str:
    s = (poste or "").lower()
    if "pleine" in s or s.startswith("hp"):
        return "HP"
    if "creuse" in s or s.startswith("hc"):
        return "HC"
    return "Base"

def d(s: str) -> date:
    return date.fromisoformat(s)

def semester_buckets(start: date, end: date):
    """Rend [(annee, semestre, jours_de_chevauchement)] pour [start, end] inclus."""
    out = []
    y = start.year
    while y <= end.year:
        for half, (b0, b1) in ((1, (date(y, 1, 1), date(y, 6, 30))), (2, (date(y, 7, 1), date(y, 12, 31)))):
            lo, hi = max(start, b0), min(end, b1)
            if lo <= hi:
                out.append((y, half, (hi - lo).days + 1))
        y += 1
    return out

def normalize(invoices, periods, charges):
    """→ lignes longues : 1 ligne par (facture × poste × bucket semestriel), pro-rata jours."""
    inv_by_id = {i["id"]: i for i in invoices}
    period_range = {}
    for r in periods:
        if r["period_start"] and r["period_end"]:
            cur = period_range.get(r["invoice_id"])
            lo, hi = d(r["period_start"]), d(r["period_end"])
            period_range[r["invoice_id"]] = (min(lo, cur[0]) if cur else lo, max(hi, cur[1]) if cur else hi)
    rows = []

    def push(inv, type_, poste, start, end, kwh, eur):
        if not start or not end:
            fd = d(inv["facture_date"])
            start, end = fd - timedelta(days=181), fd  # repli : semestre glissant avant facture
        total_days = (end - start).days + 1
        for (yy, hh, days) in semester_buckets(start, end):
            f = days / total_days
            rows.append({
                "commune": (inv.get("communes") or {}).get("nom", "—"),
                "site": (inv.get("sites") or {}).get("nom", "—"),
                "cat": "Éclairage public" if inv.get("categorie") == "eclairage_public" else "Bâtiment",
                "type": type_, "poste": poste, "annee": yy, "sem": f"S{hh}", "periode": f"{yy}-S{hh}",
                "kwh": round(kwh * f, 1), "eur": round(eur * f, 2),
                "num": inv["facture_number"], "date": inv["facture_date"],
            })

    for r in periods:
        inv = inv_by_id.get(r["invoice_id"])
        if not inv:
            continue
        push(inv, "Consommation", classify(r["poste_tarifaire"]),
             d(r["period_start"]) if r["period_start"] else None,
             d(r["period_end"]) if r["period_end"] else None,
             float(r["consommation_kwh"] or 0), float(r["montant_eur"] or 0))
    for r in charges:
        inv = inv_by_id.get(r["invoice_id"])
        if not inv:
            continue
        typ = "Part fixe" if r["category"] == "fixed" else "Taxes"
        poste = "Part fixe" if typ == "Part fixe" else (r["libelle"] or "Taxe")
        rng = period_range.get(r["invoice_id"])
        start = d(r["period_start"]) if r["period_start"] else (rng[0] if rng else None)
        end = d(r["period_end"]) if r["period_end"] else (rng[1] if rng else None)
        push(inv, typ, poste, start, end, 0.0, float(r["montant_eur"] or 0))
    return rows

# ── Agrégations utilitaires ──────────────────────────────────────────────────
def agg(rows, keyf):
    out = defaultdict(lambda: {"kwh": 0.0, "eur": 0.0})
    for r in rows:
        k = keyf(r)
        out[k]["kwh"] += r["kwh"]
        out[k]["eur"] += r["eur"]
    return out

def periods_sorted(rows):
    return sorted({r["periode"] for r in rows})

def years_sorted(rows):
    return sorted({r["annee"] for r in rows})

# ── Écriture des feuilles ────────────────────────────────────────────────────
def style_header(ws, row=1, upto=None):
    upto = upto or ws.max_column
    for c in range(1, upto + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = Alignment(vertical="center")
    ws.freeze_panes = ws.cell(row=row + 1, column=1)

def sheet_garde(wb, p, invoices, scope_label):
    ws = wb.active
    ws.title = "Garde"
    ws["A1"] = "Ability — Rapport d'analyse des factures d'électricité"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = "Syndicat Mixte d'Électricité de la Martinique (SMEM)"
    ws["A2"].font = SUB_FONT
    labels = {
        "commune": "Rapport par commune", "site": "Rapport par site", "synthese": "Rapport de synthèse",
        "avant_apres": "Rapport avant / après rénovation (PEPP)", "tarifs": "Évolution tarifaire & effet prix-volume",
    }
    rows = [
        ("Type de rapport", labels.get(p["report"], p["report"])),
        ("Périmètre", scope_label),
        ("Factures analysées", len(invoices)),
        ("Période couverte", f"{min((i['facture_date'] for i in invoices), default='—')} → {max((i['facture_date'] for i in invoices), default='—')}"),
        ("Généré le", datetime.now().strftime("%d/%m/%Y %H:%M")),
        ("Données data logger", "Incluses (démonstration)" if p.get("dataLogger") else "Non incluses (espace réservé)"),
    ]
    r = 4
    for k, v in rows:
        ws.cell(row=r, column=1, value=k).font = Font(bold=True)
        c = ws.cell(row=r, column=2, value=v)
        c.fill = KPI_FILL
        r += 1
    ws["A11"] = "Méthodologie : les périodes de facturation (souvent à cheval sur deux semestres) sont ventilées"
    ws["A12"] = "au pro-rata des jours sur les semestres calendaires S1 (janv–juin) et S2 (juil–déc)."
    ws["A11"].font = SUB_FONT
    ws["A12"].font = SUB_FONT
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 52
    return ws

DATA_HEADERS = ["Commune", "Site", "Catégorie", "Type", "Poste", "Année", "Semestre", "Période", "kWh", "Montant €", "Prix moyen c€/kWh", "N° facture", "Date facture"]

def sheet_donnees(wb, rows):
    ws = wb.create_sheet("Données")
    ws.append(DATA_HEADERS)
    for r in rows:
        prix = round(r["eur"] / r["kwh"] * 100, 2) if r["kwh"] > 0 and r["type"] == "Consommation" else None
        ws.append([r["commune"], r["site"], r["cat"], r["type"], r["poste"], r["annee"], r["sem"], r["periode"],
                   round(r["kwh"], 1), round(r["eur"], 2), prix, r["num"], r["date"]])
    style_header(ws)
    widths = [20, 24, 16, 14, 16, 8, 10, 10, 11, 12, 16, 22, 12]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for col, fmt in ((9, KWH_FMT), (10, EUR_FMT), (11, CENT_FMT)):
        for row in range(2, ws.max_row + 1):
            ws.cell(row=row, column=col).number_format = fmt
    ws.auto_filter.ref = f"A1:M{ws.max_row}"
    return ws

def write_matrix(ws, top, left_label, col_keys, line_keys, values, fmt, title):
    """Écrit un bloc matrice (lignes × périodes) et rend (r0, c0, nrows, ncols)."""
    ws.cell(row=top, column=1, value=title).font = Font(bold=True, size=12, color=ORANGE_DARK)
    hr = top + 1
    ws.cell(row=hr, column=1, value=left_label)
    for j, ck in enumerate(col_keys):
        ws.cell(row=hr, column=2 + j, value=ck)
    for c in range(1, len(col_keys) + 2):
        cell = ws.cell(row=hr, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
    for i, lk in enumerate(line_keys):
        ws.cell(row=hr + 1 + i, column=1, value=lk)
        for j, ck in enumerate(col_keys):
            v = values.get((lk, ck))
            cell = ws.cell(row=hr + 1 + i, column=2 + j, value=round(v, 2) if v else None)
            cell.number_format = fmt
    total_row = hr + 1 + len(line_keys)
    ws.cell(row=total_row, column=1, value="TOTAL").font = Font(bold=True)
    for j, ck in enumerate(col_keys):
        tot = sum(values.get((lk, ck)) or 0 for lk in line_keys)
        cell = ws.cell(row=total_row, column=2 + j, value=round(tot, 2))
        cell.number_format = fmt
        cell.font = Font(bold=True)
        cell.fill = KPI_FILL
    ws.column_dimensions["A"].width = 26
    return hr, 1, len(line_keys) + 1, len(col_keys)

def add_line_chart(ws, anchor, title, data_ref, cats_ref, y_title):
    ch = LineChart()
    ch.title = title
    ch.height, ch.width = 8, 20
    ch.y_axis.title = y_title
    ch.add_data(data_ref, titles_from_data=True)
    ch.set_categories(cats_ref)
    ws.add_chart(ch, anchor)

def sheet_semestres(wb, rows, group_field, group_label):
    """Feuille « Par semestre » : matrices € et kWh (group × période) + graphiques."""
    ws = wb.create_sheet("Par semestre")
    cols = periods_sorted(rows)
    a_eur = agg([r for r in rows], lambda r: (r[group_field], r["periode"]))
    conso = [r for r in rows if r["type"] == "Consommation"]
    a_kwh = agg(conso, lambda r: (r[group_field], r["periode"]))
    lines = sorted({r[group_field] for r in rows})
    hr1, _, n1, nc = write_matrix(ws, 1, group_label, cols, lines, {k: v["eur"] for k, v in a_eur.items()}, EUR_FMT, "Dépenses TTC-approchées par semestre (€) — toutes composantes")
    top2 = hr1 + n1 + 3
    hr2, _, n2, _ = write_matrix(ws, top2, group_label, cols, lines, {k: v["kwh"] for k, v in a_kwh.items()}, KWH_FMT, "Consommation par semestre (kWh)")
    # Graphiques sur les lignes TOTAL
    ncols = len(cols)
    cats = Reference(ws, min_col=2, max_col=1 + ncols, min_row=hr1, max_row=hr1)
    data_eur = Reference(ws, min_col=1, max_col=1 + ncols, min_row=hr1 + n1, max_row=hr1 + n1)
    add_line_chart(ws, f"A{hr2 + n2 + 3}", "Évolution des dépenses (€)", data_eur, cats, "€")
    data_kwh = Reference(ws, min_col=1, max_col=1 + ncols, min_row=hr2 + n2, max_row=hr2 + n2)
    add_line_chart(ws, f"L{hr2 + n2 + 3}", "Évolution de la consommation (kWh)", data_kwh, cats, "kWh")
    return ws

def sheet_decomposition(wb, rows):
    """Décomposition tarifaire : Base / HP / HC / Part fixe / Taxes, par année + anneau."""
    ws = wb.create_sheet("Décomposition")
    years = years_sorted(rows)
    postes = ["Base", "HP", "HC", "Part fixe", "Taxes"]
    def poste_of(r):
        return r["poste"] if r["type"] == "Consommation" else ("Part fixe" if r["type"] == "Part fixe" else "Taxes")
    a = agg(rows, lambda r: (poste_of(r), r["annee"]))
    hr, _, n, nc = write_matrix(ws, 1, "Composante", [str(y) for y in years], postes,
                                {(p, str(y)): (a.get((p, y)) or {"eur": 0})["eur"] for p in postes for y in years},
                                EUR_FMT, "Décomposition de la dépense par composante tarifaire (€)")
    # kWh par poste variable
    conso = [r for r in rows if r["type"] == "Consommation"]
    ak = agg(conso, lambda r: (r["poste"], r["annee"]))
    top2 = hr + n + 3
    write_matrix(ws, top2, "Poste", [str(y) for y in years], ["Base", "HP", "HC"],
                 {(p, str(y)): (ak.get((p, y)) or {"kwh": 0})["kwh"] for p in ["Base", "HP", "HC"] for y in years},
                 KWH_FMT, "Consommation par poste tarifaire (kWh)")
    # Anneau : répartition dernière année complète
    last = years[-1] if years else None
    if last:
        ch = DoughnutChart()
        ch.title = f"Répartition de la dépense {last}"
        labels = Reference(ws, min_col=1, min_row=hr + 1, max_row=hr + len(postes))
        col = 1 + len(years)  # dernière colonne d'années
        data = Reference(ws, min_col=col + 0, max_col=col, min_row=hr, max_row=hr + len(postes))
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(labels)
        ch.height, ch.width = 8, 12
        ws.add_chart(ch, f"A{top2 + 8}")
    return ws

def detect_renovation(rows_commune):
    """Détecte la fenêtre de travaux EP : plus forte baisse de kWh EP entre années consécutives."""
    ep = [r for r in rows_commune if r["type"] == "Consommation" and r["cat"] == "Éclairage public"]
    per_year = defaultdict(float)
    for r in ep:
        per_year[r["annee"]] += r["kwh"]
    ys = sorted(y for y in per_year if per_year[y] > 0)
    best, drop_y = 0.0, None
    for a, b in zip(ys, ys[1:]):
        if per_year[a] > 0:
            dr = (per_year[a] - per_year[b]) / per_year[a]
            if dr > best:
                best, drop_y = dr, b
    return drop_y, best, per_year

def sheet_avant_apres(wb, rows):
    ws = wb.create_sheet("Avant-Après")
    ws["A1"] = "Analyse avant / après rénovation de l'éclairage public (programme PEPP)"
    ws["A1"].font = Font(bold=True, size=13, color=ORANGE_DARK)
    ws["A2"] = "Fenêtre de travaux estimée automatiquement : année de plus forte baisse de consommation EP."
    ws["A2"].font = SUB_FONT
    headers = ["Commune", "Année charnière (est.)", "kWh EP avant (moy./an)", "kWh EP après (moy./an)", "Baisse conso", "€ EP avant (moy./an)", "€ EP après (moy./an)", "Évolution €"]
    ws.append([])
    ws.append(headers)
    hr = 4
    style_header(ws, row=hr)
    communes = sorted({r["commune"] for r in rows})
    ri = hr + 1
    for cm in communes:
        sub = [r for r in rows if r["commune"] == cm]
        pivot_y, drop, per_year = detect_renovation(sub)
        ep_eur = defaultdict(float)
        for r in sub:
            if r["cat"] == "Éclairage public":
                ep_eur[r["annee"]] += r["eur"]
        if not pivot_y:
            ws.append([cm, "n.d.", None, None, None, None, None, None])
            ri += 1
            continue
        before_y = [y for y in per_year if y < pivot_y]
        after_y = [y for y in per_year if y >= pivot_y]
        kb = sum(per_year[y] for y in before_y) / max(1, len(before_y))
        ka = sum(per_year[y] for y in after_y) / max(1, len(after_y))
        eb = sum(ep_eur[y] for y in before_y) / max(1, len(before_y))
        ea = sum(ep_eur[y] for y in after_y) / max(1, len(after_y))
        ws.append([cm, pivot_y, round(kb), round(ka), (ka - kb) / kb * 100 if kb else None,
                   round(eb, 2), round(ea, 2), (ea - eb) / eb * 100 if eb else None])
        for col, fmt in ((3, KWH_FMT), (4, KWH_FMT), (5, PCT_FMT), (6, EUR_FMT), (7, EUR_FMT), (8, PCT_FMT)):
            ws.cell(row=ri, column=col).number_format = fmt
        ri += 1
    for i, w in enumerate([22, 18, 20, 20, 12, 18, 18, 12], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    # Graphe barres avant/après kWh
    ch = BarChart()
    ch.type = "col"
    ch.title = "kWh éclairage public : avant vs après travaux (moyenne annuelle)"
    data = Reference(ws, min_col=3, max_col=4, min_row=hr, max_row=ri - 1)
    cats = Reference(ws, min_col=1, min_row=hr + 1, max_row=ri - 1)
    ch.add_data(data, titles_from_data=True)
    ch.set_categories(cats)
    ch.height, ch.width = 9, 22
    ws.add_chart(ch, f"A{ri + 2}")
    ws.cell(row=ri + 22, column=1,
            value="Lecture : la baisse de consommation issue des travaux est en partie effacée par la hausse du prix de l'électricité (voir feuille Tarifs).").font = SUB_FONT
    return ws

def sheet_tarifs(wb, rows):
    ws = wb.create_sheet("Tarifs")
    conso = [r for r in rows if r["type"] == "Consommation" and r["kwh"] > 0]
    cols = periods_sorted(conso)
    postes = ["Base", "HP", "HC"]
    vals = {}
    for p in postes:
        for per in cols:
            sub = [r for r in conso if r["poste"] == p and r["periode"] == per]
            k = sum(r["kwh"] for r in sub)
            e = sum(r["eur"] for r in sub)
            if k > 0:
                vals[(p, per)] = e / k * 100
    hr, _, n, nc = write_matrix(ws, 1, "Poste", cols, postes, vals, CENT_FMT, "Prix moyen constaté par poste (c€/kWh, part variable)")
    cats = Reference(ws, min_col=2, max_col=1 + len(cols), min_row=hr, max_row=hr)
    data = Reference(ws, min_col=1, max_col=1 + len(cols), min_row=hr + 1, max_row=hr + len(postes))
    ch = LineChart()
    ch.title = "Évolution du prix moyen par poste (c€/kWh)"
    ch.add_data(data, titles_from_data=True, from_rows=True)
    ch.set_categories(cats)
    ch.height, ch.width = 9, 22
    ws.add_chart(ch, f"A{hr + n + 3}")
    # Effet prix / effet volume par année (Laspeyres simple)
    years = years_sorted(conso)
    per_year = defaultdict(lambda: {"kwh": 0.0, "eur": 0.0})
    for r in conso:
        per_year[r["annee"]]["kwh"] += r["kwh"]
        per_year[r["annee"]]["eur"] += r["eur"]
    top = hr + n + 22
    ws.cell(row=top, column=1, value="Effet prix vs effet volume (part variable, année vs année précédente)").font = Font(bold=True, size=12, color=ORANGE_DARK)
    ws.append([])
    hdr = ["Année", "kWh", "€ (variable)", "Prix moyen c€/kWh", "Δ€ total", "dont effet volume", "dont effet prix"]
    for j, h in enumerate(hdr):
        c = ws.cell(row=top + 1, column=1 + j, value=h)
        c.fill = HDR_FILL
        c.font = HDR_FONT
    prev = None
    ri = top + 2
    for y in years:
        k, e = per_year[y]["kwh"], per_year[y]["eur"]
        p = e / k * 100 if k else 0
        if prev:
            pk, pe, pp = prev
            d_tot = e - pe
            d_vol = (k - pk) * pp / 100
            d_prix = (p - pp) / 100 * k
            ws.append([y, round(k), round(e, 2), round(p, 2), round(d_tot, 2), round(d_vol, 2), round(d_prix, 2)])
        else:
            ws.append([y, round(k), round(e, 2), round(p, 2), None, None, None])
        for col, fmt in ((2, KWH_FMT), (3, EUR_FMT), (4, CENT_FMT), (5, EUR_FMT), (6, EUR_FMT), (7, EUR_FMT)):
            ws.cell(row=ri, column=col).number_format = fmt
        prev = (k, e, p)
        ri += 1
    for i, w in enumerate([10, 12, 14, 16, 12, 16, 14], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    return ws

def sheet_datalogger(wb, p, scope_label):
    if not p.get("dataLogger"):
        ws = wb.create_sheet("Data loggers")
        ws["A1"] = "Données complémentaires — data loggers d'armoires"
        ws["A1"].font = Font(bold=True, size=13, color=ORANGE_DARK)
        ws["A3"] = "EMPLACEMENT RÉSERVÉ — le connecteur data logger n'est pas encore raccordé."
        ws["A3"].font = Font(bold=True, color="B45309")
        ws["A3"].fill = KPI_FILL
        ws["A5"] = "À la connexion, cette section présentera : allumage/extinction, puissance instantanée,"
        ws["A6"] = "coupures réseau, consommation d'énergie et profil de charge — indépendamment des factures."
        ws["A5"].font = SUB_FONT
        ws["A6"].font = SUB_FONT
        ws.column_dimensions["A"].width = 100
        return ws
    ws = wb.create_sheet("Data loggers (démo)")
    ws["A1"] = "Données complémentaires — data loggers d'armoires (DONNÉES FICTIVES DE DÉMONSTRATION)"
    ws["A1"].font = Font(bold=True, size=13, color="B91C1C")
    ws["A2"] = f"Section indépendante des factures et abonnements · périmètre : {scope_label}"
    ws["A2"].font = SUB_FONT
    # Profil de puissance 24 h (pas 30 min) — armoire type
    ws["A4"] = "Profil de puissance instantanée — armoire type (24 h, pas 30 min)"
    ws["A4"].font = Font(bold=True, size=12, color=ORANGE_DARK)
    ws.cell(row=5, column=1, value="Heure").fill = HDR_FILL
    ws.cell(row=5, column=1).font = HDR_FONT
    ws.cell(row=5, column=2, value="Puissance (W)").fill = HDR_FILL
    ws.cell(row=5, column=2).font = HDR_FONT
    ri = 6
    for step in range(48):
        h = step / 2
        on = h <= 5.5 or h >= 18.5  # allumage nocturne
        base_w = 4200 if on else 35
        w = base_w + (math.sin(step * 1.7) * 160 if on else 3)
        ws.cell(row=ri, column=1, value=f"{int(h):02d}:{'30' if step % 2 else '00'}")
        ws.cell(row=ri, column=2, value=round(max(0, w)))
        ri += 1
    ch = LineChart()
    ch.title = "Profil de charge 24 h (fictif)"
    data = Reference(ws, min_col=2, min_row=5, max_row=ri - 1)
    cats = Reference(ws, min_col=1, min_row=6, max_row=ri - 1)
    ch.add_data(data, titles_from_data=True)
    ch.set_categories(cats)
    ch.height, ch.width = 9, 18
    ws.add_chart(ch, "D5")
    # Allumage/extinction + coupures
    ws.cell(row=ri + 2, column=1, value="Allumage / extinction (7 derniers jours, fictif)").font = Font(bold=True, size=12, color=ORANGE_DARK)
    hdr_row = ri + 3
    for j, h in enumerate(["Jour", "Allumage", "Extinction", "Durée (h)", "Énergie (kWh)"]):
        c = ws.cell(row=hdr_row, column=1 + j, value=h)
        c.fill = HDR_FILL
        c.font = HDR_FONT
    for k in range(7):
        day = date.today() - timedelta(days=6 - k)
        on_m = 18 * 60 + 24 + (k * 7) % 12
        off_m = 5 * 60 + 41 - (k * 5) % 10
        dur = (24 * 60 - on_m + off_m) / 60
        ws.append([day.strftime("%d/%m"), f"{on_m // 60:02d}:{on_m % 60:02d}", f"{off_m // 60:02d}:{off_m % 60:02d}", round(dur, 2), round(dur * 4.2, 1)])
    ws.cell(row=hdr_row + 9, column=1, value="Coupures réseau détectées (fictif)").font = Font(bold=True, size=12, color=ORANGE_DARK)
    for j, h in enumerate(["Date", "Début", "Durée", "Armoire"]):
        c = ws.cell(row=hdr_row + 10, column=1 + j, value=h)
        c.fill = HDR_FILL
        c.font = HDR_FONT
    for vals in (["12/06/2026", "03:12", "18 min", "EP Bourg"], ["27/05/2026", "21:47", "4 min", "EP Bourg"], ["03/05/2026", "02:05", "1 h 02", "EP Route principale"]):
        ws.append(vals)
    for i, w in enumerate([12, 12, 12, 12, 14], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    return ws

# ── TCD natifs : injection XML (pivotCache refreshOnLoad) ────────────────────
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

def _cache_definition_xml(n_rows: int) -> bytes:
    fields = "".join(
        f'<cacheField name="{h}" numFmtId="0"><sharedItems containsBlank="1"/></cacheField>'
        for h in DATA_HEADERS
    )
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<pivotCacheDefinition xmlns="{NS_MAIN}" xmlns:r="{NS_R}" r:id="rId1" refreshOnLoad="1" refreshedBy="Ability" '
        f'refreshedDate="45000" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="0">'
        f'<cacheSource type="worksheet"><worksheetSource ref="A1:M{n_rows}" sheet="Données"/></cacheSource>'
        f'<cacheFields count="{len(DATA_HEADERS)}">{fields}</cacheFields>'
        f"</pivotCacheDefinition>"
    ).encode()

def _cache_records_xml() -> bytes:
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<pivotCacheRecords xmlns="{NS_MAIN}" xmlns:r="{NS_R}" count="0"/>').encode()

def _pivot_table_xml(name: str, cache_id: int, row_fields, col_fields, data_field, data_label, ref: str) -> bytes:
    k = len(DATA_HEADERS)
    pf = []
    for i in range(k):
        if i in row_fields:
            pf.append('<pivotField axis="axisRow" showAll="0"><items count="1"><item t="default"/></items></pivotField>')
        elif i in col_fields:
            pf.append('<pivotField axis="axisCol" showAll="0"><items count="1"><item t="default"/></items></pivotField>')
        elif i == data_field:
            pf.append('<pivotField dataField="1" showAll="0"/>')
        else:
            pf.append('<pivotField showAll="0"/>')
    rows_xml = "".join(f'<field x="{i}"/>' for i in row_fields)
    cols_xml = "".join(f'<field x="{i}"/>' for i in col_fields)
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<pivotTableDefinition xmlns="{NS_MAIN}" name="{name}" cacheId="{cache_id}" applyNumberFormats="0" '
        f'applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" '
        f'applyWidthHeightFormats="1" dataCaption="Valeurs" updatedVersion="6" createdVersion="6" minRefreshableVersion="3" '
        f'useAutoFormatting="1" itemPrintTitles="1" indent="0" outline="1" outlineData="1" multipleFieldFilters="0">'
        f'<location ref="{ref}" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>'
        f'<pivotFields count="{k}">{"".join(pf)}</pivotFields>'
        f'<rowFields count="{len(row_fields)}">{rows_xml}</rowFields>'
        f'<rowItems count="1"><i t="grand"><x/></i></rowItems>'
        + (f'<colFields count="{len(col_fields)}">{cols_xml}</colFields><colItems count="1"><i t="grand"><x/></i></colItems>' if col_fields else "")
        + f'<dataFields count="1"><dataField name="{data_label}" fld="{data_field}" baseField="0" baseItem="0"/></dataFields>'
        f'<pivotTableStyleInfo name="PivotStyleMedium9" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>'
        f"</pivotTableDefinition>"
    ).encode()

def inject_pivots(xlsx_path: str, n_data_rows: int, pivots: list):
    """Ajoute des TCD natifs au classeur (post-traitement du zip).
    pivots: [{sheet_index (1-based, ordre openpyxl), name, rows, cols, data, label, ref}]"""
    tmp = xlsx_path + ".tmp"
    with zipfile.ZipFile(xlsx_path, "r") as zin:
        names = zin.namelist()
        contents = {n: zin.read(n) for n in names}

    wb_xml = contents["xl/workbook.xml"].decode()
    rels_xml = contents["xl/_rels/workbook.xml.rels"].decode()

    # 2. pivotCache (1 seul, partagé)
    contents["xl/pivotCache/pivotCacheDefinition1.xml"] = _cache_definition_xml(n_data_rows)
    contents["xl/pivotCache/pivotCacheRecords1.xml"] = _cache_records_xml()
    contents["xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels"] = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheRecords" Target="pivotCacheRecords1.xml"/>'
        f"</Relationships>"
    ).encode()

    # 3. workbook.xml : bloc <pivotCaches> + rel
    next_rid = max(int(m) for m in re.findall(r'Id="rId(\d+)"', rels_xml)) + 1
    cache_rid = f"rId{next_rid}"
    rels_xml = rels_xml.replace("</Relationships>",
        f'<Relationship Id="{cache_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/></Relationships>')
    if "<pivotCaches>" not in wb_xml:
        wb_xml = wb_xml.replace(
            "</workbook>",
            f'<pivotCaches><pivotCache cacheId="10" xmlns:r="{NS_R}" r:id="{cache_rid}"/></pivotCaches></workbook>',
        )
    contents["xl/workbook.xml"] = wb_xml.encode()
    contents["xl/_rels/workbook.xml.rels"] = rels_xml.encode()

    # 4. pivotTables + rels des feuilles cibles
    ct = contents["[Content_Types].xml"].decode()
    for idx, p in enumerate(pivots, start=1):
        contents[f"xl/pivotTables/pivotTable{idx}.xml"] = _pivot_table_xml(
            p["name"], 10, p["rows"], p["cols"], p["data"], p["label"], p["ref"])
        contents[f"xl/pivotTables/_rels/pivotTable{idx}.xml.rels"] = (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>'
            f"</Relationships>"
        ).encode()
        # openpyxl écrit les feuilles séquentiellement : sheet{n}.xml dans l'ordre du classeur
        rels_path = f"xl/worksheets/_rels/sheet{p['sheet_index']}.xml.rels"
        rels = contents.get(rels_path, b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>').decode()
        rels = rels.replace("</Relationships>",
            f'<Relationship Id="rIdP{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable{idx}.xml"/></Relationships>')
        contents[rels_path] = rels.encode()
        ct = ct.replace("</Types>",
            f'<Override PartName="/xl/pivotTables/pivotTable{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/></Types>')
    ct = ct.replace("</Types>",
        '<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>'
        '<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/></Types>')
    contents["[Content_Types].xml"] = ct.encode()

    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for n, data in contents.items():
            zout.writestr(n, data)
    shutil.move(tmp, xlsx_path)

# ── Assemblage ────────────────────────────────────────────────────────────────
COL = {h: i for i, h in enumerate(DATA_HEADERS)}  # index 0-based pour les TCD

def build(p: dict, out_path: str):
    invoices, periods, charges = load_data(p)
    if not invoices:
        raise SystemExit("Aucune facture dans le périmètre demandé.")
    rows = normalize(invoices, periods, charges)

    if p["report"] == "commune":
        scope = rows[0]["commune"] if rows else "Commune"
        group_field, group_label = "site", "Site"
    elif p["report"] == "site":
        scope = rows[0]["site"] if rows else "Site"
        group_field, group_label = "poste", "Poste"
    else:
        scope = "Toutes communes (portefeuille SMEM)"
        group_field, group_label = "commune", "Commune"

    wb = Workbook()
    sheet_garde(wb, p, invoices, scope)
    if p["report"] == "avant_apres":
        sheet_avant_apres(wb, rows)
        sheet_tarifs(wb, rows)
    elif p["report"] == "tarifs":
        sheet_tarifs(wb, rows)
        sheet_decomposition(wb, rows)
    else:
        sheet_semestres(wb, rows, group_field, group_label)
        sheet_decomposition(wb, rows)
        if p["report"] == "synthese":
            sheet_avant_apres(wb, rows)
    tcd1 = wb.create_sheet("TCD €")
    tcd1["A1"] = "Tableau croisé dynamique — montants (€). Actualisé automatiquement à l'ouverture d'Excel."
    tcd1["A1"].font = SUB_FONT
    tcd2 = wb.create_sheet("TCD kWh")
    tcd2["A1"] = "Tableau croisé dynamique — consommation (kWh). Actualisé automatiquement à l'ouverture d'Excel."
    tcd2["A1"].font = SUB_FONT
    ws_data = sheet_donnees(wb, rows)
    sheet_datalogger(wb, p, scope)
    wb.save(out_path)

    try:
        inject_pivots(out_path, ws_data.max_row, [
            {"sheet_index": wb.sheetnames.index("TCD €") + 1, "name": "TCD_Montants",
             "rows": [COL["Commune"], COL["Site"]], "cols": [COL["Période"]],
             "data": COL["Montant €"], "label": "Somme de Montant €", "ref": "A3"},
            {"sheet_index": wb.sheetnames.index("TCD kWh") + 1, "name": "TCD_kWh",
             "rows": [COL["Poste"], COL["Catégorie"]], "cols": [COL["Année"]],
             "data": COL["kWh"], "label": "Somme de kWh", "ref": "A3"},
        ])
    except Exception as exc:  # repli : classeur valide sans TCD (agrégats déjà présents)
        sys.stderr.write(f"[pivot] injection ignorée : {exc}\n")

def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: generate_report.py '<params-json>' <out.xlsx>")
    params = json.loads(sys.argv[1])
    build(params, sys.argv[2])
    print("OK")

if __name__ == "__main__":
    main()
