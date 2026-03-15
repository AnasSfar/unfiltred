from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE_DATA_DIR = ROOT / "site" / "data"
HISTORY_DIR = ROOT / "site" / "history"
HISTORY_INDEX_PATH = HISTORY_DIR / "index.json"

SONGS_PATH = SITE_DATA_DIR / "songs.json"
OUTPUT_PATH = SITE_DATA_DIR / "expected_milestones.json"

DEFAULT_MILESTONES = [
    100_000_000,
    200_000_000,
    300_000_000,
    400_000_000,
    500_000_000,
    600_000_000,
    700_000_000,
    800_000_000,
    900_000_000,
    1_000_000_000,
    1_500_000_000,
    2_000_000_000,
    2_500_000_000,
    3_000_000_000,
    3_500_000_000,
    4_000_000_000,
]

MAX_FORECAST_DAYS = 5 * 365
RECENT_WINDOW = 30
MIN_REQUIRED_HISTORY_POINTS = 5


def format_milestone_label(value: int) -> str:
    if value >= 1_000_000_000:
        billions = value / 1_000_000_000
        if abs(billions - round(billions)) < 1e-9:
            return f"{int(round(billions))}B"
        return f"{billions:.1f}B"
    return f"{int(value / 1_000_000)}M"


def safe_float(value, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except Exception:
        return default


def safe_int(value, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except Exception:
        return default


def parse_iso_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_history_bundle() -> dict:
    if not HISTORY_INDEX_PATH.exists():
        return {"dates": [], "by_date": {}}

    index_data = load_json(HISTORY_INDEX_PATH)
    dates = index_data.get("dates", [])
    by_date = {}

    for d in dates:
        day_path = HISTORY_DIR / f"{d}.json"
        if not day_path.exists():
            continue
        by_date[d] = load_json(day_path) or {}

    return {
        "dates": dates,
        "by_date": by_date,
    }


def weighted_average(values: list[float], weights: list[float]) -> float:
    if not values or not weights or len(values) != len(weights):
        return 0.0
    total_weight = sum(weights)
    if total_weight <= 0:
        return 0.0
    return sum(v * w for v, w in zip(values, weights)) / total_weight


def linear_regression_slope(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0

    x_mean = (n - 1) / 2
    y_mean = sum(values) / n

    num = 0.0
    den = 0.0

    for i, y in enumerate(values):
        dx = i - x_mean
        dy = y - y_mean
        num += dx * dy
        den += dx * dx

    if den == 0:
        return 0.0

    return num / den


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def get_track_history_series(track_id: str, history_by_date: dict, dates: list[str]) -> list[dict]:
    series = []

    for d in dates:
        row = history_by_date.get(d, {}).get(track_id)
        if not row:
            continue

        streams = safe_int(row.get("streams"))
        daily_streams = row.get("daily_streams")

        if daily_streams in (None, ""):
            continue

        daily_streams = safe_int(daily_streams)

        if streams <= 0:
            continue

        # on ignore les daily <= 0 pour éviter les faux zéros
        if daily_streams <= 0:
            continue

        series.append(
            {
                "date": d,
                "streams": streams,
                "daily_streams": daily_streams,
            }
        )

    return series


def estimate_future_daily_streams(series: list[dict]) -> dict:
    if not series:
        return {
            "base_daily": 0,
            "trend_per_day": 0.0,
            "projected_next_daily": 0,
        }

    recent = series[-RECENT_WINDOW:]
    daily_values = [
        safe_float(row["daily_streams"])
        for row in recent
        if safe_float(row["daily_streams"]) > 0
    ]

    if not daily_values:
        return {
            "base_daily": 0,
            "trend_per_day": 0.0,
            "projected_next_daily": 0,
        }

    last_7 = daily_values[-7:] if len(daily_values) >= 7 else daily_values
    last_14 = daily_values[-14:] if len(daily_values) >= 14 else daily_values

    avg_7 = sum(last_7) / len(last_7)
    avg_14 = sum(last_14) / len(last_14)

    slope = linear_regression_slope(last_14)

    projected_next = avg_7 * 0.7 + avg_14 * 0.3 + slope * 1.5
    projected_next = max(1.0, projected_next)

    trend_per_day = clamp(slope, -avg_7 * 0.03, avg_7 * 0.03)

    return {
        "base_daily": int(round(avg_7)),
        "trend_per_day": trend_per_day,
        "projected_next_daily": int(round(projected_next)),
    }


def next_milestone(current_streams: int, milestones: list[int]) -> int | None:
    for milestone in milestones:
        if current_streams < milestone:
            return milestone
    return None


def project_milestone_date(
    current_streams: int,
    last_date: str,
    start_daily: int,
    trend_per_day: float,
    milestone: int,
) -> dict | None:
    if current_streams >= milestone:
        return None

    remaining = milestone - current_streams
    if remaining <= 0:
        return None

    current_date = parse_iso_date(last_date)
    projected_streams = float(current_streams)
    daily = float(max(start_daily, 0))

    if daily <= 0:
        return None

    for day_index in range(1, MAX_FORECAST_DAYS + 1):
        projected_streams += max(daily, 0)

        if projected_streams >= milestone:
            eta_date = current_date + timedelta(days=day_index)
            return {
                "expected_date": eta_date.isoformat(),
                "days_left": day_index,
                "projected_streams_on_hit": int(round(projected_streams)),
            }

        daily = max(0.0, daily + trend_per_day)

        if daily <= 1 and projected_streams < milestone:
            return None

    return None


def compute_progress(current_streams: int, target: int) -> dict:
    target = max(1, target)
    progress_ratio = clamp(current_streams / target, 0.0, 1.0)

    return {
        "previous_reference": 0,
        "target": target,
        "remaining": max(0, target - current_streams),
        "progress_ratio": progress_ratio,
        "progress_percent": round(progress_ratio * 100, 2),
    }


def build_forecasts() -> dict:
    songs_data = load_json(SONGS_PATH)
    history_data = load_history_bundle()

    songs = songs_data.get("songs", [])
    dates = history_data.get("dates", [])
    history_by_date = history_data.get("by_date", {})

    if not songs or not dates:
        return {
            "generated_at": datetime.now().isoformat(),
            "latest_history_date": None,
            "forecasts": [],
        }

    latest_history_date = dates[-1]
    forecasts = []

    for song in songs:
        track_id = song.get("track_id")
        if not track_id:
            continue

        series = get_track_history_series(track_id, history_by_date, dates)
        if not series:
            continue

        last_row = series[-1]
        current_streams = safe_int(last_row["streams"])
        if current_streams <= 0:
            continue

        next_target = next_milestone(current_streams, DEFAULT_MILESTONES)
        if next_target is None:
            continue

        projection_inputs = estimate_future_daily_streams(series)

        if len(series) < MIN_REQUIRED_HISTORY_POINTS:
            projected_daily = max(safe_int(last_row["daily_streams"]), 1)
            trend_per_day = 0.0
            base_daily = projected_daily
        else:
            projected_daily = max(projection_inputs["projected_next_daily"], 1)
            trend_per_day = projection_inputs["trend_per_day"]
            base_daily = max(projection_inputs["base_daily"], 1)

        projection = project_milestone_date(
            current_streams=current_streams,
            last_date=latest_history_date,
            start_daily=projected_daily,
            trend_per_day=trend_per_day,
            milestone=next_target,
        )

        progress = compute_progress(current_streams, next_target)

        forecasts.append(
            {
                "track_id": track_id,
                "title": song.get("title"),
                "title_clean": song.get("title_clean") or song.get("title"),
                "image_url": song.get("image_url"),
                "primary_album": song.get("primary_album"),
                "primary_artist": song.get("primary_artist"),
                "spotify_url": song.get("spotify_url"),
                "current_streams": current_streams,
                "latest_daily_streams": safe_int(last_row["daily_streams"]),
                "estimated_base_daily": base_daily,
                "estimated_next_daily": projected_daily,
                "estimated_trend_per_day": round(trend_per_day, 2),
                "next_milestone": next_target,
                "next_milestone_label": format_milestone_label(next_target),
                "progress": progress,
                "forecast": projection,
            }
        )

    sortable = []
    unsortable = []

    for item in forecasts:
        if item["forecast"] and item["forecast"].get("expected_date"):
            sortable.append(item)
        else:
            unsortable.append(item)

    sortable.sort(
        key=lambda x: (
            x["forecast"]["expected_date"],
            x["forecast"]["days_left"],
            -(x["current_streams"] or 0),
        )
    )

    unsortable.sort(
        key=lambda x: (
            -(x["progress"]["progress_percent"] or 0),
            -(x["current_streams"] or 0),
        )
    )

    return {
        "generated_at": datetime.now().isoformat(),
        "latest_history_date": latest_history_date,
        "forecasts": sortable + unsortable,
    }


def main() -> None:
    output = build_forecasts()
    OUTPUT_PATH.write_text(
        json.dumps(output, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Written: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()