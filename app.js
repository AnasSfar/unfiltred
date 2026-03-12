const state = {
  songs: [],
  albums: [],
  history: {},
  dates: [],
  selectedDate: null,
  sortMode: "daily",
  albumSortMode: "daily",
  page: document.body.dataset.page || "home",
  combineVersions: false,
  updateLogText: "",
  updateLogClass: "update-log",
  artist: null,
  themeMode: localStorage.getItem("site-theme-mode") || "light",
  themeImageUrl: null,
};

function formatFull(value) {
  if (value === null || value === undefined) return "N/A";
  return value.toLocaleString("en-US");
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

function enrichSongsForDate(date) {
  const previousDate = getPreviousDate(date);
  const rows = [];

  for (const song of state.songs) {
    const day = getDayData(song.track_id, date);
    const prevDay = previousDate ? getDayData(song.track_id, previousDate) : null;

    const streams = day?.streams ?? song.streams ?? null;
    const daily = day?.daily_streams ?? null;
    const previousStreams = prevDay?.streams ?? null;
    const totalChange =
      streams !== null && previousStreams !== null ? streams - previousStreams : null;

    rows.push({
      ...song,
      streams,
      daily_streams: daily,
      previous_streams: previousStreams,
      total_change: totalChange,
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
    const key = state.combineVersions
      ? song.song_family || song.track_id
      : song.track_id;

    rankMap.set(key, idx + 1);
  });

  return rankMap;
}

function combineSongVersions(rows) {
  const grouped = new Map();

  for (const song of rows) {
    const key = song.song_family || song.track_id;

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...song,
        combined_versions_count: 1,
      });
      continue;
    }

    const existing = grouped.get(key);

    const existingStreams = existing.streams || 0;
    const existingDaily = existing.daily_streams || 0;
    const existingPrevious = existing.previous_streams;
    const existingChange = existing.total_change;

    const currentStreams = song.streams || 0;
    const currentDaily = song.daily_streams || 0;
    const currentPrevious = song.previous_streams;
    const currentChange = song.total_change;

    const wasLeader = existingStreams >= currentStreams;

    existing.streams = existingStreams + currentStreams;
    existing.daily_streams = existingDaily + currentDaily;

    if (existingPrevious != null && currentPrevious != null) {
      existing.previous_streams = existingPrevious + currentPrevious;
    } else if (existingPrevious == null && currentPrevious != null) {
      existing.previous_streams = currentPrevious;
    }

    if (existingChange != null && currentChange != null) {
      existing.total_change = existingChange + currentChange;
    } else if (existingChange == null && currentChange != null) {
      existing.total_change = currentChange;
    }

    existing.combined_versions_count += 1;

    if (!wasLeader) {
      existing.track_id = song.track_id;
      existing.title = song.title;
      existing.title_clean = song.title_clean || existing.title_clean;
      existing.image_url = song.image_url || existing.image_url;
      existing.primary_album = song.primary_album || existing.primary_album;
      existing.primary_artist = song.primary_artist || existing.primary_artist;
      existing.artists = song.artists || existing.artists;
      existing.song_family = song.song_family || existing.song_family;
      existing.version_tag = song.version_tag || existing.version_tag;
    }
  }

  return [...grouped.values()];
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
          `Data refreshed • latest date: ${newLatestDate || "unknown"}`;
        state.updateLogClass = "update-log success";
      }

      if (state.themeMode === "cover") {
        await applyTheme("cover");
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
    const key = state.combineVersions
      ? song.song_family || song.track_id
      : song.track_id;

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
        title: song.title,
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
    .filter((song) => (song.song_family || song.track_id) === family)
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

function renderThemeSwitcher() {
  const currentLabel =
    state.themeMode === "dark"
      ? "Dark"
      : state.themeMode === "cover"
      ? "Cover"
      : "Light";

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
          Clair
        </button>
        <button
          type="button"
          class="theme-option ${state.themeMode === "dark" ? "active" : ""}"
          data-theme="dark"
        >
          Sombre
        </button>
        <button
          type="button"
          class="theme-option ${state.themeMode === "cover" ? "active" : ""}"
          data-theme="cover"
        >
          Cover
        </button>
      </div>
    </div>
  `;
}

function getLatestCoverImage() {
  const img = document.getElementById("latestCover");
  if (img && img.src) return img.src;
  return null;
}

function renderAmbientEffects() {
  return `
    <div class="ambient-layer" aria-hidden="true">
      <div class="glitter-field">
        ${Array.from({ length: 26 })
          .map(
            (_, i) => `
              <span
                class="glitter-particle"
                style="
                  --x:${(i * 37) % 100}%;
                  --y:${(i * 19 + 11) % 100}%;
                  --size:${2 + (i % 4)}px;
                  --delay:${(i % 7) * 0.6}s;
                  --dur:${4.8 + (i % 5) * 1.1}s;
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
    currentX += (mouseX - currentX) * 0.14;
    currentY += (mouseY - currentY) * 0.14;

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

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shiftRgb(r, g, b, amount) {
  return rgbToHex(
    clamp(r + amount, 0, 255),
    clamp(g + amount, 0, 255),
    clamp(b + amount, 0, 255)
  );
}

function pickTextColor(r, g, b) {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? "#101828" : "#f8fafc";
}

function extractThemeFromImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("No image URL"));
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (!ctx) {
          reject(new Error("Canvas context unavailable"));
          return;
        }

        const size = 48;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);

        const { data } = ctx.getImageData(0, 0, size, size);

        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let count = 0;

        let accentScore = -1;
        let accent = { r: 29, g: 185, b: 84 };

        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 120) continue;

          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          totalR += r;
          totalG += g;
          totalB += b;
          count += 1;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max - min;
          const brightness = (r + g + b) / 3;

          const score = sat + brightness * 0.15;

          if (score > accentScore && brightness > 45) {
            accentScore = score;
            accent = { r, g, b };
          }
        }

        if (!count) {
          reject(new Error("No pixels"));
          return;
        }

        const avgR = Math.round(totalR / count);
        const avgG = Math.round(totalG / count);
        const avgB = Math.round(totalB / count);

        const avgBrightness = (avgR + avgG + avgB) / 3;
        const isLightBase = avgBrightness >= 150;

        let bgR, bgG, bgB, surfaceR, surfaceG, surfaceB, surface2R, surface2G, surface2B, text, muted, line, hoverBorder, shadow, shadowSoft, shadowHover;

        if (isLightBase) {
          bgR = clamp(avgR + 22, 244, 252);
          bgG = clamp(avgG + 22, 244, 252);
          bgB = clamp(avgB + 22, 244, 252);

          surfaceR = clamp(avgR + 14, 248, 255);
          surfaceG = clamp(avgG + 14, 248, 255);
          surfaceB = clamp(avgB + 14, 248, 255);

          surface2R = clamp(avgR + 6, 240, 250);
          surface2G = clamp(avgG + 6, 240, 250);
          surface2B = clamp(avgB + 6, 240, 250);

          text = "#101828";
          muted = "#667085";
          line = "rgba(16,24,40,.08)";
          hoverBorder = "rgba(16,24,40,.14)";
          shadow = "0 8px 24px rgba(16,24,40,.07)";
          shadowSoft = "0 4px 14px rgba(16,24,40,.05)";
          shadowHover = "0 18px 42px rgba(16,24,40,.14)";
        } else {
          bgR = clamp(avgR - 34, 8, 28);
          bgG = clamp(avgG - 34, 8, 28);
          bgB = clamp(avgB - 34, 8, 28);

          surfaceR = clamp(avgR - 18, 16, 40);
          surfaceG = clamp(avgG - 18, 16, 40);
          surfaceB = clamp(avgB - 18, 16, 40);

          surface2R = clamp(avgR - 10, 22, 50);
          surface2G = clamp(avgG - 10, 22, 50);
          surface2B = clamp(avgB - 10, 22, 50);

          text = "#f8fafc";
          muted = "#98a2b3";
          line = "rgba(255,255,255,.10)";
          hoverBorder = "rgba(255,255,255,.16)";
          shadow = "0 8px 24px rgba(0,0,0,.34)";
          shadowSoft = "0 4px 14px rgba(0,0,0,.24)";
          shadowHover = "0 18px 42px rgba(0,0,0,.42)";
        }

        resolve({
          bg: rgbToHex(bgR, bgG, bgB),
          surface: rgbToHex(surfaceR, surfaceG, surfaceB),
          surface2: rgbToHex(surface2R, surface2G, surface2B),
          text,
          muted,
          line,
          accent: rgbToHex(accent.r, accent.g, accent.b),
          accent2: shiftRgb(accent.r, accent.g, accent.b, -24),
          hoverBorder,
          shadow,
          shadowSoft,
          shadowHover,
        });
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => reject(new Error("Image load failed"));
    img.src = url;
  });
}

function clearThemeVariables() {
  const root = document.documentElement.style;
  [
    "--bg",
    "--surface",
    "--surface-2",
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
  const root = document.documentElement.style;

  root.setProperty("--bg", "#0b1118");
  root.setProperty("--surface", "#101822");
  root.setProperty("--surface-2", "#17212d");
  root.setProperty("--text", "#f8fafc");
  root.setProperty("--muted", "#98a2b3");
  root.setProperty("--line", "rgba(255,255,255,.10)");
  root.setProperty("--accent", "#8b5cf6");
  root.setProperty("--accent-2", "#6d47d9");
  root.setProperty("--hover-border", "rgba(255,255,255,.18)");
  root.setProperty("--shadow", "0 8px 24px rgba(0,0,0,.34)");
  root.setProperty("--shadow-soft", "0 4px 14px rgba(0,0,0,.24)");
  root.setProperty("--shadow-hover", "0 18px 42px rgba(0,0,0,.42)");
}

async function applyCoverTheme() {
  document.body.dataset.theme = "cover";

  const imageUrl = state.themeImageUrl || getLatestCoverImage();
  state.themeImageUrl = imageUrl;

  if (!imageUrl) {
    applyDarkTheme();
    return;
  }

  try {
    const palette = await extractThemeFromImage(imageUrl);
    const root = document.documentElement.style;

    Object.entries(palette).forEach(([key, value]) => {
      root.setProperty(`--${key}`, value);
    });
  } catch (err) {
    console.error("Cover theme failed, fallback to dark:", err);
    applyDarkTheme();
  }
}

async function applyTheme(mode = state.themeMode) {
  state.themeMode = mode;
  localStorage.setItem("site-theme-mode", mode);

  if (mode === "dark") {
    applyDarkTheme();
  } else if (mode === "cover") {
    await applyCoverTheme();
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

  return `
    <div class="topbar">
      <div class="hero-left">
        <div class="artist-hero-card">
          <img
            class="artist-hero-photo"
            src="${artistImage}"
            alt="${artistName}"
          >

          <div class="artist-hero-content">
            <div class="artist-hero-name">${artistName}</div>

            <div class="artist-daily-big">
              +${formatFull(dailyStreams)}
            </div>

            <div class="artist-daily-label">Daily streams</div>

            <div class="artist-total-line">
              ${formatFull(totalStreams)} total streams
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
  `;
}

function getSelectedRows() {
  const rawRows = enrichSongsForDate(state.selectedDate);
  return state.combineVersions ? combineSongVersions(rawRows) : rawRows;
}

function getSelectedDailyStreams() {
  return getSelectedRows().reduce((sum, song) => sum + (song.daily_streams || 0), 0);
}

function getSelectedTotalStreams() {
  return getSelectedRows().reduce((sum, song) => sum + (song.streams || 0), 0);
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
        <div class="stat-value">${rows.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Combined streams</div>
        <div class="stat-value">${formatFull(totalCombined)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Songs with daily data</div>
        <div class="stat-value">${withDaily}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Milestones crossed that day</div>
        <div class="stat-value">${milestonesToday}</div>
      </div>
    </div>
  `;
}

function renderRankChange(change) {
  if (change === null || change === undefined) {
    return `<span class="delta neutral">—</span>`;
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
    return `<span class="delta neutral">—</span>`;
  }
  if (change > 0) {
    return `<span class="delta up">+${formatFull(change)}</span>`;
  }
  if (change < 0) {
    return `<span class="delta down">${formatFull(change)}</span>`;
  }
  return `<span class="delta neutral">0</span>`;
}

function songRow(song) {
  const goldClass = song.crossed_milestone_today ? " song-row-gold" : "";

  return `
    <tr>
      <td colspan="7" class="row-shell-cell">
        <article class="song-row-card${goldClass}">
          <div class="song-row-grid">
            <div class="col-rank">${song.current_rank ?? "—"}</div>

            <div class="col-rank-change">
              ${renderRankChange(song.rank_change)}
            </div>

            <div class="col-song">
              <a
                class="song-link"
                href="song.html?family=${encodeURIComponent(song.song_family || song.track_id)}"
              >
                <img class="row-cover" src="${song.image_url || ""}" alt="${song.title}">
                <div class="row-song-meta">
                  <div class="row-song-title">${song.title_clean || song.title}</div>
                  <div class="row-song-artist">${formatArtists(song)}</div>
                  ${
                    state.combineVersions && (song.combined_versions_count || 1) > 1
                      ? `<div class="row-song-artist">${song.combined_versions_count} versions combined</div>`
                      : ""
                  }
                </div>
              </a>
            </div>

            <div class="col-album">${song.primary_album || ""}</div>

            <div class="col-daily">${formatFull(song.daily_streams)}</div>

            <div class="col-total">${formatFull(song.streams)}</div>

            <div class="col-stream-change">
              ${renderStreamChange(song.total_change)}
              ${
                song.crossed_milestone_today_label
                  ? `<div class="milestone-chip gold">${song.crossed_milestone_today_label} crossed</div>`
                  : ""
              }
            </div>
          </div>
        </article>
      </td>
    </tr>
  `;
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
                  src="${item.image_url || ""}"
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
  const sorted = sortSongs(rowsWithRankChanges, state.sortMode);

  container.innerHTML = `
    ${renderNav()}
    ${renderTopbar()}
    ${renderStats(sorted)}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Main Ranking</h2>
          <p>
            ${state.selectedDate} • sorted by ${
              state.sortMode === "daily" ? "daily streams" : "total streams"
            }
          </p>
        </div>

        <div class="toolbar">
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
              <th>Album</th>
              <th>Daily</th>
              <th>Total</th>
              <th>Streams change</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((song) => songRow(song)).join("")}
          </tbody>
        </table>
      </div>
    </section>
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

function renderAlbums(container) {
  const cards = state.albums
    .map(
      (album) => `
        <a class="album-card" href="album.html?name=${encodeURIComponent(album.album)}">
          <img class="album-cover" src="${album.image_url || ""}" alt="${album.album}">
          <div class="album-body">
            <div class="album-title">${album.album}</div>
            <div class="album-sub">${album.track_count} songs</div>
            <div class="album-sub">
              ${album.kind === "misc" ? "Remixes, standalones, features" : "Main album page"}
            </div>
          </div>
        </a>
      `
    )
    .join("");

  container.innerHTML = `
    ${renderNav()}
    ${renderTopbar()}
    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Albums</h2>
          <p>Open an album to see tracks grouped by edition type</p>
        </div>
      </div>
      <div class="album-grid">${cards}</div>
    </section>
  `;
}

function sortAlbumSongs(rows, mode) {
  const copy = [...rows];

  if (mode === "total") {
    copy.sort(
      (a, b) => (b.streams || 0) - (a.streams || 0) || a.title.localeCompare(b.title)
    );
  } else {
    copy.sort(
      (a, b) =>
        (b.daily_streams || 0) - (a.daily_streams || 0) || a.title.localeCompare(b.title)
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
                      <img src="${song.image_url || ""}" alt="${song.title}">
                      <div>
                        <div><strong>${song.title}</strong></div>
                      </div>
                    </div>
                  </td>
                  <td>${formatFull(song.streams)}</td>
                  <td>${formatFull(song.daily_streams)}</td>
                  <td>${renderStreamChange(song.total_change)}</td>
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

function getSongMap(rows) {
  return new Map(rows.map((song) => [song.track_id, song]));
}

function getAlbumBlockSongs(album, rows, blockKey) {
  const songsById = getSongMap(rows);
  const block = (album.display_blocks || []).find((b) => b.key === blockKey);
  if (!block) return [];

  return block.track_ids.map((id) => songsById.get(id)).filter(Boolean);
}

function computeAlbumTotalsForDate(album, rows) {
  const songsById = getSongMap(rows);
  const albumSongs = (album.track_ids || [])
    .map((id) => songsById.get(id))
    .filter(Boolean);

  return {
    total_streams_sum: albumSongs.reduce((sum, song) => sum + (song.streams || 0), 0),
    daily_streams_sum: albumSongs.reduce((sum, song) => sum + (song.daily_streams || 0), 0),
    track_count: albumSongs.length,
  };
}

function renderAlbumBlock(title, rows, emptyText) {
  const sorted = sortAlbumSongs(uniqueByTrackId(rows), state.albumSortMode);

  return `
    <div class="subsection-head">
      <h3>${title}</h3>
    </div>
    ${albumTable(sorted, emptyText)}
  `;
}

function renderAlbumDetail(container) {
  const albumName = getQueryParam("name");
  const rows = enrichSongsForDate(state.selectedDate);
  const albumMeta = state.albums.find((a) => a.album === albumName);

  if (!albumMeta) {
    container.innerHTML = `
      ${renderNav()}
      ${renderTopbar()}
      <section class="section-card">
        <div class="empty">Album not found.</div>
      </section>
    `;
    return;
  }

  const totals = computeAlbumTotalsForDate(albumMeta, rows);
  const songsById = getSongMap(rows);

  const displayBlocks = sortDisplayBlocks(albumMeta.display_blocks || []).map((block) => {
    const songs = (block.track_ids || [])
      .map((id) => songsById.get(id))
      .filter(Boolean);

    return {
      ...block,
      songs: sortAlbumSongs(uniqueByTrackId(songs), state.albumSortMode),
    };
  });

  const cover =
    albumMeta.image_url ||
    displayBlocks.flatMap((b) => b.songs).find((s) => s.image_url)?.image_url ||
    "";

  container.innerHTML = `
    ${renderNav()}
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head album-hero-head">
        <div class="album-hero">
          <img class="album-cover-small" src="${cover}" alt="${albumName}">
          <div>
            <h2>${albumName}</h2>
            <p>
              ${totals.track_count} songs
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

function renderSongDetail(container) {
  const family = getQueryParam("family");

  if (!family) {
    container.innerHTML = `
      ${renderNav()}
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
      ${renderNav()}
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
    ${renderNav()}
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head album-hero-head">
        <div class="album-hero">
          <img
            class="album-cover-small"
            src="${leadSong.image_url || ""}"
            alt="${leadSong.title}"
          >
          <div>
            <h2>${leadSong.title_clean || leadSong.title}</h2>
            <p>
              ${formatArtists(leadSong)}
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
              <th>Artists</th>
              <th>Album</th>
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
                        <img src="${song.image_url || ""}" alt="${song.title}">
                        <div>
                          <div><strong>${song.title}</strong></div>
                          <div class="mini-song-sub">${song.version_tag || "standard"}</div>
                        </div>
                      </div>
                    </td>
                    <td>${formatArtists(song)}</td>
                    <td>${song.primary_album || "Unknown album"}</td>
                    <td>${song.edition || "—"}</td>
                    <td>${song.type || "—"}</td>
                    <td>${formatFull(song.daily_streams)}</td>
                    <td>${formatFull(song.streams)}</td>
                    <td>${renderStreamChange(song.total_change)}</td>
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
  const rows = enrichSongsForDate(state.selectedDate)
    .filter((r) => r.crossed_milestone_today)
    .sort((a, b) => (b.streams || 0) - (a.streams || 0));

  const withChanges = withRankChanges(rows, state.selectedDate, state.sortMode);

  container.innerHTML = `
    ${renderNav()}
    ${renderTopbar()}

    <section class="section-card">
      ${renderMilestoneHighlightsBox(state.selectedDate)}

      <div class="section-head">
        <div>
          <h2>Milestones crossed</h2>
          <p>Only songs that crossed a milestone on ${state.selectedDate}</p>
        </div>
      </div>

      ${
        withChanges.length
          ? `
            <div class="table-wrap ranking-wrap">
              <table class="table ranking-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Rank change</th>
                    <th>Song</th>
                    <th>Album</th>
                    <th>Daily</th>
                    <th>Total</th>
                    <th>Streams change</th>
                  </tr>
                </thead>
                <tbody>
                  ${withChanges.map((song) => songRow(song)).join("")}
                </tbody>
              </table>
            </div>
          `
          : `<div class="empty">No milestone crossed on this date.</div>`
      }
    </section>
  `;
}

function bindDateControls() {
  const input = document.getElementById("dateInput");
  const prevBtn = document.getElementById("prevDayBtn");
  const nextBtn = document.getElementById("nextDayBtn");

  if (!input) return;

  input.addEventListener("change", () => {
    state.selectedDate = input.value;
    renderPage();
  });

  prevBtn?.addEventListener("click", () => {
    const idx = state.dates.indexOf(state.selectedDate);
    if (idx > 0) {
      state.selectedDate = state.dates[idx - 1];
      renderPage();
    }
  });

  nextBtn?.addEventListener("click", () => {
    const idx = state.dates.indexOf(state.selectedDate);
    if (idx >= 0 && idx < state.dates.length - 1) {
      state.selectedDate = state.dates[idx + 1];
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
}

async function loadData() {
  const [songsData, albumsData, historyData, artistData] = await Promise.all([
    fetch("site/data/songs.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/albums.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/history.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("data/artist.json?ts=" + Date.now()).then((r) => r.json()).catch(() => null),
  ]);

  state.songs = songsData.songs || [];
  state.albums = albumsData.albums || [];
  state.history = historyData.by_date || {};
  state.dates = historyData.dates || [];
  state.selectedDate =
    historyData.summary?.latest_date || state.dates[state.dates.length - 1] || null;
  state.artist = artistData || null;
  state.themeImageUrl = getLatestCoverImage();
}

loadData().then(async () => {
  await applyTheme(state.themeMode);
  renderPage();
});