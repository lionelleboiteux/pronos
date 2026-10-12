"""Mapping between the pronos DB's team names and football-data.co.uk's."""

from __future__ import annotations

import difflib

LEAGUE_TO_FD = {"BL1": "D1", "L1": "F1", "LL": "SP1", "PL": "E0", "SA": "I1"}

# Pronos DB team name -> football-data.co.uk name (only where they differ).
NAMES = {
    # Bundesliga
    "1. FC Köln": "FC Koln", "1. FC Union Berlin": "Union Berlin", "1. FSV Mainz 05": "Mainz",
    "Bayer 04 Leverkusen": "Leverkusen", "Borussia Dortmund": "Dortmund",
    "Borussia Mönchengladbach": "M'gladbach", "Eintracht Frankfurt": "Ein Frankfurt",
    "FC Augsburg": "Augsburg", "FC Bayern München": "Bayern Munich", "FC Schalke 04": "Schalke 04",
    "Hamburger SV": "Hamburg", "SC Freiburg": "Freiburg", "SC Paderborn 07": "Paderborn",
    "SV 07 Elversberg": "Elversberg", "SV Werder Bremen": "Werder Bremen",
    "TSG Hoffenheim": "Hoffenheim", "VfB Stuttgart": "Stuttgart",
    # Ligue 1
    "AJ Auxerre": "Auxerre", "AS Monaco": "Monaco", "Angers SCO": "Angers", "Estac Troyes": "Troyes",
    "FC Lorient": "Lorient", "Havre Athletic Club": "Le Havre", "LOSC Lille": "Lille",
    "Le Mans FC": "Le Mans", "OGC Nice": "Nice", "Olympique Lyonnais": "Lyon",
    "Olympique de Marseille": "Marseille", "Paris Saint-Germain": "Paris SG", "RC Lens": "Lens",
    "RC Strasbourg Alsace": "Strasbourg", "Stade Brestois 29": "Brest", "Stade Rennais FC": "Rennes",
    "Toulouse FC": "Toulouse",
    # La Liga
    "Athletic Club": "Ath Bilbao", "Atlético de Madrid": "Ath Madrid", "CA Osasuna": "Osasuna",
    "Deportivo Alavés": "Alaves", "Elche CF": "Elche", "FC Barcelona": "Barcelona", "Getafe CF": "Getafe",
    "Levante UD": "Levante", "Málaga CF": "Malaga", "R. Racing Club": "Santander",
    "RC Deportivo": "La Coruna", "RCD Espanyol de Barcelona": "Espanol", "Rayo Vallecano": "Vallecano",
    "Real Betis": "Betis", "Real Sociedad": "Sociedad", "Sevilla FC": "Sevilla", "Valencia CF": "Valencia",
    "Villarreal CF": "Villarreal",
    # Premier League
    "Brighton and Hove Albion": "Brighton", "Coventry City": "Coventry", "Hull City": "Hull",
    "Ipswich Town": "Ipswich", "Leeds United": "Leeds", "Manchester City": "Man City",
    "Manchester United": "Man United", "Newcastle United": "Newcastle",
    "Nottingham Forest": "Nott'm Forest", "Tottenham Hotspur": "Tottenham",
}


def resolve(db_name: str, known: set[str]) -> str | None:
    """football-data name for a DB team name, or None if nothing plausible.

    Order: explicit NAMES entry, identical name, then a close fuzzy match
    (so a newly promoted side with a near-identical name still resolves
    without a code change). Callers should log when this returns None or
    when the fuzzy path was used.
    """
    for cand in (NAMES.get(db_name), db_name):
        if cand and cand in known:
            return cand
    close = difflib.get_close_matches(db_name, known, n=1, cutoff=0.75)
    return close[0] if close else None
