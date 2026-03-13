from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE_DATA_DIR = ROOT / "site" / "data"

SONGS_PATH = SITE_DATA_DIR / "songs.json"
HISTORY_PATH = SITE_DATA_DIR / "history.json"
OUTPUT_PATH = SITE_DATA_DIR / "expected_milestones.json"

DEFAULT_MILESTONES = [
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


def safe_float(value, default=0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except Exception:
        return default


def safe_int(value, default=0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except Exception:
        return default


def parse_iso_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


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
        if streams <= 0 or daily_streams < 0:
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
    daily_values = [max(0, safe_float(row["daily_streams"])) for row in recent]

    if not daily_values:
        return {
            "base_daily": 0,
            "trend_per_day": 0.0,
            "projected_next_daily": 0,
        }

    weights = [i + 1 for i in range(len(daily_values))]
    recent_weighted_avg = weighted_average(daily_values, weights)

    shorter = daily_values[-7:] if len(daily_values) >= 7 else daily_values
    shortest = daily_values[-3:] if len(daily_values) >= 3 else daily_values

    avg_7 = sum(shorter) / len(shorter)
    avg_3 = sum(shortest) / len(shortest)

    slope = linear_regression_slope(daily_values)

    projected_next = (
        recent_weighted_avg * 0.55 +
        avg_7 * 0.25 +
        avg_3 * 0.20 +
        slope * 2.0
    )

    floor_bound = max(0.0, recent_weighted_avg * 0.55)
    ceil_bound = max(recent_weighted_avg * 1.8, avg_3 * 1.8, 1.0)

    projected_next = clamp(projected_next, floor_bound, ceil_bound)

    trend_per_day = clamp(slope * 0.35, -recent_weighted_avg * 0.025, recent_weighted_avg * 0.025)

    return {
        "base_daily": int(round(recent_weighted_avg)),
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
    previous_major = 0

    if target >= 1_000_000_000:
        step = 500_000_000 if target % 1_000_000_000 != 0 else 1_000_000_000

        if target == 1_500_000_000:
            previous_major = 1_000_000_000
        elif target == 2_500_000_000:
            previous_major = 2_000_000_000
        elif target == 3_500_000_000:
            previous_major = 3_000_000_000
        else:
            previous_major = target - step
    else:
        previous_major = max(0, target - 100_000_000)

    span = max(1, target - previous_major)
    raw_progress = (current_streams - previous_major) / span
    progress_ratio = clamp(raw_progress, 0.0, 1.0)

    return {
        "previous_reference": previous_major,
        "target": target,
        "remaining": max(0, target - current_streams),
        "progress_ratio": progress_ratio,
        "progress_percent": round(progress_ratio * 100, 2),
    }


def build_forecasts() -> dict:
    songs_data = load_json(SONGS_PATH)
    history_data = load_json(HISTORY_PATH)

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
            projected_daily = max(safe_int(last_row["daily_streams"]), 0)
            trend_per_day = 0.0
            base_daily = projected_daily
        else:
            projected_daily = projection_inputs["projected_next_daily"]
            trend_per_day = projection_inputs["trend_per_day"]
            base_daily = projection_inputs["base_daily"]

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
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Written: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()