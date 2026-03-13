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
  albumCovers: {},
  themeMode: localStorage.getItem("site-theme-mode") || "light",
  themeImageUrl: null,
};

function formatFull(value) {
  if (value === null || value === undefined) return "N/A";
  return value.toLocaleString("en-US");
}

function normalizeAlbumName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

function getAlbumCover(album) {
  if (!album) return "";

  const albumName = normalizeAlbumName(album.album);

  for (const entry of Object.values(state.albumCovers || {})) {
    if (!entry || typeof entry !== "object") continue;

    const entryTitle = normalizeAlbumName(entry.title);
    if (entryTitle === albumName) {
      return entry.cover_url || album.image_url || "";
    }
  }

  return album.image_url || "";
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
  const selectors = [
    ".artist-hero-photo",
    ".album-cover-small",
    ".album-cover",
    ".row-cover",
    "#latestCover",
  ];

  for (const selector of selectors) {
    const img = document.querySelector(selector);
    if (img?.getAttribute("src")) {
      return img.getAttribute("src");
    }
  }

  return state.artist?.image_url || null;
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

        let bgR, bgG, bgB, surfaceR, surfaceG, surfaceB, surface2R, surface2G, surface2B;
        let text, muted, line, hoverBorder, shadow, shadowSoft, shadowHover;

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
    "--card-backdrop",
  ].forEach((prop) => root.removeProperty(prop));
}

function applyLightTheme() {
  document.body.dataset.theme = "light";
  clearThemeVariables();

  const root = document.documentElement.style;
  root.setProperty("--surface", "rgba(255,255,255,.72)");
  root.setProperty("--surface-2", "rgba(255,255,255,.48)");
  root.setProperty("--card-backdrop", "blur(18px) saturate(160%)");
}

function applyDarkTheme() {
  document.body.dataset.theme = "dark";
  const root = document.documentElement.style;

  root.setProperty("--bg", "#0b1118");
  root.setProperty("--surface", "rgba(16,24,34,.62)");
  root.setProperty("--surface-2", "rgba(23,33,45,.42)");
  root.setProperty("--text", "#f8fafc");
  root.setProperty("--muted", "#98a2b3");
  root.setProperty("--line", "rgba(255,255,255,.10)");
  root.setProperty("--accent", "#8b5cf6");
  root.setProperty("--accent-2", "#6d47d9");
  root.setProperty("--hover-border", "rgba(255,255,255,.18)");
  root.setProperty("--shadow", "0 8px 24px rgba(0,0,0,.34)");
  root.setProperty("--shadow-soft", "0 4px 14px rgba(0,0,0,.24)");
  root.setProperty("--shadow-hover", "0 18px 42px rgba(0,0,0,.42)");
  root.setProperty("--card-backdrop", "blur(18px) saturate(150%)");
}

async function applyCoverTheme() {
  document.body.dataset.theme = "cover";

  const rawImageUrl = getLatestCoverImage() || state.artist?.image_url || null;
  const imageUrl = withCacheBuster(rawImageUrl);
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

    root.setProperty("--surface", "rgba(255,255,255,.14)");
    root.setProperty("--surface-2", "rgba(255,255,255,.08)");
    root.setProperty("--line", "rgba(255,255,255,.14)");
    root.setProperty("--hover-border", "rgba(255,255,255,.22)");
    root.setProperty("--card-backdrop", "blur(22px) saturate(160%)");
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
      <div class="topbar-theme-slot">
        ${renderThemeSwitcher()}
      </div>

      <div class="hero-left">
        <div class="artist-hero-card">
          <img
            class="artist-hero-photo"
            src="${artistImage ? withCacheBuster(artistImage) : ""}"
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

    ${renderNav()}
  `;
}

function getSelectedRows() {
  const rawRows = enrichSongsForDate(state.selectedDate);
  return state.combineVersions ? combineSongVersions(rawRows) : rawRows;
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

function renderPercentChange(change) {
  if (change === null || change === undefined || Number.isNaN(change)) {
    return `<span class="delta neutral">—</span>`;
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
              <div class="song-main">
                <a
                  class="play-track-btn"
                  href="${spotifyUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open on Spotify"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5v14l11-7z"></path>
                  </svg>
                </a>

                <a
                  class="song-link"
                  href="song.html?family=${encodeURIComponent(getCombineKey(song))}"
                >
                  <img class="row-cover" src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
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
            </div>

            <div class="col-album">${song.primary_album || ""}</div>

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
  const sorted = sortSongs(rowsWithRankChanges, state.sortMode);

  container.innerHTML = `
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
                              <img class="row-cover" src="${getAlbumCover(album) ? withCacheBuster(getAlbumCover(album)) : ""}" alt="${album.album}">
                              <div class="row-song-meta">
                                <div class="row-song-title">${album.album}</div>
                                <div class="row-song-artist">Album page</div>
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
                            : ""
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
  getAlbumCover(albumMeta) ||
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
                        <img src="${song.image_url ? withCacheBuster(song.image_url) : ""}" alt="${song.title}">
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
  const rows = enrichSongsForDate(state.selectedDate)
    .filter((r) => r.crossed_milestone_today)
    .sort((a, b) => (b.streams || 0) - (a.streams || 0));

  const baseRows = state.combineVersions ? combineSongVersions(rows) : rows;
  const withChanges = withRankChanges(baseRows, state.selectedDate, state.sortMode);
  const sorted = sortSongs(withChanges, state.sortMode);

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

      ${
        sorted.length
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
                  ${sorted.map((song) => songRow(song)).join("")}
                </tbody>
              </table>
            </div>
          `
          : `<div class="empty">No milestone crossed on this date.</div>`
      }
    </section>
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

  if (state.themeMode === "cover") {
    requestAnimationFrame(() => {
      applyCoverTheme();
    });
  }
}

async function loadData() {
  const [songsData, albumsData, historyData, artistData, coversData] = await Promise.all([
    fetch("site/data/songs.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/albums.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/history.json?ts=" + Date.now()).then((r) => r.json()),
    fetch("site/data/artist.json?ts=" + Date.now()).then((r) => r.json()).catch(() => null),
    fetch("site/data/covers.json?ts=" + Date.now()).then((r) => r.json()).catch(() => ({})),
  ]);

  state.songs = songsData.songs || [];
  state.albums = albumsData.albums || [];
  state.history = historyData.by_date || {};
  state.dates = historyData.dates || [];
  state.artist = artistData || null;
  state.albumCovers = coversData || {};

  const storedDate = localStorage.getItem("site-selected-date");
  const latestDate = historyData.summary?.latest_date || state.dates[state.dates.length - 1] || null;

  if (storedDate && state.dates.includes(storedDate)) {
    state.selectedDate = storedDate;
  } else {
    state.selectedDate = latestDate;
    persistSelectedDate();
  }

  state.themeImageUrl = null;
}

loadData().then(async () => {
  await applyTheme(state.themeMode);
  renderPage();
});