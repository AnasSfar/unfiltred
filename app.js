const state = {
  songs: [],
  albums: [],
  history: {},
  dates: [],
  selectedDate: localStorage.getItem("site-selected-date") || null,
  sortMode: "daily",
  albumSortMode: "daily",
  albumsPageSortMode: "daily",
  page: document.body.dataset.page || "home",
  combineVersions: false,
  updateLogText: "",
  updateLogClass: "update-log",
  artist: null,
  themeMode: localStorage.getItem("site-theme-mode") || "light",
  searchQuery: "",
  focusFamily: null,
};

function formatFull(value) {
  if (value === null || value === undefined) return "N/A";
  return value.toLocaleString("en-US");
}

function persistSelectedDate() {
  if (state.selectedDate) {
    localStorage.setItem("site-selected-date", state.selectedDate);
  }
}

function withCacheBuster(url) {
  if (!url) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

function getDayData(trackId, date) {
  return state.history?.[date]?.[track_id_safe(trackId)] || state.history?.[date]?.[trackId] || null;
}

function track_id_safe(trackId) {
  return trackId;
}

function getPreviousDate(date) {
  const idx = state.dates.indexOf(date);
  if (idx > 0) return state.dates[idx - 1];
  return null;
}

function getNextDate(date) {
  const idx = state.dates.indexOf(date);
  if (idx >= 0 && idx < state.dates.length - 1) return state.dates[idx + 1];
  return null;
}

function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

function formatArtists(song) {
  if (Array.isArray(song.artists) && song.artists.length) {
    return song.artists.join(", ");
  }

  if (typeof song.primary_artist === "string" && song.primary_artist.trim()) {
    return song.primary_artist;
  }

  return "Unknown artist";
}

function formatArtistAlbum(song) {
  const artist = formatArtists(song);
  const album = song.primary_album || "Unknown album";
  return `${artist} / ${album}`;
}

function normalizeSearchValue(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  const abs = Math.abs(value);

  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function getCombineKey(song) {
  if (song.song_family && String(song.song_family).trim()) {
    return String(song.song_family).trim().toLowerCase();
  }

  if (song.base_title && String(song.base_title).trim()) {
    return String(song.base_title).trim().toLowerCase();
  }

  if (song.title_key && String(song.title_key).trim()) {
    return String(song.title_key).trim().toLowerCase();
  }

  if (song.title_clean && String(song.title_clean).trim()) {
    return String(song.title_clean).trim().toLowerCase();
  }

  if (song.title && String(song.title).trim()) {
    return String(song.title)
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s*\[[^\]]*\]\s*/g, " ")
      .replace(/\b(feat|featuring|ft)\.?\s+[^-–—,]+/g, " ")
      .replace(/\b(live|acoustic|remix|version|deluxe|karaoke|edit|demo|instrumental|radio edit|from the vault)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return song.track_id;
}

function enrichSongsForDate(date) {
  const previousDate = getPreviousDate(date);
  const rows = [];

  for (const song of state.songs) {
    const day = getDayData(song.track_id, date);
    const prevDay = previousDate ? getDayData(song.track_id, previousDate) : null;

    const streams = day?.streams ?? song.streams ?? null;
    const daily = day?.daily_streams ?? null;
    const previousStreams = prevDay?.streams ?? null;
    const previousDaily = prevDay?.daily_streams ?? null;

    const totalChange =
      daily !== null && previousDaily !== null
        ? daily - previousDaily
        : null;

    const percentChange =
      daily !== null &&
      previousDaily !== null &&
      previousDaily !== 0
        ? ((daily - previousDaily) / previousDaily) * 100
        : null;

    rows.push({
      ...song,
      streams,
      daily_streams: daily,
      previous_streams: previousStreams,
      previous_daily_streams: previousDaily,
      total_change: totalChange,
      percent_change: percentChange,
      crossed_milestone_today: day?.crossed_milestone_today ?? null,
      crossed_milestone_today_label: day?.crossed_milestone_today_label ?? null,
    });
  }

  return rows;
}

function sortSongs(rows, mode = "streams") {
  const copy = [...rows];

  if (mode === "daily") {
    copy.sort(
      (a, b) =>
        (b.daily_streams || 0) - (a.daily_streams || 0) ||
        (b.streams || 0) - (a.streams || 0) ||
        a.title.localeCompare(b.title)
    );
  } else {
    copy.sort(
      (a, b) =>
        (b.streams || 0) - (a.streams || 0) ||
        (b.daily_streams || 0) - (a.daily_streams || 0) ||
        a.title.localeCompare(b.title)
    );
  }

  return copy;
}

function computeRankMap(rows, mode) {
  const sorted = sortSongs(rows, mode);
  const rankMap = new Map();

  sorted.forEach((song, idx) => {
    const key = state.combineVersions ? getCombineKey(song) : song.track_id;
    rankMap.set(key, idx + 1);
  });

  return rankMap;
}

function combineSongVersions(rows) {
  const grouped = new Map();

  for (const song of rows) {
    const key = getCombineKey(song);

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...song,
        song_family: key,
        combined_versions_count: 1,
      });
      continue;
    }

    const existing = grouped.get(key);

    const existingStreams = existing.streams || 0;
    const existingDaily = existing.daily_streams || 0;
    const existingPreviousStreams = existing.previous_streams || 0;
    const existingPreviousDaily = existing.previous_daily_streams || 0;
    const existingChange = existing.total_change || 0;

    const currentStreams = song.streams || 0;
    const currentDaily = song.daily_streams || 0;
    const currentPreviousStreams = song.previous_streams || 0;
    const currentPreviousDaily = song.previous_daily_streams || 0;
    const currentChange = song.total_change || 0;

    const existingLeaderScore =
      (existing.streams || 0) * 1000000000 + (existing.daily_streams || 0);
    const currentLeaderScore =
      (song.streams || 0) * 1000000000 + (song.daily_streams || 0);

    existing.streams = existingStreams + currentStreams;
    existing.daily_streams = existingDaily + currentDaily;
    existing.previous_streams = existingPreviousStreams + currentPreviousStreams;
    existing.previous_daily_streams = existingPreviousDaily + currentPreviousDaily;
    existing.total_change = existingChange + currentChange;
    existing.combined_versions_count += 1;

    existing.percent_change =
      existing.previous_daily_streams && existing.previous_daily_streams !== 0
        ? (existing.total_change / existing.previous_daily_streams) * 100
        : null;

    if (currentLeaderScore > existingLeaderScore) {
      existing.track_id = song.track_id;
      existing.title = song.title;
      existing.title_clean = song.title_clean || existing.title_clean;
      existing.image_url = song.image_url || existing.image_url;
      existing.primary_album = song.primary_album || existing.primary_album;
      existing.primary_artist = song.primary_artist || existing.primary_artist;
      existing.artists = song.artists || existing.artists;
      existing.version_tag = song.version_tag || existing.version_tag;
      existing.edition = song.edition || existing.edition;
      existing.type = song.type || existing.type;
      existing.display_section = song.display_section || existing.display_section;
      existing.display_order = song.display_order ?? existing.display_order;
      existing.spotify_url = song.spotify_url || existing.spotify_url;
    }

    if (song.crossed_milestone_today) {
      existing.crossed_milestone_today = true;
      existing.crossed_milestone_today_label =
        song.crossed_milestone_today_label || existing.crossed_milestone_today_label;
    }
  }

  return [...grouped.values()];
}

function filterSongsByQuery(rows) {
  const q = normalizeSearchValue(state.searchQuery);
  if (!q) return rows;

  return rows.filter((song) => {
    const haystack = normalizeSearchValue([
      song.title,
      song.title_clean,
      song.primary_album,
      song.primary_artist,
      formatArtists(song),
      song.version_tag,
      song.edition,
      song.type,
    ].join(" "));

    return haystack.includes(q);
  });
}

function buildCopyStatsText() {
  const selected = state.selectedDate;
  const dailyStreams = state.songs.reduce(
    (sum, song) => sum + (getDayData(song.track_id, selected)?.daily_streams || 0),
    0
  );

  const totalStreams = state.songs.reduce(
    (sum, song) => sum + (getDayData(song.track_id, selected)?.streams || song.streams || 0),
    0
  );

  const monthlyListeners = state.artist?.monthly_listeners ?? null;
  const monthlyRank = state.artist?.monthly_rank ?? null;

  return [
    `${state.artist?.name || "Taylor Swift"} stats`,
    `${selected || ""}`,
    `+${formatFull(dailyStreams)} daily streams`,
    `${formatFull(totalStreams)} total streams`,
    monthlyListeners !== null ? `${formatFull(monthlyListeners)} monthly listeners` : null,
    monthlyRank !== null ? `Spotify rank #${monthlyRank}` : null,
  ].filter(Boolean).join("\n");
}

async function copyStats() {
  const text = buildCopyStatsText();

  try {
    await navigator.clipboard.writeText(text);
    state.updateLogText = "Stats copied.";
    state.updateLogClass = "update-log success";
  } catch (err) {
    state.updateLogText = "Copy failed.";
    state.updateLogClass = "update-log error";
  }

  renderPage();
}

function getFamilyTotalsForDate(family, date) {
  const rows = enrichSongsForDate(date).filter((song) => getCombineKey(song) === family);

  return {
    streams: rows.reduce((sum, song) => sum + (song.streams || 0), 0),
    daily_streams: rows.reduce((sum, song) => sum + (song.daily_streams || 0), 0),
  };
}

function getFamilySparklineData(family, length = 7) {
  const dates = state.dates.slice(-length);
  return dates.map((d) => ({
    date: d,
    value: getFamilyTotalsForDate(family, d).daily_streams || 0,
  }));
}

function renderSparkline(values) {
  if (!values.length) return "";

  const max = Math.max(...values.map((v) => v.value), 1);

  return `
    <div class="sparkline" aria-hidden="true">
      ${values
        .map((item) => {
          const h = Math.max(12, Math.round((item.value / max) * 42));
          return `<span class="sparkline-bar" title="${item.date}: ${formatFull(item.value)}" style="height:${h}px"></span>`;
        })
        .join("")}
    </div>
  `;
}

function bindUpdateButton() {
  const updateBtn = document.getElementById("updateBtn");

  if (!updateBtn) return;
  if (updateBtn.dataset.bound === "1") return;

  updateBtn.dataset.bound = "1";

  updateBtn.addEventListener("click", async () => {
    const previousLatestDate = state.dates[state.dates.length - 1] || null;
    const previousSongCount = state.songs.length;

    updateBtn.disabled = true;
    updateBtn.classList.add("loading");
    updateBtn.textContent = "Refreshing...";

    state.updateLogText = "Refreshing data...";
    state.updateLogClass = "update-log";
    renderPage();

    try {
      await loadData();

      const newLatestDate = state.dates[state.dates.length - 1] || null;
      const newSongCount = state.songs.length;

      if (
        previousLatestDate === newLatestDate &&
        previousSongCount === newSongCount
      ) {
        state.updateLogText =
          "No new update detected. Spotify usually refreshes around 15:00 Paris time.";
        state.updateLogClass = "update-log";
      } else {
        state.updateLogText =
          `Data refreshed - latest date: ${newLatestDate || "unknown"}`;
        state.updateLogClass = "update-log success";
      }

      renderPage();
    } catch (err) {
      console.error(err);
      state.updateLogText = "Refresh failed.";
      state.updateLogClass = "update-log error";
      renderPage();
    } finally {
      const freshBtn = document.getElementById("updateBtn");
      if (freshBtn) {
        freshBtn.disabled = false;
        freshBtn.classList.remove("loading");
        freshBtn.textContent = "Refresh data";
      }
    }
  });
}

function withRankChanges(rows, date, mode) {
  const previousDate = getPreviousDate(date);
  const currentRankMap = computeRankMap(rows, mode);

  let previousRankMap = new Map();

  if (previousDate) {
    const previousRawRows = enrichSongsForDate(previousDate);
    const previousRows = state.combineVersions
      ? combineSongVersions(previousRawRows)
      : previousRawRows;

    previousRankMap = computeRankMap(previousRows, mode);
  }

  return rows.map((song) => {
    const key = state.combineVersions ? getCombineKey(song) : song.track_id;

    const currentRank = currentRankMap.get(key) ?? null;
    const previousRank = previousRankMap.get(key) ?? null;

    let rankChange = null;
    if (currentRank !== null && previousRank !== null) {
      rankChange = previousRank - currentRank;
    }

    return {
      ...song,
      current_rank: currentRank,
      previous_rank: previousRank,
      rank_change: rankChange,
    };
  });
}

function normalizeMilestoneLabel(label) {
  if (!label) return null;

  return String(label)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/,/g, ".");
}

function getMajorMilestoneValue(label) {
  const normalized = normalizeMilestoneLabel(label);

  const allowed = {
    "900M": 900000000,
    "1B": 1000000000,
    "1.5B": 1500000000,
    "2B": 2000000000,
    "2.5B": 2500000000,
    "3B": 3000000000,
  };

  return allowed[normalized] ?? null;
}

function isMajorMilestoneLabel(label) {
  return getMajorMilestoneValue(label) !== null;
}

function getTaylorOrdinalForMilestone(targetValue, rows) {
  const eligibleCount = rows.filter((song) => (song.streams || 0) >= targetValue).length;
  return eligibleCount || null;
}

function formatOrdinal(n) {
  if (!n) return "";

  const mod10 = n % 10;
  const mod100 = n % 100;

  if (mod10 === 1 && mod100 !== 11) return `${n}st`;
  if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function getMajorMilestoneHighlights(date) {
  const rows = enrichSongsForDate(date);

  return rows
    .filter(
      (song) =>
        song.crossed_milestone_today &&
        isMajorMilestoneLabel(song.crossed_milestone_today_label)
    )
    .sort((a, b) => {
      const aValue = getMajorMilestoneValue(a.crossed_milestone_today_label) || 0;
      const bValue = getMajorMilestoneValue(b.crossed_milestone_today_label) || 0;
      return bValue - aValue || (b.streams || 0) - (a.streams || 0);
    })
    .map((song) => {
      const milestoneValue = getMajorMilestoneValue(song.crossed_milestone_today_label);
      const ordinal = getTaylorOrdinalForMilestone(milestoneValue, rows);

      return {
        track_id: song.track_id,
        title: song.title_clean || song.title,
        image_url: song.image_url,
        primary_album: song.primary_album,
        milestone_label: normalizeMilestoneLabel(song.crossed_milestone_today_label),
        milestone_value: milestoneValue,
        ordinal,
      };
    });
}

function getSongVersionsForFamily(family, date) {
  const rows = enrichSongsForDate(date);

  return rows
    .filter((song) => getCombineKey(song) === family)
    .sort(
      (a, b) =>
        (b.streams || 0) - (a.streams || 0) ||
        (b.daily_streams || 0) - (a.daily_streams || 0) ||
        a.title.localeCompare(b.title)
    );
}

function getSongFamilyTotals(rows) {
  return {
    total_streams: rows.reduce((sum, song) => sum + (song.streams || 0), 0),
    daily_streams: rows.reduce((sum, song) => sum + (song.daily_streams || 0), 0),
    versions_count: rows.length,
  };
}

function getLeadSongVersion(rows) {
  if (!rows.length) return null;

  return [...rows].sort(
    (a, b) =>
      (b.streams || 0) - (a.streams || 0) ||
      (b.daily_streams || 0) - (a.daily_streams || 0)
  )[0];
}

function getBiggestGainer(rows) {
  return [...rows]
    .filter((song) => song.total_change !== null && song.total_change !== undefined)
    .sort(
      (a, b) =>
        (b.total_change || 0) - (a.total_change || 0) ||
        (b.daily_streams || 0) - (a.daily_streams || 0)
    )[0] || null;
}

function getBiggestRankMover(rows) {
  return [...rows]
    .filter((song) => song.rank_change !== null && song.rank_change !== undefined)
    .sort(
      (a, b) =>
        (b.rank_change || 0) - (a.rank_change || 0) ||
        (b.daily_streams || 0) - (a.daily_streams || 0)
    )[0] || null;
}

function renderThemeSwitcher() {
  const currentLabel = state.themeMode === "dark" ? "Dark" : "Light";

  return `
    <div class="theme-switcher" id="themeSwitcher">
      <button id="themeToggleBtn" class="theme-toggle-btn" type="button" aria-label="Change theme">
        Theme · ${currentLabel}
      </button>

      <div class="theme-menu" id="themeMenu">
        <button
          type="button"
          class="theme-option ${state.themeMode === "light" ? "active" : ""}"
          data-theme="light"
        >
          Light
        </button>
        <button
          type="button"
          class="theme-option ${state.themeMode === "dark" ? "active" : ""}"
          data-theme="dark"
        >
          Dark
        </button>
      </div>
    </div>
  `;
}

function renderAmbientEffects() {
  return `
    <div class="ambient-layer" aria-hidden="true">
      <div class="glitter-field">
        ${Array.from({ length: 22 })
          .map(
            (_, i) => `
              <span
                class="glitter-particle"
                style="
                  --x:${(i * 37) % 100}%;
                  --y:${(i * 19 + 11) % 100}%;
                  --size:${2 + (i % 3)}px;
                  --delay:${(i % 7) * 0.8}s;
                  --dur:${7 + (i % 5) * 2.4}s;
                "
              ></span>
            `
          )
          .join("")}
      </div>

      <div class="cursor-glow" id="cursorGlow"></div>
    </div>
  `;
}

function bindCursorGlow() {
  const glow = document.getElementById("cursorGlow");
  if (!glow) return;
  if (glow.dataset.bound === "1") return;

  glow.dataset.bound = "1";

  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let currentX = mouseX;
  let currentY = mouseY;
  let rafId = null;

  function animate() {
    currentX += (mouseX - currentX) * 0.08;
    currentY += (mouseY - currentY) * 0.08;
    glow.style.transform = `translate(${currentX}px, ${currentY}px) translate(-50%, -50%)`;
    rafId = requestAnimationFrame(animate);
  }

  window.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    glow.classList.add("is-visible");

    if (!rafId) {
      rafId = requestAnimationFrame(animate);
    }
  });

  window.addEventListener("mouseleave", () => {
    glow.classList.remove("is-visible");
  });
}

function clearThemeVariables() {
  const root = document.documentElement.style;
  [
    "--bg",
    "--bg-2",
    "--surface",
    "--surface-2",
    "--surface-3",
    "--text",
    "--muted",
    "--line",
    "--accent",
    "--accent-2",
    "--hover-border",
    "--shadow",
    "--shadow-soft",
    "--shadow-hover",
  ].forEach((prop) => root.removeProperty(prop));
}

function applyLightTheme() {
  document.body.dataset.theme = "light";
  clearThemeVariables();
}

function applyDarkTheme() {
  document.body.dataset.theme = "dark";
}

async function applyTheme(mode = state.themeMode) {
  state.themeMode = mode;
  localStorage.setItem("site-theme-mode", mode);

  if (mode === "dark") {
    applyDarkTheme();
  } else {
    applyLightTheme();
  }
}

function bindThemeSwitcher() {
  const toggleBtn = document.getElementById("themeToggleBtn");
  const switcher = document.getElementById("themeSwitcher");
  const menu = document.getElementById("themeMenu");

  if (!toggleBtn || !switcher || !menu) return;
  if (switcher.dataset.bound === "1") return;

  switcher.dataset.bound = "1";

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switcher.classList.toggle("open");
  });

  menu.querySelectorAll(".theme-option").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.theme;
      switcher.classList.remove("open");
      await applyTheme(mode);
      renderPage();
    });
  });

  document.addEventListener("click", (e) => {
    if (!switcher.contains(e.target)) {
      switcher.classList.remove("open");
    }
  });
}

function renderNav() {
  return `
    <div class="nav-row">
      <nav class="nav">
        <a href="index.html" class="${state.page === "home" ? "active" : ""}">Top Songs</a>
        <a href="albums.html" class="${state.page === "albums" || state.page === "album" ? "active" : ""}">Albums</a>
        <a href="milestones.html" class="${state.page === "milestones" ? "active" : ""}">Milestones</a>
      </nav>

      ${renderThemeSwitcher()}
    </div>
  `;
}

function renderTopbar() {
  const latest = state.dates[state.dates.length - 1] || "";
  const selected = state.selectedDate || latest;

  let fullDateLabel = "";
  if (selected) {
    const d = new Date(`${selected}T12:00:00`);
    fullDateLabel = d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  const artistName = state.artist?.name || "Taylor Swift";
  const artistImage = state.artist?.image_url || "";
  const monthlyListeners = state.artist?.monthly_listeners ?? null;
  const monthlyRank = state.artist?.monthly_rank ?? null;

  const dailyStreams = state.songs.reduce(
    (sum, song) => sum + (getDayData(song.track_id, selected)?.daily_streams || 0),
    0
  );

  const totalStreams = state.songs.reduce(
    (sum, song) => sum + (getDayData(song.track_id, selected)?.streams || song.streams || 0),
    0
  );

  const updatedTracks = state.songs.filter(
    (song) => getDayData(song.track_id, selected)?.daily_streams !== null &&
      getDayData(song.track_id, selected)?.daily_streams !== undefined
  ).length;

  const sparklineData = state.dates.slice(-7).map((d) => ({
    date: d,
    value: state.songs.reduce(
      (sum, song) => sum + (getDayData(song.track_id, d)?.daily_streams || 0),
      0
    ),
  }));

  return `
    <div class="topbar">

      <div class="hero-left">
        <div class="artist-hero-card">
          ${
            artistImage
              ? `<img
                   class="artist-hero-photo"
                   src="${withCacheBuster(artistImage)}"
                   alt="${artistName}"
                 >`
              : `<div class="artist-hero-photo artist-hero-photo-placeholder">${artistName[0] || "T"}</div>`
          }

          <div class="artist-hero-content">
            <div class="artist-hero-name">${artistName}</div>

            <div class="artist-daily-highlight">
              <div class="artist-daily-big number-update">+${formatFull(dailyStreams)}</div>
              <div class="artist-daily-label">Daily streams</div>
              <div class="artist-total-line">
                ${formatFull(totalStreams)} total streams
              </div>
            </div>

            <div class="artist-monthly-box">
              <div class="artist-monthly-text">
                <div class="artist-monthly-label">Monthly listeners</div>
                <div class="artist-monthly-value">
                  ${monthlyListeners !== null ? formatFull(monthlyListeners) : "N/A"}
                </div>
              </div>

              <div class="artist-rank-badge">
                ${monthlyRank !== null ? `#${monthlyRank}` : "N/A"}
              </div>
            </div>

            <div class="quick-meta-row">
              <span class="quick-meta-chip">Updated tracks: ${updatedTracks}/${state.songs.length}</span>
              <span class="quick-meta-chip">Date: ${selected || "N/A"}</span>
              <button type="button" class="copy-stats-btn" id="copyStatsBtn">Copy stats</button>
            </div>

            ${renderSparkline(sparklineData)}
          </div>
        </div>
      </div>

      <div class="date-panel">
        <div class="date-full-label">${fullDateLabel}</div>

        <div class="date-controls">
          <button id="prevDayBtn">←</button>
          <input
            id="dateInput"
            type="date"
            value="${selected}"
            min="${state.dates[0] || ""}"
            max="${latest}"
          >
          <button id="nextDayBtn">→</button>
        </div>

        <button id="updateBtn" class="update-btn">Refresh data</button>
        <div class="${state.updateLogClass}">${state.updateLogText || ""}</div>
      </div>
    </div>

    ${renderNav()}
  `;
}

function renderStats(rows) {
  const totalCombined = rows.reduce((sum, r) => sum + (r.streams || 0), 0);
  const milestonesToday = rows.filter((r) => r.crossed_milestone_today).length;
  const withDaily = rows.filter(
    (r) => r.daily_streams !== null && r.daily_streams !== undefined
  ).length;

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Songs shown</div>
        <div class="stat-value number-update">${rows.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Combined streams</div>
        <div class="stat-value number-update">${formatFull(totalCombined)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Songs with daily data</div>
        <div class="stat-value number-update">${withDaily}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Milestones crossed that day</div>
        <div class="stat-value number-update">${milestonesToday}</div>
      </div>
    </div>
  `;
}

function renderRankChange(change) {
  if (change === null || change === undefined) {
    return `<span class="delta neutral">• 0</span>`;
  }
  if (change > 0) {
    return `<span class="delta up">↑ ${change}</span>`;
  }
  if (change < 0) {
    return `<span class="delta down">↓ ${Math.abs(change)}</span>`;
  }
  return `<span class="delta neutral">• 0</span>`;
}

function renderStreamChange(change) {
  if (change === null || change === undefined) {
    return `<span class="delta neutral">-</span>`;
  }
  if (change > 0) {
    return `<span class="delta up">+${formatFull(change)}</span>`;
  }
  if (change < 0) {
    return `<span class="delta down">${formatFull(change)}</span>`;
  }
  return `<span class="delta neutral">0</span>`;
}

function renderPercentChange(change) {
  if (change === null || change === undefined || Number.isNaN(change)) {
    return `<span class="delta neutral">-</span>`;
  }

  const rounded = Math.abs(change).toFixed(2);

  if (change > 0) {
    return `<span class="delta up">+${rounded}%</span>`;
  }

  if (change < 0) {
    return `<span class="delta down">-${rounded}%</span>`;
  }

  return `<span class="delta neutral">0.00%</span>`;
}

function songRow(song) {
  const goldClass = song.crossed_milestone_today ? " song-row-gold" : "";
  const spotifyUrl =
    song.spotify_url || (song.track_id ? `https://open.spotify.com/track/${song.track_id}` : "#");
  const family = getCombineKey(song);

  return `
    <tr>
      <td colspan="6" class="row-shell-cell">
        <article class="song-row-card${goldClass} js-song-focus" data-family="${encodeURIComponent(family)}">
          <div class="song-row-grid">
            <div class="col-rank">${song.current_rank ?? "-"}</div>

            <div class="col-rank-change">
              ${renderRankChange(song.rank_change)}
            </div>

            <div class="col-song">
              <div class="song-main">
                <a
                  class="play-track-btn"
                  href="${spotifyUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open on Spotify"
                  data-ignore-focus="1"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5v14l11-7z"></path>
                  </svg>
                </a>

                <a
                  class="song-link"
                  href="song.html?family=${encodeURIComponent(family)}"
                  data-ignore-focus="1"
                >
                  <img class="row-cover" src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
                  <div class="row-song-meta">
                    <div class="row-song-title">${song.title_clean || song.title}</div>
                    <div class="row-song-sub">${formatArtistAlbum(song)}</div>
                    ${
                      state.combineVersions && (song.combined_versions_count || 1) > 1
                        ? `<div class="row-song-sub">${song.combined_versions_count} versions combined</div>`
                        : ""
                    }
                  </div>
                </a>
              </div>
            </div>

            <div class="col-daily">${formatFull(song.daily_streams)}</div>

            <div class="col-total">${formatFull(song.streams)}</div>

            <div class="col-stream-change">
              <div>
                ${renderStreamChange(song.total_change)}
                <div class="sub-delta">
                  ${renderPercentChange(song.percent_change)}
                </div>
                ${
                  song.crossed_milestone_today_label
                    ? `<div class="milestone-chip gold">${song.crossed_milestone_today_label} crossed</div>`
                    : ""
                }
              </div>
            </div>
          </div>
        </article>
      </td>
    </tr>
  `;
}

function renderSearchBar(placeholder = "Search songs...") {
  return `
    <label class="toolbar-search">
      <span>🔎</span>
      <input
        id="searchInput"
        type="text"
        value="${state.searchQuery.replace(/"/g, "&quot;")}"
        placeholder="${placeholder}"
        autocomplete="off"
      >
    </label>
  `;
}

function renderNewsSection(rowsWithRankChanges, date) {
  const milestoneHighlights = getMajorMilestoneHighlights(date);
  const biggestGainer = getBiggestGainer(rowsWithRankChanges);
  const biggestRankMover = getBiggestRankMover(rowsWithRankChanges);

  const milestoneCard = milestoneHighlights.length
    ? `
      <div class="news-card blue">
        <div class="news-kicker">🏆 News</div>
        <div class="news-title">${milestoneHighlights.length} milestone${milestoneHighlights.length > 1 ? "s" : ""} crossed</div>
        <div class="news-sub">
          ${
            milestoneHighlights.length > 2
              ? `Several songs crossed milestones on ${date}. Full details are available on the milestones page.`
              : `Major milestone activity detected on ${date}.`
          }
        </div>
        ${milestoneHighlights
          .slice(0, 2)
          .map(
            (item) => `
              <div class="news-song">
                <img src="${item.image_url ? withCacheBuster(item.image_url) : ""}" alt="${item.title}">
                <div class="news-song-meta">
                  <div class="news-song-title">${item.title}</div>
                  <div class="news-song-sub">${item.milestone_label} • ${formatOrdinal(item.ordinal)}</div>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    `
    : `
      <div class="news-card blue">
        <div class="news-kicker">🏆 News</div>
        <div class="news-title">No major milestone today</div>
        <div class="news-sub">No 900M, 1B, 1.5B, 2B, 2.5B or 3B milestone was crossed on ${date}.</div>
      </div>
    `;

  const gainerCard = biggestGainer
    ? `
      <div class="news-card green">
        <div class="news-kicker">📈 Biggest gainer</div>
        <div class="news-title">${renderPlainSigned(biggestGainer.total_change)}</div>
        <div class="news-sub">Largest day-to-day streams change on ${date}.</div>
        <div class="news-song">
          <img src="${biggestGainer.image_url ? withCacheBuster(biggestGainer.image_url) : ""}" alt="${biggestGainer.title}">
          <div class="news-song-meta">
            <div class="news-song-title">${biggestGainer.title_clean || biggestGainer.title}</div>
            <div class="news-song-sub">${formatArtistAlbum(biggestGainer)}</div>
          </div>
        </div>
        <div class="news-badges">
          <span class="news-mini-badge ${biggestGainer.total_change >= 0 ? "green" : "red"}">${renderSignedCompact(biggestGainer.total_change)}</span>
          <span class="news-mini-badge ${biggestGainer.percent_change >= 0 ? "green" : "red"}">${formatPercentCompact(biggestGainer.percent_change)}</span>
        </div>
      </div>
    `
    : `
      <div class="news-card green">
        <div class="news-kicker">📈 Biggest gainer</div>
        <div class="news-title">No data</div>
        <div class="news-sub">Streams change is unavailable for this date.</div>
      </div>
    `;

  const rankCard = biggestRankMover
    ? `
      <div class="news-card purple">
        <div class="news-kicker">🔥 Best rank move</div>
        <div class="news-title">↑ ${biggestRankMover.rank_change}</div>
        <div class="news-sub">Strongest positive rank movement on ${date}.</div>
        <div class="news-song">
          <img src="${biggestRankMover.image_url ? withCacheBuster(biggestRankMover.image_url) : ""}" alt="${biggestRankMover.title}">
          <div class="news-song-meta">
            <div class="news-song-title">${biggestRankMover.title_clean || biggestRankMover.title}</div>
            <div class="news-song-sub">${formatArtistAlbum(biggestRankMover)}</div>
          </div>
        </div>
        <div class="news-badges">
          <span class="news-mini-badge green">Now #${biggestRankMover.current_rank ?? "-"}</span>
          <span class="news-mini-badge gold">Before #${biggestRankMover.previous_rank ?? "-"}</span>
        </div>
      </div>
    `
    : `
      <div class="news-card purple">
        <div class="news-kicker">🔥 Best rank move</div>
        <div class="news-title">No movement</div>
        <div class="news-sub">No comparable rank change is available for this date.</div>
      </div>
    `;

  return `
    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>News</h2>
          <p>Fast highlights for ${date}</p>
        </div>
      </div>

      <div class="news-grid">
        ${milestoneCard}
        ${gainerCard}
        ${rankCard}
      </div>
    </section>
  `;
}

function renderPlainSigned(value) {
  if (value === null || value === undefined) return "N/A";
  return value > 0 ? `+${formatFull(value)}` : formatFull(value);
}

function renderSignedCompact(value) {
  if (value === null || value === undefined) return "N/A";
  return value > 0 ? `+${formatFull(value)}` : formatFull(value);
}

function formatPercentCompact(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  return value > 0 ? `+${Math.abs(value).toFixed(2)}%` : `${value.toFixed(2)}%`;
}

function renderMilestoneHighlightsBox(date) {
  const highlights = getMajorMilestoneHighlights(date);

  if (!highlights.length) return "";

  return `
    <div class="milestone-highlight-box">
      <div class="milestone-highlight-head">
        <h3>Major milestone highlights</h3>
        <p>Only 900M, 1B, 1.5B, 2B, 2.5B and 3B are included.</p>
      </div>

      <div class="milestone-highlight-list">
        ${highlights
          .map(
            (item) => `
              <article class="milestone-highlight-item">
                <img
                  class="milestone-highlight-cover"
                  src="${item.image_url ? withCacheBuster(item.image_url) : ""}"
                  alt="${item.title}"
                >
                <div class="milestone-highlight-content">
                  <div class="milestone-highlight-title">${item.title}</div>
                  <div class="milestone-highlight-text">
                    surpassed <strong>${item.milestone_label}</strong> and became the
                    <strong>${formatOrdinal(item.ordinal)}</strong> Taylor Swift song to do so.
                  </div>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderHome(container) {
  const rawRows = enrichSongsForDate(state.selectedDate);
  const baseRows = state.combineVersions ? combineSongVersions(rawRows) : rawRows;
  const rowsWithRankChanges = withRankChanges(baseRows, state.selectedDate, state.sortMode);
  const filteredRows = filterSongsByQuery(rowsWithRankChanges);
  const sorted = sortSongs(filteredRows, state.sortMode);

  container.innerHTML = `
    ${renderTopbar()}
    ${renderNewsSection(rowsWithRankChanges, state.selectedDate)}
    ${renderStats(filteredRows)}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Main Ranking</h2>
          <p>
            ${state.selectedDate} • sorted by ${
              state.sortMode === "daily" ? "daily streams" : "total streams"
            } • ${filteredRows.length} result${filteredRows.length > 1 ? "s" : ""}
          </p>
        </div>

        <div class="toolbar">
          ${renderSearchBar()}
          <button
            id="sortStreamsBtn"
            class="${state.sortMode === "streams" ? "active" : ""}"
          >
            Total streams
          </button>
          <button
            id="sortDailyBtn"
            class="${state.sortMode === "daily" ? "active" : ""}"
          >
            Daily streams
          </button>
          <button
            id="combineBtn"
            class="${state.combineVersions ? "active" : ""}"
          >
            Combine
          </button>
        </div>
      </div>

      <div class="table-wrap ranking-wrap">
        <table class="table ranking-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Rank change</th>
              <th>Song</th>
              <th class="sortable" data-sort="daily">Daily</th>
              <th class="sortable" data-sort="streams">Total</th>
              <th>Streams change</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((song) => songRow(song)).join("")}
          </tbody>
        </table>
      </div>
    </section>

    ${renderFocusModal()}
  `;

  document.getElementById("sortStreamsBtn")?.addEventListener("click", () => {
    state.sortMode = "streams";
    renderPage();
  });

  document.getElementById("sortDailyBtn")?.addEventListener("click", () => {
    state.sortMode = "daily";
    renderPage();
  });

  document.getElementById("combineBtn")?.addEventListener("click", () => {
    state.combineVersions = !state.combineVersions;
    renderPage();
  });
}

function getSongMap(rows) {
  return new Map(rows.map((song) => [song.track_id, song]));
}

function computeAlbumTotalsForDate(album, rows, options = {}) {
  const songsById = getSongMap(rows);
  let albumSongs = (album.track_ids || [])
    .map((id) => songsById.get(id))
    .filter(Boolean);

  if (options.combineVersions) {
    albumSongs = combineSongVersions(albumSongs);
  }

  return {
    total_streams_sum: albumSongs.reduce((sum, song) => sum + (song.streams || 0), 0),
    daily_streams_sum: albumSongs.reduce((sum, song) => sum + (song.daily_streams || 0), 0),
    track_count: albumSongs.length,
  };
}

function sortAlbumsForPage(albums, rows) {
  const mapped = albums.map((album) => {
    const totals = computeAlbumTotalsForDate(album, rows, {
      combineVersions: state.combineVersions,
    });

    return {
      ...album,
      totals,
    };
  });

  return mapped.sort((a, b) => {
    if (state.albumsPageSortMode === "total") {
      return (
        (b.totals.total_streams_sum || 0) - (a.totals.total_streams_sum || 0) ||
        (b.totals.daily_streams_sum || 0) - (a.totals.daily_streams_sum || 0) ||
        a.album.localeCompare(b.album)
      );
    }

    return (
      (b.totals.daily_streams_sum || 0) - (a.totals.daily_streams_sum || 0) ||
      (b.totals.total_streams_sum || 0) - (a.totals.total_streams_sum || 0) ||
      a.album.localeCompare(b.album)
    );
  });
}

function renderAlbums(container) {
  const rows = enrichSongsForDate(state.selectedDate);

  const albums = sortAlbumsForPage(
    state.albums.filter((album) => album.kind !== "misc"),
    rows
  );

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Albums</h2>
          <p>
            Sorted by ${
              state.albumsPageSortMode === "daily" ? "daily streams" : "total streams"
            } for ${state.selectedDate}
          </p>
        </div>

        <div class="toolbar">
          <button
            id="albumsPageSortDailyBtn"
            class="${state.albumsPageSortMode === "daily" ? "active" : ""}"
          >
            Daily streams
          </button>
          <button
            id="albumsPageSortTotalBtn"
            class="${state.albumsPageSortMode === "total" ? "active" : ""}"
          >
            Total streams
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table ranking-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Album</th>
              <th>Tracks</th>
              <th>Daily</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${albums
              .map(
                (album, i) => `
                  <tr>
                    <td colspan="5" class="row-shell-cell">
                      <article class="song-row-card">
                        <div class="album-row-grid">
                          <div class="col-rank">${i + 1}</div>

                          <div class="col-song">
                            <a class="song-link" href="album.html?name=${encodeURIComponent(album.album)}">
                              <img class="row-cover" src="${album.image_url ? withCacheBuster(album.image_url) : ""}" alt="${album.album}">
                              <div class="row-song-meta">
                                <div class="row-song-title">${album.album}</div>
                                <div class="row-song-sub">Album page</div>
                              </div>
                            </a>
                          </div>

                          <div class="col-total">${album.totals.track_count}</div>
                          <div class="col-daily">${formatFull(album.totals.daily_streams_sum)}</div>
                          <div class="col-total">${formatFull(album.totals.total_streams_sum)}</div>
                        </div>
                      </article>
                    </td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;

  document.getElementById("albumsPageSortDailyBtn")?.addEventListener("click", () => {
    state.albumsPageSortMode = "daily";
    renderPage();
  });

  document.getElementById("albumsPageSortTotalBtn")?.addEventListener("click", () => {
    state.albumsPageSortMode = "total";
    renderPage();
  });
}

function sortAlbumSongs(rows, mode) {
  const copy = [...rows];

  if (mode === "total") {
    copy.sort(
      (a, b) =>
        (b.streams || 0) - (a.streams || 0) ||
        (b.daily_streams || 0) - (a.daily_streams || 0) ||
        a.title.localeCompare(b.title)
    );
  } else {
    copy.sort(
      (a, b) =>
        (b.daily_streams || 0) - (a.daily_streams || 0) ||
        (b.streams || 0) - (a.streams || 0) ||
        a.title.localeCompare(b.title)
    );
  }

  return copy;
}

function albumTable(rows, showEmptyText = "No songs in this section.") {
  if (!rows.length) {
    return `<div class="empty">${showEmptyText}</div>`;
  }

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Song</th>
            <th>Total streams</th>
            <th>Daily streams</th>
            <th>Streams change</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (song, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>
                    <div class="mini-song">
                      <img src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
                      <div>
                        <div><strong>${song.title_clean || song.title}</strong></div>
                        ${
                          state.combineVersions && (song.combined_versions_count || 1) > 1
                            ? `<div class="mini-song-sub">${song.combined_versions_count} versions combined</div>`
                            : song.version_tag
                            ? `<div class="mini-song-sub">${song.version_tag}</div>`
                            : `<div class="mini-song-sub">${formatArtistAlbum(song)}</div>`
                        }
                      </div>
                    </div>
                  </td>
                  <td>${formatFull(song.streams)}</td>
                  <td>${formatFull(song.daily_streams)}</td>
                  <td>
                    ${renderStreamChange(song.total_change)}
                    <div class="sub-delta">
                      ${renderPercentChange(song.percent_change)}
                    </div>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function uniqueByTrackId(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    if (!seen.has(row.track_id)) {
      seen.add(row.track_id);
      out.push(row);
    }
  }

  return out;
}

function renderAlbumBlock(title, rows, emptyText) {
  const preparedRows = state.combineVersions ? combineSongVersions(rows) : uniqueByTrackId(rows);
  const sorted = sortAlbumSongs(preparedRows, state.albumSortMode);

  return `
    <div class="subsection-head">
      <h3>${title}</h3>
    </div>
    ${albumTable(sorted, emptyText)}
  `;
}

function sortDisplayBlocks(blocks) {
  function normalize(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function getRank(block) {
    const key = normalize(block.key);
    const name = normalize(block.name);

    if (key === "standard" || name === "standard edition") return 0;
    if (key === "extras" || name === "extras") return 2;
    return 1;
  }

  return [...blocks].sort((a, b) => {
    const rankDiff = getRank(a) - getRank(b);
    if (rankDiff !== 0) return rankDiff;

    const aLabel = normalize(a.name || a.key);
    const bLabel = normalize(b.name || b.key);

    return aLabel.localeCompare(bLabel);
  });
}

function renderAlbumDetail(container) {
  const albumName = getQueryParam("name");
  const rows = enrichSongsForDate(state.selectedDate);
  const albumMeta = state.albums.find((a) => a.album === albumName);

  if (!albumMeta) {
    container.innerHTML = `
      ${renderTopbar()}
      <section class="section-card">
        <div class="empty">Album not found.</div>
      </section>
    `;
    return;
  }

  const totals = computeAlbumTotalsForDate(albumMeta, rows, {
    combineVersions: state.combineVersions,
  });
  const songsById = getSongMap(rows);

  const displayBlocks = sortDisplayBlocks(albumMeta.display_blocks || []).map((block) => {
    let songs = (block.track_ids || [])
      .map((id) => songsById.get(id))
      .filter(Boolean);

    if (state.combineVersions) {
      songs = combineSongVersions(songs);
    } else {
      songs = uniqueByTrackId(songs);
    }

    return {
      ...block,
      songs: sortAlbumSongs(songs, state.albumSortMode),
    };
  });

  const cover =
    albumMeta.image_url ||
    displayBlocks.flatMap((b) => b.songs).find((s) => s.image_url)?.image_url ||
    "";

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head album-hero-head">
        <div class="album-hero">
          <img class="album-cover-small" src="${cover ? withCacheBuster(cover) : ""}" alt="${albumName}">
          <div>
            <h2>${albumName}</h2>
            <p>
              ${totals.track_count} ${totals.track_count > 1 ? "entries" : "entry"}
              • ${formatFull(totals.total_streams_sum)} total streams
              • ${formatFull(totals.daily_streams_sum)} daily streams
              • sorted by ${
                state.albumSortMode === "daily" ? "daily streams" : "total streams"
              }
              for ${state.selectedDate}
            </p>
          </div>
        </div>

        <div class="toolbar">
          <button
            id="albumSortDailyBtn"
            class="${state.albumSortMode === "daily" ? "active" : ""}"
          >
            Daily streams
          </button>
          <button
            id="albumSortTotalBtn"
            class="${state.albumSortMode === "total" ? "active" : ""}"
          >
            Total streams
          </button>
          <button
            id="albumCombineBtn"
            class="${state.combineVersions ? "active" : ""}"
          >
            Combine
          </button>
        </div>
      </div>

      ${displayBlocks
        .map((block) => renderAlbumBlock(block.name, block.songs, `No songs in ${block.name}.`))
        .join("")}
    </section>
  `;

  document.getElementById("albumSortDailyBtn")?.addEventListener("click", () => {
    state.albumSortMode = "daily";
    renderPage();
  });

  document.getElementById("albumSortTotalBtn")?.addEventListener("click", () => {
    state.albumSortMode = "total";
    renderPage();
  });

  document.getElementById("albumCombineBtn")?.addEventListener("click", () => {
    state.combineVersions = !state.combineVersions;
    renderPage();
  });
}

function renderSongDetail(container) {
  const family = getQueryParam("family");

  if (!family) {
    container.innerHTML = `
      ${renderTopbar()}
      <section class="section-card">
        <div class="empty">Song not found.</div>
      </section>
    `;
    return;
  }

  const versions = getSongVersionsForFamily(family, state.selectedDate);

  if (!versions.length) {
    container.innerHTML = `
      ${renderTopbar()}
      <section class="section-card">
        <div class="empty">No versions found for this song.</div>
      </section>
    `;
    return;
  }

  const leadSong = getLeadSongVersion(versions);
  const totals = getSongFamilyTotals(versions);

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head album-hero-head">
        <div class="album-hero">
          <img
            class="album-cover-small"
            src="${leadSong.image_url ? withCacheBuster(leadSong.image_url) : ""}"
            alt="${leadSong.title}"
          >
          <div>
            <h2>${leadSong.title_clean || leadSong.title}</h2>
            <p>
              ${formatArtistAlbum(leadSong)}
              • ${totals.versions_count} version${totals.versions_count > 1 ? "s" : ""}
              • ${formatFull(totals.total_streams)} total streams combined
              • ${formatFull(totals.daily_streams)} daily streams combined
              • ${state.selectedDate}
            </p>
          </div>
        </div>
      </div>

      <div class="subsection-head">
        <h3>Versions</h3>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Version</th>
              <th>Artists / Album</th>
              <th>Edition</th>
              <th>Type</th>
              <th>Daily streams</th>
              <th>Total streams</th>
              <th>Streams change</th>
            </tr>
          </thead>
          <tbody>
            ${versions
              .map(
                (song, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td>
                      <div class="mini-song">
                        <img src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
                        <div>
                          <div><strong>${song.title}</strong></div>
                          <div class="mini-song-sub">${song.version_tag || "standard"}</div>
                        </div>
                      </div>
                    </td>
                    <td>${formatArtistAlbum(song)}</td>
                    <td>${song.edition || "-"}</td>
                    <td>${song.type || "-"}</td>
                    <td>${formatFull(song.daily_streams)}</td>
                    <td>${formatFull(song.streams)}</td>
                    <td>
                      ${renderStreamChange(song.total_change)}
                      <div class="sub-delta">
                        ${renderPercentChange(song.percent_change)}
                      </div>
                    </td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderMilestones(container) {
  const rawRows = enrichSongsForDate(state.selectedDate)
    .filter((r) => r.crossed_milestone_today)
    .sort((a, b) => (b.streams || 0) - (a.streams || 0));

  const baseRows = state.combineVersions ? combineSongVersions(rawRows) : rawRows;
  const withChanges = withRankChanges(baseRows, state.selectedDate, state.sortMode);
  const filtered = filterSongsByQuery(withChanges);
  const sorted = sortSongs(filtered, state.sortMode);

  if (sorted.length <= 2) {
    container.innerHTML = `
      ${renderTopbar()}
      ${renderNewsSection(withChanges, state.selectedDate)}
      <section class="section-card">
        <div class="section-head">
          <div>
            <h2>Milestones</h2>
            <p>There are only ${sorted.length} milestone${sorted.length > 1 ? "s" : ""} on this date, so the summary is shown in News.</p>
          </div>
        </div>
        ${
          sorted.length
            ? renderMilestoneHighlightsBox(state.selectedDate)
            : `<div class="empty">No milestone crossed on this date.</div>`
        }
      </section>
    `;
    return;
  }

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      ${renderMilestoneHighlightsBox(state.selectedDate)}

      <div class="section-head">
        <div>
          <h2>Milestones crossed</h2>
          <p>Only songs that crossed a milestone on ${state.selectedDate}</p>
        </div>

        <div class="toolbar">
          ${renderSearchBar("Search milestone songs...")}
          <button
            id="milestoneSortStreamsBtn"
            class="${state.sortMode === "streams" ? "active" : ""}"
          >
            Total streams
          </button>
          <button
            id="milestoneSortDailyBtn"
            class="${state.sortMode === "daily" ? "active" : ""}"
          >
            Daily streams
          </button>
          <button
            id="milestoneCombineBtn"
            class="${state.combineVersions ? "active" : ""}"
          >
            Combine
          </button>
        </div>
      </div>

      <div class="table-wrap ranking-wrap">
        <table class="table ranking-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Rank change</th>
              <th>Song</th>
              <th class="sortable" data-sort="daily">Daily</th>
              <th class="sortable" data-sort="streams">Total</th>
              <th>Streams change</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((song) => songRow(song)).join("")}
          </tbody>
        </table>
      </div>
    </section>

    ${renderFocusModal()}
  `;

  document.getElementById("milestoneSortStreamsBtn")?.addEventListener("click", () => {
    state.sortMode = "streams";
    renderPage();
  });

  document.getElementById("milestoneSortDailyBtn")?.addEventListener("click", () => {
    state.sortMode = "daily";
    renderPage();
  });

  document.getElementById("milestoneCombineBtn")?.addEventListener("click", () => {
    state.combineVersions = !state.combineVersions;
    renderPage();
  });
}

function renderFocusModal() {
  if (!state.focusFamily) return "";

  const versions = getSongVersionsForFamily(state.focusFamily, state.selectedDate);
  if (!versions.length) return "";

  const leadSong = getLeadSongVersion(versions);
  const totals = getSongFamilyTotals(versions);
  const sparkline = getFamilySparklineData(state.focusFamily, 7);

  return `
    <div class="focus-overlay" id="focusOverlay">
      <div class="focus-card">
        <div class="focus-head">
          <div class="album-hero">
            <img
              class="album-cover-small"
              src="${leadSong.image_url ? withCacheBuster(leadSong.image_url) : ""}"
              alt="${leadSong.title}"
            >
            <div>
              <h2>${leadSong.title_clean || leadSong.title}</h2>
              <p>
                ${formatArtistAlbum(leadSong)}
                • ${totals.versions_count} version${totals.versions_count > 1 ? "s" : ""}
                • ${formatFull(totals.total_streams)} total
                • ${formatFull(totals.daily_streams)} daily
              </p>
            </div>
          </div>

          <button type="button" class="focus-close" id="focusCloseBtn">✕</button>
        </div>

        <div class="subsection-head">
          <h3>Last 7 days daily trend</h3>
        </div>

        ${renderSparkline(sparkline)}

        <div class="subsection-head">
          <h3>Versions</h3>
        </div>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Version</th>
                <th>Artists / Album</th>
                <th>Daily</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${versions
                .map(
                  (song, i) => `
                    <tr>
                      <td>${i + 1}</td>
                      <td>
                        <div class="mini-song">
                          <img src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
                          <div>
                            <div><strong>${song.title}</strong></div>
                            <div class="mini-song-sub">${song.version_tag || "standard"}</div>
                          </div>
                        </div>
                      </td>
                      <td>${formatArtistAlbum(song)}</td>
                      <td>${formatFull(song.daily_streams)}</td>
                      <td>${formatFull(song.streams)}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function bindFocusCards() {
  document.querySelectorAll(".js-song-focus").forEach((card) => {
    if (card.dataset.bound === "1") return;
    card.dataset.bound = "1";

    card.addEventListener("click", (e) => {
      const ignored = e.target.closest("[data-ignore-focus='1']");
      if (ignored) return;

      const family = decodeURIComponent(card.dataset.family || "");
      if (!family) return;

      state.focusFamily = family;
      renderPage();
    });
  });

  document.getElementById("focusCloseBtn")?.addEventListener("click", () => {
    state.focusFamily = null;
    renderPage();
  });

  document.getElementById("focusOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "focusOverlay") {
      state.focusFamily = null;
      renderPage();
    }
  });
}

function bindSearchInput() {
  const input = document.getElementById("searchInput");
  if (!input) return;
  if (input.dataset.bound === "1") return;

  input.dataset.bound = "1";

  input.addEventListener("input", () => {
    state.searchQuery = input.value;
    renderPage();
  });
}

function bindCopyStatsButton() {
  const btn = document.getElementById("copyStatsBtn");
  if (!btn) return;
  if (btn.dataset.bound === "1") return;

  btn.dataset.bound = "1";
  btn.addEventListener("click", copyStats);
}

function bindSortableHeaders() {
  document.querySelectorAll("th.sortable[data-sort]").forEach((th) => {
    if (th.dataset.bound === "1") return;
    th.dataset.bound = "1";

    th.addEventListener("click", () => {
      const mode = th.dataset.sort;
      if (!mode) return;
      state.sortMode = mode;
      renderPage();
    });
  });
}

function bindDateControls() {
  const input = document.getElementById("dateInput");
  const prevBtn = document.getElementById("prevDayBtn");
  const nextBtn = document.getElementById("nextDayBtn");

  if (!input) return;

  input.addEventListener("change", () => {
    state.selectedDate = input.value;
    persistSelectedDate();
    renderPage();
  });

  prevBtn?.addEventListener("click", () => {
    const idx = state.dates.indexOf(state.selectedDate);
    if (idx > 0) {
      state.selectedDate = state.dates[idx - 1];
      persistSelectedDate();
      renderPage();
    }
  });

  nextBtn?.addEventListener("click", () => {
    const idx = state.dates.indexOf(state.selectedDate);
    if (idx >= 0 && idx < state.dates.length - 1) {
      state.selectedDate = state.dates[idx + 1];
      persistSelectedDate();
      renderPage();
    }
  });
}

function isTypingContext(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

function bindKeyboardShortcuts() {
  if (document.body.dataset.shortcutsBound === "1") return;
  document.body.dataset.shortcutsBound = "1";

  window.addEventListener("keydown", (e) => {
    if (isTypingContext(e.target)) return;

    if (e.key === "ArrowLeft") {
      const previous = getPreviousDate(state.selectedDate);
      if (previous) {
        state.selectedDate = previous;
        persistSelectedDate();
        renderPage();
      }
    }

    if (e.key === "ArrowRight") {
      const next = getNextDate(state.selectedDate);
      if (next) {
        state.selectedDate = next;
        persistSelectedDate();
        renderPage();
      }
    }

    if (e.key.toLowerCase() === "s") {
      const input = document.getElementById("searchInput");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }

    if (e.key === "Escape" && state.focusFamily) {
      state.focusFamily = null;
      renderPage();
    }
  });
}

function renderPage() {
  const app = document.getElementById("app");
  if (!app) return;

  if (state.page === "albums") {
    renderAlbums(app);
  } else if (state.page === "album") {
    renderAlbumDetail(app);
  } else if (state.page === "song") {
    renderSongDetail(app);
  } else if (state.page === "milestones") {
    renderMilestones(app);
  } else {
    renderHome(app);
  }

  if (!document.querySelector(".ambient-layer")) {
    document.body.insertAdjacentHTML("beforeend", renderAmbientEffects());
  }

  bindDateControls();
  bindUpdateButton();
  bindThemeSwitcher();
  bindCursorGlow();
  bindSearchInput();
  bindCopyStatsButton();
  bindSortableHeaders();
  bindFocusCards();
  bindKeyboardShortcuts();
}

async function loadData() {
  const [songsData, albumsData, historyData, artistData] = await Promise.all([
    fetch("site/data/songs.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/albums.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/history.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/artist.json?ts=" + Date.now()).then((r) => r.json()).catch(() => null),
  ]);

  state.songs = songsData.songs || [];
  state.albums = albumsData.albums || [];
  state.history = historyData.by_date || {};
  state.dates = historyData.dates || [];
  state.artist = artistData || null;

  const storedDate = localStorage.getItem("site-selected-date");
  const latestDate = historyData.summary?.latest_date || state.dates[state.dates.length - 1] || null;

  if (storedDate && state.dates.includes(storedDate)) {
    state.selectedDate = storedDate;
  } else {
    state.selectedDate = latestDate;
    persistSelectedDate();
  }
}

loadData().then(async () => {
  await applyTheme(state.themeMode);
  renderPage();
});