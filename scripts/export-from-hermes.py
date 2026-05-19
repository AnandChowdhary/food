#!/usr/bin/env python3
"""Export Anand's nutrition DB into public CSVs for the food repo.

This is intentionally a projection, not a backup: it exports only Anand rows and
omits private notes, raw SQLite IDs, and household/private context.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Amsterdam")
DEFAULT_DB = Path(os.environ.get("FOOD_DB_PATH", "/home/anandchowdhary/.hermes/health/nutrition.db"))
REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
MEAL_ORDER = {
    "breakfast": 1,
    "brunch": 2,
    "lunch": 3,
    "snack": 4,
    "dinner": 5,
    "dessert": 6,
}


def parse_ts(value: str) -> dt.datetime:
    raw = (value or "").strip()
    if not raw:
        raise ValueError("empty timestamp")
    normalized = raw.replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        # Historical rows were written without an offset. Treat them as local
        # food-log time rather than shifting the visible meal day.
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ)


def public_food_name(name: str) -> str:
    public = str(name or "").strip()
    public = re.sub(r"\(home,\s*[^)]*?\s+recipe\)", "(home recipe)", public, flags=re.IGNORECASE)
    public = re.sub(r"\b[^,;()]+(?:'s|’s)\s+recipe\b", "home recipe", public, flags=re.IGNORECASE)
    public = re.sub(r"home\s+recipe\s+recipe", "home recipe", public, flags=re.IGNORECASE)
    public = re.sub(r"\s+", " ", public).strip()
    return public


def forbidden_terms() -> list[str]:
    raw = os.environ.get("FOOD_PUBLIC_FORBIDDEN_TERMS", "")
    return [term.strip().lower() for term in raw.split(",") if term.strip()]


def value(row: sqlite3.Row, key: str) -> float:
    raw = row[key]
    if raw is None:
        return 0.0
    try:
        number = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(number):
        return 0.0
    return number


def amount(row: sqlite3.Row, key: str) -> float:
    return float(row["grams"] or 0) * value(row, key) / 100


def fmt(number: float | int | None, digits: int = 1) -> str:
    if number is None:
        return ""
    try:
        number = float(number)
    except (TypeError, ValueError):
        return ""
    if math.isnan(number):
        return ""
    rounded = round(number, digits)
    if digits == 0:
        return str(int(round(rounded)))
    text = f"{rounded:.{digits}f}".rstrip("0").rstrip(".")
    return text if text else "0"


def latest_goal_for_day(goals: list[dict], day: str) -> dict | None:
    if not goals:
        return None
    day_end = dt.datetime.fromisoformat(day).replace(tzinfo=TZ) + dt.timedelta(days=1)
    eligible = [goal for goal in goals if goal["set_at"] is None or goal["set_at"] < day_end]
    return eligible[-1] if eligible else goals[-1]


def read_goals(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        """
        SELECT kcal, protein, fat, carb, fiber, set_at, id
        FROM goals
        WHERE person = 'anand'
        ORDER BY COALESCE(set_at, ''), id
        """
    ).fetchall()
    goals = []
    for row in rows:
        set_at = None
        if row["set_at"]:
            try:
                set_at = parse_ts(row["set_at"])
            except Exception:
                set_at = None
        goals.append(
            {
                "kcal": value(row, "kcal"),
                "protein": value(row, "protein"),
                "fat": value(row, "fat"),
                "carb": value(row, "carb"),
                "fiber": value(row, "fiber"),
                "set_at": set_at,
            }
        )
    return goals


def query_entries(db_path: Path) -> tuple[list[dict], list[dict]]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT
          e.id,
          e.ts,
          e.meal,
          e.grams,
          f.name AS food,
          f.kcal_100g,
          f.protein_100g,
          f.fat_100g,
          f.carb_100g,
          f.fiber_100g
        FROM entries e
        JOIN foods f ON f.id = e.food_id
        WHERE e.person = 'anand'
        ORDER BY e.ts, e.id
        """
    ).fetchall()
    goals = read_goals(con)
    con.close()

    entries = []
    for row in rows:
        local_dt = parse_ts(row["ts"])
        entries.append(
            {
                "_sort": (local_dt.isoformat(), row["id"]),
                "date": local_dt.date().isoformat(),
                "time": local_dt.strftime("%H:%M"),
                "datetime": local_dt.isoformat(timespec="minutes"),
                "meal": (row["meal"] or "").strip() or "unspecified",
                "food": public_food_name(row["food"]),
                "grams": float(row["grams"] or 0),
                "kcal": amount(row, "kcal_100g"),
                "protein_g": amount(row, "protein_100g"),
                "fat_g": amount(row, "fat_100g"),
                "carbs_g": amount(row, "carb_100g"),
                "fiber_g": amount(row, "fiber_100g"),
            }
        )
    entries.sort(key=lambda entry: entry["_sort"])
    return entries, goals


def build_meals(entries: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for entry in entries:
        grouped[(entry["date"], entry["meal"])].append(entry)

    meals = []
    for (date, meal), rows in grouped.items():
        rows = sorted(rows, key=lambda row: row["datetime"])
        counts = Counter(row["food"] for row in rows)
        foods = "; ".join(
            f"{name} × {count}" if count > 1 else name for name, count in counts.items()
        )
        meals.append(
            {
                "date": date,
                "meal": meal,
                "first_time": rows[0]["time"],
                "last_time": rows[-1]["time"],
                "items": len(rows),
                "kcal": sum(row["kcal"] for row in rows),
                "protein_g": sum(row["protein_g"] for row in rows),
                "fat_g": sum(row["fat_g"] for row in rows),
                "carbs_g": sum(row["carbs_g"] for row in rows),
                "fiber_g": sum(row["fiber_g"] for row in rows),
                "foods": foods,
            }
        )
    meals.sort(
        key=lambda row: (
            row["date"],
            row["first_time"],
            MEAL_ORDER.get(row["meal"], 99),
            row["meal"],
        )
    )
    return meals


def build_daily(entries: list[dict], meals: list[dict], goals: list[dict]) -> list[dict]:
    entries_by_day: dict[str, list[dict]] = defaultdict(list)
    meals_by_day: dict[str, list[dict]] = defaultdict(list)
    for entry in entries:
        entries_by_day[entry["date"]].append(entry)
    for meal in meals:
        meals_by_day[meal["date"]].append(meal)

    daily = []
    for day in sorted(entries_by_day):
        rows = entries_by_day[day]
        goal = latest_goal_for_day(goals, day) or {}
        protein_goal = goal.get("protein") or 0
        kcal_goal = goal.get("kcal") or 0
        protein = sum(row["protein_g"] for row in rows)
        daily.append(
            {
                "date": day,
                "entries": len(rows),
                "meals": len(meals_by_day[day]),
                "kcal": sum(row["kcal"] for row in rows),
                "protein_g": protein,
                "fat_g": sum(row["fat_g"] for row in rows),
                "carbs_g": sum(row["carbs_g"] for row in rows),
                "fiber_g": sum(row["fiber_g"] for row in rows),
                "protein_goal_g": protein_goal,
                "kcal_goal": kcal_goal,
                "protein_goal_pct": (protein / protein_goal * 100) if protein_goal else None,
            }
        )
    return daily


def write_csv(path: Path, fieldnames: list[str], rows: list[dict], digits: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            out = {}
            for field in fieldnames:
                item = row.get(field, "")
                if isinstance(item, (int, float)) and not isinstance(item, bool):
                    out[field] = fmt(item, digits.get(field, 1))
                elif item is None:
                    out[field] = ""
                else:
                    out[field] = str(item)
            writer.writerow(out)


def validate(entries: list[dict], data_dir: Path) -> None:
    entries_csv = data_dir / "entries.csv"
    with entries_csv.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        headers = set(reader.fieldnames or [])
        exported_count = sum(1 for _ in reader)

    forbidden_headers = {"id", "person", "notes", "created_at", "food_id", "entry_id"}
    leaked_headers = headers & forbidden_headers
    if leaked_headers:
        raise RuntimeError(f"public CSV contains forbidden columns: {sorted(leaked_headers)}")
    if exported_count != len(entries):
        raise RuntimeError(f"entry export count mismatch: CSV={exported_count} DB={len(entries)}")

    terms = forbidden_terms()
    for path in sorted(data_dir.glob("*.csv")):
        text = path.read_text(encoding="utf-8").lower()
        for term in terms:
            if term in text:
                raise RuntimeError(f"privacy validation failed: {path} contains a forbidden local term")


def run(command: list[str], cwd: Path | None = None, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=cwd or REPO_ROOT, check=True, text=True, capture_output=capture)


def commit_and_push(latest_day: str, push: bool) -> None:
    run(["git", "add", "data/entries.csv", "data/meals.csv", "data/daily.csv"])
    status = run(["git", "status", "--short"], capture=True).stdout.strip()
    if not status:
        print("No food data changes to commit.")
        return
    run(["git", "commit", "-m", f":card_file_box: Update food log {latest_day}"])
    if push:
        run(["git", "push", "origin", "main"])


def main() -> int:
    global REPO_ROOT, DATA_DIR

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()

    REPO_ROOT = args.repo.resolve()
    DATA_DIR = REPO_ROOT / "data"

    if not args.db.exists():
        raise FileNotFoundError(args.db)

    entries, goals = query_entries(args.db)
    meals = build_meals(entries)
    daily = build_daily(entries, meals, goals)

    write_csv(
        DATA_DIR / "entries.csv",
        [
            "date",
            "time",
            "datetime",
            "meal",
            "food",
            "grams",
            "kcal",
            "protein_g",
            "fat_g",
            "carbs_g",
            "fiber_g",
        ],
        entries,
        {"grams": 2, "kcal": 0},
    )
    write_csv(
        DATA_DIR / "meals.csv",
        [
            "date",
            "meal",
            "first_time",
            "last_time",
            "items",
            "kcal",
            "protein_g",
            "fat_g",
            "carbs_g",
            "fiber_g",
            "foods",
        ],
        meals,
        {"items": 0, "kcal": 0},
    )
    write_csv(
        DATA_DIR / "daily.csv",
        [
            "date",
            "entries",
            "meals",
            "kcal",
            "protein_g",
            "fat_g",
            "carbs_g",
            "fiber_g",
            "protein_goal_g",
            "kcal_goal",
            "protein_goal_pct",
        ],
        daily,
        {"entries": 0, "meals": 0, "kcal": 0, "protein_goal_g": 0, "kcal_goal": 0, "protein_goal_pct": 0},
    )

    validate(entries, DATA_DIR)
    latest_day = daily[-1]["date"] if daily else dt.date.today().isoformat()
    print(
        f"Exported {len(entries)} entries, {len(meals)} meals, {len(daily)} days "
        f"through {latest_day}."
    )

    if args.commit or args.push:
        commit_and_push(latest_day, args.push)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
