/* =========================
   DATA LOADING
========================= */

async function loadHistory(date) {
  if (!date || state.history[date]) return;

  const data = await fetchJSON(`site/history/${date}.json`);
  state.history[date] = data || {};
}

/* =========================
   COMBINE KEY
========================= */

function getCombineKey(song) {
  const explicit =
    song.song_family ||
    song.base_title ||
    song.title_key ||
    song.title_clean;

  if (explicit && String(explicit).trim()) {
    return String(explicit)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\(taylor'?s version\)/gi, "")
      .replace(/\(from the vault\)/gi, "")
      .replace(/\(([^)]*version[^)]*)\)/gi, "")
      .replace(/\[(.*?)\]/g, "")
      .replace(/\bfrom the vault\b/gi, "")
      .replace(/\btaylor'?s version\b/gi, "")
      .replace(/\b(feat|ft|featuring)\.?\s+.+$/gi, "")
      .replace(/\b(deluxe|standard|edition|bonus track|bonus|remix|acoustic|live|demo|karaoke|instrumental|radio edit)\b/gi, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return String(song.title || song.track_id || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(taylor'?s version\)/gi, "")
    .replace(/\(from the vault\)/gi, "")
    .replace(/\(([^)]*version[^)]*)\)/gi, "")
    .replace(/\[(.*?)\]/g, "")
    .replace(/\bfrom the vault\b/gi, "")
    .replace(/\btaylor'?s version\b/gi, "")
    .replace(/\b(feat|ft|featuring)\.?\s+.+$/gi, "")
    .replace(/\b(deluxe|standard|edition|bonus track|bonus|remix|acoustic|live|demo|karaoke|instrumental|radio edit)\b/gi, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


/* =========================
   ENRICH SONGS FOR DATE
========================= */

function enrichSongsForDate(date) {

  const prevDate = getPreviousDate(date);

  return state.songs.map(song => {

    const day = getDayData(song.track_id, date);
    const prev = prevDate ? getDayData(song.track_id, prevDate) : null;

    const streams = day?.streams ?? song.streams ?? null;
    const daily = day?.daily_streams ?? null;

    const prevStreams = prev?.streams ?? null;
    const prevDaily = prev?.daily_streams ?? null;

    const change =
      daily !== null && prevDaily !== null
        ? daily - prevDaily
        : null;

    const percent =
      daily !== null && prevDaily !== null && prevDaily !== 0
        ? ((daily - prevDaily) / prevDaily) * 100
        : null;

    return {
      ...song,

      streams,
      daily_streams: daily,

      previous_streams: prevStreams,
      previous_daily_streams: prevDaily,

      total_change: change,
      percent_change: percent,

      crossed_milestone_today:
        day?.crossed_milestone_today ?? null,

      crossed_milestone_today_label:
        day?.crossed_milestone_today_label ?? null
    };

  });

}


/* =========================
   SORT HELPERS
========================= */

function sortBy(rows, primary, secondary = "streams") {

  return [...rows].sort((a, b) =>
    (b[primary] || 0) - (a[primary] || 0) ||
    (b[secondary] || 0) - (a[secondary] || 0) ||
    a.title.localeCompare(b.title)
  );

}


function sortSongs(rows, mode = "streams") {

  if (mode === "daily") {
    return sortBy(rows, "daily_streams", "streams");
  }

  return sortBy(rows, "streams", "daily_streams");

}


/* =========================
   RANK MAP
========================= */

function computeRankMap(rows, mode) {

  const sorted = sortSongs(rows, mode);
  const map = new Map();

  sorted.forEach((song, i) => {

    const key = state.combineVersions
      ? getCombineKey(song)
      : song.track_id;

    map.set(key, i + 1);

  });

  return map;

}


/* =========================
   COMBINE SONG VERSIONS
========================= */

function combineSongVersions(rows) {

  const grouped = new Map();

  for (const song of rows) {

    const key = getCombineKey(song);

    if (!grouped.has(key)) {

      grouped.set(key, {
        ...song,
        song_family: key,
        combined_versions_count: 1
      });

      continue;
    }

    const existing = grouped.get(key);

    existing.streams =
      (existing.streams || 0) + (song.streams || 0);

    existing.daily_streams =
      (existing.daily_streams || 0) + (song.daily_streams || 0);

    existing.previous_streams =
      (existing.previous_streams || 0) + (song.previous_streams || 0);

    existing.previous_daily_streams =
      (existing.previous_daily_streams || 0) + (song.previous_daily_streams || 0);

    existing.total_change =
      (existing.total_change || 0) + (song.total_change || 0);

    existing.combined_versions_count++;

    if (
      (song.streams || 0) > (existing.streams || 0)
    ) {

      existing.track_id = song.track_id;
      existing.title = song.title;
      existing.title_clean = song.title_clean;

      existing.image_url = song.image_url;
      existing.primary_album = song.primary_album;

      existing.primary_artist = song.primary_artist;
      existing.artists = song.artists;

      existing.version_tag = song.version_tag;
      existing.edition = song.edition;
      existing.type = song.type;

      existing.spotify_url = song.spotify_url;

    }

    if (song.crossed_milestone_today) {

      existing.crossed_milestone_today = true;

      existing.crossed_milestone_today_label =
        song.crossed_milestone_today_label ||
        existing.crossed_milestone_today_label;

    }

  }

  return [...grouped.values()];

}


/* =========================
   RANK CHANGES
========================= */

function withRankChanges(rows, date, mode) {

  const prevDate = getPreviousDate(date);

  const currentRankMap = computeRankMap(rows, mode);

  let prevRankMap = new Map();

  if (prevDate) {

    const prevRowsRaw = enrichSongsForDate(prevDate);

    const prevRows =
      state.combineVersions
        ? combineSongVersions(prevRowsRaw)
        : prevRowsRaw;

    prevRankMap = computeRankMap(prevRows, mode);

  }

  return rows.map(song => {

    const key = state.combineVersions
      ? getCombineKey(song)
      : song.track_id;

    const currentRank = currentRankMap.get(key) ?? null;
    const prevRank = prevRankMap.get(key) ?? null;

    let change = null;

    if (currentRank !== null && prevRank !== null) {
      change = prevRank - currentRank;
    }

    return {
      ...song,
      current_rank: currentRank,
      previous_rank: prevRank,
      rank_change: change
    };

  });

}
