/* =========================
   STATE
========================= */

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
  albumCovers: {},

  expectedMilestones: []
};


/* =========================
   GENERIC HELPERS
========================= */

function normalizeAlbumName(name) {
  if (!name) return "";

  return name
    .toLowerCase()
    .replace(/\(taylor'?s version\)/gi, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getAlbumSectionPriority(sectionName) {
  if (!sectionName) return 50;

  const name = sectionName.toLowerCase();

  if (name.includes("standard")) return 0;
  if (name.includes("deluxe")) return 10;
  if (name.includes("edition")) return 20;
  if (name.includes("bonus")) return 80;
  if (name.includes("extra")) return 90;
  if (name.includes("vault")) return 70;

  return 40;
}

function getAlbumCover(album) {
  if (!album) return "";

  const targetTitle = String(album.album || "").trim().toLowerCase();
  if (!targetTitle) return album.image_url || "";

  for (const value of Object.values(state.albumCovers || {})) {
    if (!value) continue;

    const title = String(value.title || "").trim().toLowerCase();
    if (title === targetTitle) {
      return value.cover_url || album.image_url || "";
    }
  }

  return album.image_url || "";
}

function renderFocusModal() {
  return "";
}

async function fetchJSON(url) {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}ts=${Date.now()}`);
  if (!r.ok) throw new Error(`Failed to fetch ${url}`);
  return r.json();
}

const normalize = v =>
  String(v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();


function formatFull(v) {
  if (v === null || v === undefined) return "N/A";
  return v.toLocaleString("en-US");
}

function formatSigned(v) {
  if (v === null || v === undefined) return "N/A";
  return v > 0 ? `+${formatFull(v)}` : formatFull(v);
}

function formatPercent(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}


function withCacheBuster(url) {
  if (!url || typeof url !== "string") return "";

  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

function persistSelectedDate() {
  if (state.selectedDate) {
    localStorage.setItem("site-selected-date", state.selectedDate);
  }
}


function getQueryParam(name) {
  return new URL(window.location.href).searchParams.get(name);
}


/* =========================
   DATE HELPERS
========================= */

function getPreviousDate(date) {
  const i = state.dates.indexOf(date);
  return i > 0 ? state.dates[i - 1] : null;
}

function getNextDate(date) {
  const i = state.dates.indexOf(date);
  return i >= 0 && i < state.dates.length - 1
    ? state.dates[i + 1]
    : null;
}


/* =========================
   HISTORY ACCESS
========================= */

function getDayData(trackId, date){
  return state.history?.[date]?.[trackId] || null;
}


/* =========================
   ARTIST FORMATTING
========================= */

function formatArtists(song) {
  if (Array.isArray(song.artists) && song.artists.length) {
    return song.artists.join(", ");
  }

  if (song.primary_artist) {
    return song.primary_artist;
  }

  return "Unknown artist";
}

function formatArtistAlbum(song) {
  return `${formatArtists(song)} / ${song.primary_album || "Unknown album"}`;
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

    if (
      key.includes("standard") ||
      name.includes("standard")
    ) return 0;

    if (
      key.includes("extra") ||
      name.includes("extra")
    ) return 99;

    return 10;
  }

  return [...blocks].sort((a, b) => {
    const rankDiff = getRank(a) - getRank(b);
    if (rankDiff !== 0) return rankDiff;

    const aLabel = normalize(a.name || a.key);
    const bLabel = normalize(b.name || b.key);

    return aLabel.localeCompare(bLabel);
  });
}

/* =========================
   SEARCH NORMALIZATION
========================= */

function filterSongsByQuery(rows) {
  const q = normalize(state.searchQuery);
  if (!q) return rows;

  return rows.filter(song =>
    normalize([
      song.title,
      song.title_clean,
      song.primary_album,
      song.primary_artist,
      formatArtists(song),
      song.version_tag,
      song.edition,
      song.type
    ].join(" ")).includes(q)
  );
}


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
/* =========================
   THEME
========================= */

function clearThemeVariables() {
  const root = document.documentElement.style;

  [
    "--bg","--bg-2","--surface","--surface-2","--surface-3",
    "--text","--muted","--line","--accent","--accent-2",
    "--hover-border","--shadow","--shadow-soft","--shadow-hover"
  ].forEach(p => root.removeProperty(p));
}

function applyLightTheme(){
  document.body.dataset.theme = "light";
  clearThemeVariables();
}

function applyDarkTheme(){
  document.body.dataset.theme = "dark";
}

async function applyTheme(mode = state.themeMode){

  state.themeMode = mode;
  localStorage.setItem("site-theme-mode", mode);

  mode === "dark"
    ? applyDarkTheme()
    : applyLightTheme();

}


/* =========================
   THEME SWITCHER UI
========================= */

function renderThemeSwitcher(){

  const label = state.themeMode === "dark" ? "Dark" : "Light";

  return `
  <div class="theme-switcher" id="themeSwitcher">

    <button
      id="themeToggleBtn"
      class="theme-toggle-btn"
      type="button"
    >
      Theme · ${label}
    </button>

    <div class="theme-menu" id="themeMenu">

      <button
        class="theme-option ${state.themeMode==="light"?"active":""}"
        data-theme="light"
      >
        Light
      </button>

      <button
        class="theme-option ${state.themeMode==="dark"?"active":""}"
        data-theme="dark"
      >
        Dark
      </button>

    </div>

  </div>
  `;
}


function bindThemeSwitcher(){

  const toggle = document.getElementById("themeToggleBtn");
  const switcher = document.getElementById("themeSwitcher");
  const menu = document.getElementById("themeMenu");

  if(!toggle || !switcher || !menu) return;
  if(switcher.dataset.bound==="1") return;

  switcher.dataset.bound="1";

  toggle.onclick = e=>{
    e.stopPropagation();
    switcher.classList.toggle("open");
  };

  menu.querySelectorAll(".theme-option").forEach(btn=>{
    btn.onclick = async ()=>{
      switcher.classList.remove("open");
      await applyTheme(btn.dataset.theme);
      renderPage();
    };
  });

  document.onclick = e=>{
    if(!switcher.contains(e.target)){
      switcher.classList.remove("open");
    }
  };

}


/* =========================
   NAVIGATION
========================= */

function renderNav(){

  return `
  <div class="nav-row">

    <nav class="nav">

      <a href="index.html"
        class="${state.page==="home"?"active":""}">
        Top Songs
      </a>

      <a href="albums.html"
        class="${state.page==="albums"||state.page==="album"?"active":""}">
        Albums
      </a>

      <a href="milestones.html"
        class="${state.page==="milestones"?"active":""}">
        Milestones
      </a>

    </nav>

    ${renderThemeSwitcher()}

  </div>
  `;

}


/* =========================
   SPARKLINE
========================= */

function renderSparkline(values){

  if(!values.length) return "";

  const max = Math.max(...values.map(v=>v.value),1);

  return `
  <div class="sparkline">
    ${
      values.map(v=>{
        const h = Math.max(12,Math.round((v.value/max)*42));
        return `<span class="sparkline-bar"
          style="height:${h}px"
          title="${v.date}: ${formatFull(v.value)}">
        </span>`;
      }).join("")
    }
  </div>
  `;

}


/* =========================
   AMBIENT EFFECTS
========================= */

function renderAmbientEffects(){

  return `
  <div class="ambient-layer">

    <div class="glitter-field">

      ${
        Array.from({length:22}).map((_,i)=>`

          <span class="glitter-particle"
            style="
              --x:${(i*37)%100}%;
              --y:${(i*19+11)%100}%;
              --size:${2+(i%3)}px;
              --delay:${(i%7)*0.8}s;
              --dur:${7+(i%5)*2.4}s;
            ">
          </span>

        `).join("")
      }

    </div>

    <div class="cursor-glow" id="cursorGlow"></div>

  </div>
  `;
}


function bindCursorGlow(){

  const glow = document.getElementById("cursorGlow");
  if(!glow || glow.dataset.bound==="1") return;

  glow.dataset.bound="1";

  let mx=window.innerWidth/2;
  let my=window.innerHeight/2;
  let cx=mx, cy=my;

  function animate(){

    cx += (mx-cx)*0.08;
    cy += (my-cy)*0.08;

    glow.style.transform =
      `translate(${cx}px,${cy}px) translate(-50%,-50%)`;

    requestAnimationFrame(animate);

  }

  window.onmousemove = e=>{
    mx=e.clientX;
    my=e.clientY;
    glow.classList.add("is-visible");
  };

  window.onmouseleave = ()=>{
    glow.classList.remove("is-visible");
  };

  animate();

}


/* =========================
   TOPBAR
========================= */

function renderTopbar(){

  const latest = state.dates[state.dates.length-1]||"";
  const selected = state.selectedDate || latest;

  const artist = state.artist?.name || "Taylor Swift";
  const artistImg = state.artist?.image_url || "";

  const monthlyListeners = state.artist?.monthly_listeners ?? null;
  const monthlyRank = state.artist?.monthly_rank ?? null;

  const dailyStreams = state.songs.reduce(
    (s,x)=>s+(getDayData(x.track_id,selected)?.daily_streams||0),
    0
  );

  const totalStreams = state.songs.reduce(
    (s,x)=>s+(getDayData(x.track_id,selected)?.streams||x.streams||0),
    0
  );

  const updatedTracks = state.songs.filter(
    s=>getDayData(s.track_id,selected)?.daily_streams!=null
  ).length;

  const sparklineData = state.dates.slice(-7).map(d=>({
    date:d,
    value: state.songs.reduce(
      (s,x)=>s+(getDayData(x.track_id,d)?.daily_streams||0),
      0
    )
  }));

  return `
  <div class="topbar">

    <div class="hero-left">

      <div class="artist-hero-card">

        ${
          artistImg
          ? `<img class="artist-hero-photo"
               src="${withCacheBuster(artistImg)}">`
          : `<div class="artist-hero-photo artist-hero-photo-placeholder">${artist[0]}</div>`
        }

        <div class="artist-hero-content">

          <div class="artist-hero-name">${artist}</div>

          <div class="artist-daily-highlight">

            <div class="artist-daily-big number-update">
              +${formatFull(dailyStreams)}
            </div>

            <div class="artist-daily-label">
              Daily streams
            </div>

            <div class="artist-total-line">
              ${formatFull(totalStreams)} total streams
            </div>

          </div>

          <div class="artist-monthly-box">

            <div class="artist-monthly-text">

              <div class="artist-monthly-label">
                Monthly listeners
              </div>

              <div class="artist-monthly-value">
                ${monthlyListeners!==null?formatFull(monthlyListeners):"N/A"}
              </div>

            </div>

            <div class="artist-rank-badge">
              ${monthlyRank!==null?`#${monthlyRank}`:"N/A"}
            </div>

          </div>

          <div class="quick-meta-row">

            <span class="quick-meta-chip">
              Updated tracks: ${updatedTracks}/${state.songs.length}
            </span>

            <span class="quick-meta-chip">
              Date: ${selected||"N/A"}
            </span>

          </div>

          ${renderSparkline(sparklineData)}

        </div>

      </div>

    </div>

    <div class="date-panel">

      <div class="date-controls">

        <button id="prevDayBtn">←</button>

        <input
          id="dateInput"
          type="date"
          value="${selected}"
          min="${state.dates[0]||""}"
          max="${latest}"
        >

        <button id="nextDayBtn">→</button>

      </div>

      <button id="updateBtn" class="update-btn">
        Refresh data
      </button>

      <div class="${state.updateLogClass}">
        ${state.updateLogText||""}
      </div>

    </div>

  </div>

  ${renderNav()}
  `;

}
/* =========================
   SEARCH BAR
========================= */

function renderSearchBar(placeholder="Search songs..."){
  return `
  <label class="toolbar-search">
    <span>🔎</span>
    <input
      id="searchInput"
      type="text"
      value="${state.searchQuery.replace(/"/g,"&quot;")}"
      placeholder="${placeholder}"
      autocomplete="off"
    >
  </label>
  `;
}


/* =========================
   DELTA RENDERERS
========================= */

function renderRankChange(change){

  if(change==null) return `<span class="delta neutral">• 0</span>`;
  if(change>0) return `<span class="delta up">↑ ${change}</span>`;
  if(change<0) return `<span class="delta down">↓ ${Math.abs(change)}</span>`;

  return `<span class="delta neutral">• 0</span>`;
}


function renderStreamChange(change){

  if(change==null) return `<span class="delta neutral">-</span>`;
  if(change>0) return `<span class="delta up">+${formatFull(change)}</span>`;
  if(change<0) return `<span class="delta down">${formatFull(change)}</span>`;

  return `<span class="delta neutral">0</span>`;
}


function renderPercentChange(change){

  if(change==null || Number.isNaN(change))
    return `<span class="delta neutral">-</span>`;

  const v = Math.abs(change).toFixed(2);

  if(change>0) return `<span class="delta up">+${v}%</span>`;
  if(change<0) return `<span class="delta down">-${v}%</span>`;

  return `<span class="delta neutral">0.00%</span>`;
}


/* =========================
   SONG ROW
========================= */

function songRow(song){

  const gold = song.crossed_milestone_today ? " song-row-gold":"";

  const spotify =
    song.spotify_url ||
    (song.track_id
      ? `https://open.spotify.com/track/${song.track_id}`
      : "#");

  const family = getCombineKey(song);

  return `
  <tr>

    <td colspan="6" class="row-shell-cell">

      <article
        class="song-row-card${gold} js-song-focus"
        data-family="${encodeURIComponent(family)}"
      >

        <div class="song-row-grid">

          <div class="col-rank">
            ${song.current_rank ?? "-"}
          </div>

          <div class="col-rank-change">
            ${renderRankChange(song.rank_change)}
          </div>

          <div class="col-song">

            <div class="song-main">

              <a
                class="play-track-btn"
                href="${spotify}"
                target="_blank"
                rel="noopener noreferrer"
                data-ignore-focus="1"
              >
                ▶
              </a>

              <a
                class="song-link"
                href="song.html?family=${encodeURIComponent(family)}"
                data-ignore-focus="1"
              >

                <img
                  class="row-cover"
                  src="${song.image_url ? withCacheBuster(song.image_url) : ""}"
                  alt="${song.title}"
                >

                <div class="row-song-meta">

                  <div class="row-song-title">
                    ${song.title_clean || song.title}
                  </div>
                  <div class="row-song-sub">
                    ${formatArtistAlbum(song)}
                  </div>

                  ${
                    state.combineVersions &&
                    (song.combined_versions_count||1)>1
                      ? `<div class="row-song-sub">
                          ${song.combined_versions_count} versions combined
                        </div>`
                      : ""
                  }

                </div>

              </a>

            </div>

          </div>

          <div class="col-daily">
            ${formatFull(song.daily_streams)}
          </div>

          <div class="col-total">
            ${formatFull(song.streams)}
          </div>

          <div class="col-stream-change">

            ${renderStreamChange(song.total_change)}

            <div class="sub-delta">
              ${renderPercentChange(song.percent_change)}
            </div>

            ${
              song.crossed_milestone_today_label
                ? `<div class="milestone-chip gold">
                    ${song.crossed_milestone_today_label} crossed
                  </div>`
                : ""
            }

          </div>

        </div>

      </article>

    </td>

  </tr>
  `;

}


/* =========================
   STATS BLOCK
========================= */

function renderStats(rows){

  const totalCombined =
    rows.reduce((s,r)=>s+(r.streams||0),0);

  const milestonesToday =
    rows.filter(r=>r.crossed_milestone_today).length;

  const withDaily =
    rows.filter(r=>r.daily_streams!=null).length;

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


/* =========================
   NEWS SECTION
========================= */

function renderNewsSection(rows,date){

  const gainer =
    [...rows]
    .filter(s=>s.total_change!=null)
    .sort((a,b)=>(b.total_change||0)-(a.total_change||0))[0];

  const mover =
    [...rows]
    .filter(s=>s.rank_change!=null)
    .sort((a,b)=>(b.rank_change||0)-(a.rank_change||0))[0];

  return `
  <section class="section-card">

    <div class="section-head">
      <div>
        <h2>News</h2>
        <p>Highlights for ${date}</p>
      </div>
    </div>

    <div class="news-grid">

      ${
        gainer
        ? `
        <div class="news-card green">

          <div class="news-kicker">📈 Biggest gainer</div>

          <div class="news-title">
            ${formatSigned(gainer.total_change)}
          </div>

          <div class="news-song">

            <img src="${withCacheBuster(gainer.image_url)}">

            <div class="news-song-meta">
              <div class="news-song-title">
                ${gainer.title_clean||gainer.title}
              </div>
              <div class="news-song-sub">
                ${formatArtistAlbum(gainer)}
              </div>
            </div>

          </div>

        </div>`
        : ""
      }

      ${
        mover
        ? `
        <div class="news-card purple">

          <div class="news-kicker">🔥 Best rank move</div>

          <div class="news-title">
            ↑ ${mover.rank_change}
          </div>

          <div class="news-song">

            <img src="${withCacheBuster(mover.image_url)}">

            <div class="news-song-meta">
              <div class="news-song-title">
                ${mover.title_clean||mover.title}
              </div>
              <div class="news-song-sub">
                ${formatArtistAlbum(mover)}
              </div>
            </div>

          </div>

        </div>`
        : ""
      }

    </div>

  </section>
  `;

}


/* =========================
   HOME PAGE
========================= */

function renderHome(container){

  const raw = enrichSongsForDate(state.selectedDate);

  const base =
    state.combineVersions
      ? combineSongVersions(raw)
      : raw;

  const ranked =
    withRankChanges(base,state.selectedDate,state.sortMode);

  const filtered = filterSongsByQuery(ranked);
  const sorted = sortSongs(filtered,state.sortMode);
  const streamsActive = state.albumSortMode === "streams" ? "active" : "";
  const dailyActive = state.albumSortMode === "daily" ? "active" : "";
  const combineActive = state.combineVersions ? "active" : "";
  container.innerHTML = `
    ${renderTopbar()}
    ${renderNewsSection(ranked,state.selectedDate)}

    <section class="section-card">

      <div class="section-head">

        <div>
          <h2>Main Ranking</h2>
          <p>
            ${state.selectedDate} • sorted by
            ${state.sortMode==="daily"?"daily streams":"total streams"}
            • ${filtered.length} result${filtered.length>1?"s":""}
          </p>
        </div>

        <div class="toolbar">

          ${renderSearchBar()}

          <button
            id="sortStreamsBtn"
            class="${state.sortMode==="streams"?"active":""}">
            Total streams
          </button>

          <button
            id="sortDailyBtn"
            class="${state.sortMode==="daily"?"active":""}">
            Daily streams
          </button>

          <button
            id="combineBtn"
            class="${state.combineVersions?"active":""}">
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
            ${sorted.map(songRow).join("")}
          </tbody>

        </table>

      </div>

    </section>

    ${renderFocusModal()}
  `;

 const sortStreamsBtn = document.getElementById("sortStreamsBtn");
if (sortStreamsBtn) {
  sortStreamsBtn.onclick = () => {
    state.sortMode = "streams";
    renderPage();
  };
}

const sortDailyBtn = document.getElementById("sortDailyBtn");
if (sortDailyBtn) {
  sortDailyBtn.onclick = () => {
    state.sortMode = "daily";
    renderPage();
  };
}

const combineBtn = document.getElementById("combineBtn");
if (combineBtn) {
  combineBtn.onclick = () => {
    state.combineVersions = !state.combineVersions;
    renderPage();
  };
}

}
/* =========================
   ALBUM CARD
========================= */
async function loadData() {
  const [
    songsData,
    albumsData,
    artistData,
    expectedMilestonesData,
    albumCoversData
  ] = await Promise.all([
    fetchJSON("site/data/songs.json"),
    fetchJSON("site/data/albums.json"),
    fetchJSON("site/data/artist.json").catch(() => null),
    fetchJSON("site/data/expected_milestones.json").catch(() => null),
    fetchJSON("discography/albums/covers.json").catch(() => ({}))
  ]);

  state.songs = songsData.songs || [];
  state.albums = albumsData.albums || [];
  state.artist = artistData || null;
  state.expectedMilestones = expectedMilestonesData?.forecasts || [];
  state.albumCovers = albumCoversData || {};

  state.history = {};

  let allDates = songsData.dates || expectedMilestonesData?.dates || [];

  if (!allDates.length) {
    const r = await fetchJSON("site/history/index.json");
    allDates = r.dates || [];
  }

  state.dates = allDates;

  const storedDate = localStorage.getItem("site-selected-date");
  const latestDate = state.dates[state.dates.length - 1] || null;

  if (storedDate && state.dates.includes(storedDate)) {
    state.selectedDate = storedDate;
  } else {
    state.selectedDate = latestDate;
    persistSelectedDate();
  }

  if (state.selectedDate) {
    await loadHistory(state.selectedDate);
  }
}

function albumRow(album){

  const url = `album.html?album=${encodeURIComponent(album.album)}`;

  const daily = album.daily_streams ?? 0;
  const total = album.streams ?? 0;
  const change = album.stream_change ?? null;

  return `
  <tr>

    <td colspan="5" class="row-shell-cell">

      <article class="song-row-card">

        <div class="album-row-grid">

          <div class="col-rank">
            ${album.rank ?? "-"}
          </div>

          <div class="col-song">

            <a class="song-link" href="${url}">

              <img
                class="album-cover-small"
                src="${withCacheBuster(getAlbumCover(album))}"
                alt="${album.album}"
              >

              <div class="row-song-meta">

                <div class="row-song-title">
                  ${album.album}
                </div>

                <div class="row-song-sub">
                  ${album.primary_artist || "Taylor Swift"}
                </div>

              </div>

            </a>

          </div>

          <div class="col-daily">
            ${formatFull(daily)}
          </div>

          <div class="col-total">
            ${formatFull(total)}
          </div>

          <div class="col-stream-change">
            ${renderStreamChange(change)}
          </div>

        </div>

      </article>

    </td>

  </tr>
  `;
}


/* =========================
   ALBUMS PAGE
========================= */

function renderAlbums(container) {
  const rowsForDate = enrichSongsForDate(state.selectedDate);

  const validAlbums = state.albums.filter(album => {
    const name = String(album.album || "").trim().toLowerCase();
    const kind = String(album.kind || "").trim().toLowerCase();
    return name !== "misc" && kind !== "misc";
  });

  const albumGroups = new Map();

  for (const album of validAlbums) {
    const key = state.combineVersions
      ? normalizeAlbumName(album.album)
      : String(album.album || "");

    if (!albumGroups.has(key)) {
      albumGroups.set(key, {
        key,
        label: album.album,
        representative: album,
      });
    } else {
      const existing = albumGroups.get(key);

      const existingName = String(existing.representative.album || "");
      const currentName = String(album.album || "");

      if (
        /\(taylor'?s version\)/i.test(existingName) &&
        !/\(taylor'?s version\)/i.test(currentName)
      ) {
        existing.label = album.album;
        existing.representative = album;
      }
    }
  }

  const albums = [...albumGroups.values()].map(group => {
    const albumSongs = rowsForDate.filter(song => {
      const songAlbum = String(song.primary_album || "");
      return state.combineVersions
        ? normalizeAlbumName(songAlbum) === group.key
        : songAlbum === group.label;
    });

    return {
      ...group.representative,
      album: group.label,
      daily_streams: albumSongs.reduce((sum, song) => sum + (song.daily_streams || 0), 0),
      streams: albumSongs.reduce((sum, song) => sum + (song.streams || 0), 0),
      stream_change: albumSongs.reduce((sum, song) => sum + (song.total_change || 0), 0),
      track_count: albumSongs.length,
    };
  });

  const sorted =
    state.albumSortMode === "daily"
      ? [...albums].sort((a, b) =>
          (b.daily_streams || 0) - (a.daily_streams || 0) ||
          (b.streams || 0) - (a.streams || 0) ||
          a.album.localeCompare(b.album)
        )
      : [...albums].sort((a, b) =>
          (b.streams || 0) - (a.streams || 0) ||
          (b.daily_streams || 0) - (a.daily_streams || 0) ||
          a.album.localeCompare(b.album)
        );

  sorted.forEach((album, i) => {
    album.rank = i + 1;
  });

  const streamsActive = state.albumSortMode === "streams" ? "active" : "";
  const dailyActive = state.albumSortMode === "daily" ? "active" : "";
  const combineActive = state.combineVersions ? "active" : "";

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Albums</h2>
          <p>${sorted.length} album${sorted.length > 1 ? "s" : ""}</p>
        </div>

        <div class="toolbar">
          <button id="sortAlbumStreamsBtn" class="${streamsActive}">
            Total streams
          </button>

          <button id="sortAlbumDailyBtn" class="${dailyActive}">
            Daily streams
          </button>

          <button id="albumsCombineBtn" class="${combineActive}">
            Combine
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Album</th>
              <th>Daily</th>
              <th>Total</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(albumRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;

  const sortAlbumStreamsBtn = document.getElementById("sortAlbumStreamsBtn");
  if (sortAlbumStreamsBtn) {
    sortAlbumStreamsBtn.onclick = () => {
      state.albumSortMode = "streams";
      renderPage();
    };
  }

  const sortAlbumDailyBtn = document.getElementById("sortAlbumDailyBtn");
  if (sortAlbumDailyBtn) {
    sortAlbumDailyBtn.onclick = () => {
      state.albumSortMode = "daily";
      renderPage();
    };
  }

  const albumsCombineBtn = document.getElementById("albumsCombineBtn");
  if (albumsCombineBtn) {
    albumsCombineBtn.onclick = () => {
      state.combineVersions = !state.combineVersions;
      renderPage();
    };
  }
}


/* =========================
   ALBUM DETAIL PAGE
========================= */

function renderAlbumPage(container) {
  const albumName = getQueryParam("album");
  const album = state.albums.find(a => a.album === albumName);

  if (!album) {
    container.innerHTML = `
      ${renderTopbar()}
      <div class="section-card empty">Album not found</div>
    `;
    return;
  }

  const rowsForDate = enrichSongsForDate(state.selectedDate);

  const albumSongs = rowsForDate.filter(song =>
    (song.appearances || []).some(app => app.album === albumName)
  );

  const groups = new Map();

for (const song of albumSongs) {
  const appearance =
    (song.appearances || []).find(app => app.album === albumName) || null;

  const sectionName = appearance?.display_section || "Other";
  const songOrder = appearance?.display_order ?? 9999;

  if (!groups.has(sectionName)) {
    groups.set(sectionName, {
      name: sectionName,
      firstSongOrder: songOrder,
      songs: []
    });
  }

  const group = groups.get(sectionName);
  group.firstSongOrder = Math.min(group.firstSongOrder, songOrder);
  group.songs.push(song);
}

let blocks = [...groups.values()]
  .sort((a, b) => {
    const pa = getAlbumSectionPriority(a.name);
    const pb = getAlbumSectionPriority(b.name);

    if (pa !== pb) return pa - pb;

    return a.firstSongOrder - b.firstSongOrder || a.name.localeCompare(b.name);
  })
  .map(block => {
      let songs = [...block.songs];

      if (state.combineVersions) {
        songs = combineSongVersions(songs);
      }

      songs.sort((a, b) =>
        state.albumSortMode === "daily"
          ? ((b.daily_streams || 0) - (a.daily_streams || 0)) ||
            ((b.streams || 0) - (a.streams || 0)) ||
            a.title.localeCompare(b.title)
          : ((b.streams || 0) - (a.streams || 0)) ||
            ((b.daily_streams || 0) - (a.daily_streams || 0)) ||
            a.title.localeCompare(b.title)
      );

      return { ...block, songs };
    });

  const totalStreams = blocks.reduce(
    (sum, block) => sum + block.songs.reduce((s, song) => s + (song.streams || 0), 0),
    0
  );

  const totalDaily = blocks.reduce(
    (sum, block) => sum + block.songs.reduce((s, song) => s + (song.daily_streams || 0), 0),
    0
  );

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head album-hero-head">
        <div class="album-hero">
          <img
            class="album-cover-small"
            src="${withCacheBuster(getAlbumCover(album))}"
            alt="${album.album}"
          >

          <div>
            <h2>${album.album}</h2>
            <div class="mini-song-sub">${album.primary_artist || "Taylor Swift"}</div>
            <div class="mini-song-sub">
              ${formatFull(totalStreams)} total streams • ${formatFull(totalDaily)} daily streams
            </div>
          </div>
        </div>

        <div class="toolbar">
          <button
            id="albumSortStreamsBtn"
            class="${state.albumSortMode === "streams" ? "active" : ""}">
            Total streams
          </button>

          <button
            id="albumSortDailyBtn"
            class="${state.albumSortMode === "daily" ? "active" : ""}">
            Daily streams
          </button>

          <button
            id="albumCombineBtn"
            class="${state.combineVersions ? "active" : ""}">
            Combine
          </button>
        </div>
      </div>

      ${blocks.map(block => `
        <div class="subsection-head">
          <h3>${block.name}</h3>
        </div>

        ${
          block.songs.length
            ? `
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Song</th>
                      <th>Daily</th>
                      <th>Total</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${block.songs.map((song, i) => `
                      <tr>
                        <td>${i + 1}</td>
                        <td>
                          <div class="mini-song">
                            <img
                              src="${song.image_url ? withCacheBuster(song.image_url) : ""}"
                              alt="${song.title}"
                            >
                            <div>
                              <div><strong>${song.title_clean || song.title}</strong></div>
                              <div class="mini-song-sub">
                                ${
                                  state.combineVersions && (song.combined_versions_count || 1) > 1
                                    ? `${song.combined_versions_count} versions combined`
                                    : (song.version_tag || formatArtistAlbum(song))
                                }
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>${formatFull(song.daily_streams)}</td>
                        <td>${formatFull(song.streams)}</td>
                        <td>
                          ${renderStreamChange(song.total_change)}
                          <div class="sub-delta">${renderPercentChange(song.percent_change)}</div>
                        </td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              </div>
            `
            : `<div class="empty">No songs in ${block.name}.</div>`
        }
      `).join("")}
    </section>
  `;

  const albumSortStreamsBtn = document.getElementById("albumSortStreamsBtn");
  if (albumSortStreamsBtn) {
    albumSortStreamsBtn.onclick = () => {
      state.albumSortMode = "streams";
      renderPage();
    };
  }

  const albumSortDailyBtn = document.getElementById("albumSortDailyBtn");
  if (albumSortDailyBtn) {
    albumSortDailyBtn.onclick = () => {
      state.albumSortMode = "daily";
      renderPage();
    };
  }

  const albumCombineBtn = document.getElementById("albumCombineBtn");
  if (albumCombineBtn) {
    albumCombineBtn.onclick = () => {
      state.combineVersions = !state.combineVersions;
      renderPage();
    };
  }
}


/* =========================
   SONG PAGE
========================= */

function renderSongPage(container){

  const family = decodeURIComponent(getQueryParam("family")||"");

  const songs =
    state.songs.filter(s=>getCombineKey(s)===family);

  if(!songs.length){
    container.innerHTML = `
      ${renderTopbar()}
      <div class="section-card empty">Song not found</div>
    `;
    return;
  }

  const rows =
    enrichSongsForDate(state.selectedDate)
      .filter(s=>songs.some(x=>x.track_id===s.track_id));

  const totalStreams =
    rows.reduce((s,r)=>s+(r.streams||0),0);

  const totalDaily =
    rows.reduce((s,r)=>s+(r.daily_streams||0),0);

  const main = rows[0];

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">

      <div class="album-hero">

        <img
          class="album-cover-small"
          src="${withCacheBuster(main.image_url)}"
        >

        <div>

          <h2>${main.title_clean||main.title}</h2>

          <div class="mini-song-sub">
            ${formatArtistAlbum(main)}
          </div>

          <div class="mini-song-sub">
            ${formatFull(totalStreams)} streams
          </div>

        </div>

      </div>

      <div class="stats-grid">

        <div class="stat-card">
          <div class="stat-label">Daily streams</div>
          <div class="stat-value">${formatFull(totalDaily)}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Total streams</div>
          <div class="stat-value">${formatFull(totalStreams)}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Versions</div>
          <div class="stat-value">${rows.length}</div>
        </div>

      </div>

      <div class="table-wrap">

        <table class="table">

          <thead>
            <tr>
              <th>Version</th>
              <th>Album</th>
              <th>Daily</th>
              <th>Total</th>
            </tr>
          </thead>

          <tbody>

            ${
              rows.map(r=>`
              <tr>

                <td>${r.title}</td>

                <td>${r.primary_album}</td>

                <td>${formatFull(r.daily_streams)}</td>

                <td>${formatFull(r.streams)}</td>

              </tr>
              `).join("")
            }

          </tbody>

        </table>

      </div>

    </section>
  `;

}
/* =========================
   MILESTONE PROGRESS BAR
========================= */

function getMilestoneBarClass(percent) {
  if (percent >= 80) return "is-hot";
  if (percent >= 60) return "is-purple";
  if (percent >= 40) return "is-blue";
  return "is-teal";
}

function milestoneProgressBar(item) {
  const p = getMilestonePercent(item);

  return `
    <div class="milestone-fancy-progress">
      <div class="milestone-fancy-track">
        <div class="milestone-fancy-percent">${p.toFixed(2).replace(".", ",")} %</div>        <div class="milestone-fancy-bar-shell">
          <div class="milestone-fancy-bar-fill" style="width:${p}%"></div>
        </div>
      </div>
    </div>
  `;
}

/* =========================
   MILESTONE ROW
========================= */

function getMilestonePercent(item) {
  const current = Number(item.current_streams ?? item.streams ?? 0);
  const target = Number(item.next_milestone ?? item.progress?.target ?? 0);

  if (!current || !target) return 0;

  return Math.max(0, Math.min(100, (current / target) * 100));
}

function milestoneRow(item) {
  const daysLeft = item.forecast?.days_left ?? null;
  if (!item?.forecast?.expected_date) return "";

  const song = state.songs.find(s => s.track_id === item.track_id);
  if (!song) return "";

  const currentStreams = item.current_streams ?? song.streams ?? 0;
  const avgDaily =
    item.estimated_base_daily ??
    item.latest_daily_streams ??
    item.daily_streams ??
    0;

  const remaining = item.progress?.remaining ?? 0;

  console.log(
    item.title || song.title,
    getMilestonePercent(item),
    item.progress
  );

  return `
    <div class="milestone-highlight-item">
      <img
        class="milestone-highlight-cover"
        src="${withCacheBuster(song.image_url)}"
        alt="${song.title}"
      >

      <div class="milestone-highlight-content">
        <div class="milestone-highlight-title">
          ${song.title_clean || song.title}
        </div>

        <div class="milestone-highlight-text">
          ${item.next_milestone_label} milestone expected <strong>${item.forecast.expected_date}</strong>
        </div>

        <div class="milestone-inline-stats">
          <span>Total streams <strong>${formatFull(currentStreams)}</strong></span>
          <span>Avg daily <strong>${formatFull(avgDaily)}</strong></span>
          <span>Remaining <strong>${formatFull(remaining)}</strong></span>
          <span>Days left <strong>${daysLeft !== null ? daysLeft : "—"}</strong></span>
        </div>

        ${milestoneProgressBar(item)}
      </div>
    </div>
  `;
}

/* =========================
   MILESTONES PAGE
========================= */

function renderMilestones(container) {
  const rows = (state.expectedMilestones || [])
    .filter(item => item?.forecast?.expected_date)
    .slice()
    .sort((a, b) => {
      const da = new Date(a.forecast.expected_date);
      const db = new Date(b.forecast.expected_date);
      return da - db;
    });

  if (!rows.length) {
    container.innerHTML = `
      ${renderTopbar()}

      <section class="section-card">
        <div class="section-head">
          <h2>Milestones</h2>
        </div>

        <div class="empty">
          No upcoming milestones
        </div>
      </section>
    `;
    return;
  }

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Upcoming Milestones</h2>
          <p>Sorted by expected date</p>
        </div>
      </div>

      <div class="milestone-highlight-list">
        ${rows.map(milestoneRow).join("")}
      </div>
    </section>
  `;
}


/* =========================
   DATE CONTROLS
========================= */

function bindDateControls() {
  const input = document.getElementById("dateInput");
  const prev = document.getElementById("prevDayBtn");
  const next = document.getElementById("nextDayBtn");

  if (input) {
    input.onchange = async () => {
      state.selectedDate = input.value;
      persistSelectedDate();
      await loadHistory(state.selectedDate);
      renderPage();
    };
  }

  if (prev) {
    prev.onclick = async () => {
      const d = getPreviousDate(state.selectedDate);
      if (!d) return;
      state.selectedDate = d;
      persistSelectedDate();
      await loadHistory(state.selectedDate);
      renderPage();
    };
  }

  if (next) {
    next.onclick = async () => {
      const d = getNextDate(state.selectedDate);
      if (!d) return;
      state.selectedDate = d;
      persistSelectedDate();
      await loadHistory(state.selectedDate);
      renderPage();
    };
  }
}


/* =========================
   SEARCH BINDING
========================= */

function bindSearch(){

  const input = document.getElementById("searchInput");
  if(!input) return;

  input.oninput = ()=>{
    state.searchQuery = input.value.trim();
    renderPage();
  };

}


/* =========================
   UPDATE BUTTON
========================= */

function bindUpdateButton(){

  const btn = document.getElementById("updateBtn");
  if(!btn) return;

  btn.onclick = async ()=>{

    btn.classList.add("loading");

    try{

      const r = await fetch("update_streams",{
        method:"POST"
      });

      const data = await r.json();

      state.updateLogText = data.message || "Updated";
      state.updateLogClass = "update-log success";

      await loadData();

      renderPage();

    }
    catch(e){

      state.updateLogText =
        "Update failed. Spotify usually updates around 15:00 Paris time.";

      state.updateLogClass = "update-log error";

      renderPage();

    }

    btn.classList.remove("loading");

  };

}


/* =========================
   PAGE ROUTER
========================= */

async function renderPage() {
  if (state.selectedDate) {
    await loadHistory(state.selectedDate);

    const prevDate = getPreviousDate(state.selectedDate);
    if (prevDate) {
      await loadHistory(prevDate);
    }
  }

  const container = document.getElementById("app") || document.body;

  await applyTheme(state.themeMode);

  if (state.page === "home") {
    renderHome(container);
  } else if (state.page === "albums") {
    renderAlbums(container);
  } else if (state.page === "album") {
    renderAlbumPage(container);
  } else if (state.page === "song") {
    renderSongPage(container);
  } else if (state.page === "milestones") {
    renderMilestones(container);
  }

  bindThemeSwitcher();
  bindCursorGlow();
  bindDateControls();
  bindSearch();
  bindUpdateButton();
}


/* =========================
   DATA LOADING
========================= */

async function loadData() {
  const [
    songsData,
    albumsData,
    artistData,
    expectedMilestonesData,
    albumCoversData
  ] = await Promise.all([
    fetchJSON("site/data/songs.json"),
    fetchJSON("site/data/albums.json"),
    fetchJSON("site/data/artist.json").catch(() => null),
    fetchJSON("site/data/expected_milestones.json").catch(() => null),
    fetchJSON("discography/albums/covers.json").catch(() => ({}))
  ]);

  state.songs = songsData.songs || [];
  state.albums = albumsData.albums || [];
  state.artist = artistData || null;
  state.expectedMilestones = expectedMilestonesData?.forecasts || [];
  state.albumCovers = albumCoversData || {};

  state.history = {};

  let allDates = songsData.dates || expectedMilestonesData?.dates || [];

  if (!allDates.length) {
    const r = await fetchJSON("site/history/index.json");
    allDates = r.dates || [];
  }

  state.dates = allDates;

  const storedDate = localStorage.getItem("site-selected-date");
  const latestDate = state.dates[state.dates.length - 1] || null;

  if (storedDate && state.dates.includes(storedDate)) {
    state.selectedDate = storedDate;
  } else {
    state.selectedDate = latestDate;
    persistSelectedDate();
  }

  if (state.selectedDate) {
    await loadHistory(state.selectedDate);
  }
}


/* =========================
   INIT
========================= */

async function init(){

  try{

    await loadData();

    document.body.insertAdjacentHTML(
      "beforeend",
      renderAmbientEffects()
    );

    renderPage();

  }
  catch(e){

    console.error(e);

    document.body.innerHTML = `
      <div style="
        padding:40px;
        font-family:sans-serif;
      ">
        Failed to load data.
      </div>
    `;

  }

}

document.addEventListener("DOMContentLoaded", init);