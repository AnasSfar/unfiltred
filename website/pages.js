import { state } from "./state.js";
import {
  formatFull, formatSigned, withCacheBuster, getDayData, getPreviousDate,
  formatArtists, formatArtistAlbum, normalizeAlbumName, getAlbumSectionPriority,
  getAlbumCover, filterSongsByQuery, normalize, persistSelectedDate,
  getQueryParam, sortDisplayBlocks, renderFocusModal
} from "./utils.js";
import {
  loadHistory, getCombineKey, enrichSongsForDate, sortSongs,
  combineSongVersions, withRankChanges
} from "./data.js";
import {
  renderTopbar, renderSearchBar, renderNewsSection, renderRankChange,
  renderStreamChange, renderPercentChange, songRow, renderStats
} from "./components.js";

/* =========================
   ALBUM IMAGE DOWNLOAD
========================= */

function _loadImg(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h,     x, y + h - r,     r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y,         x + r, y,         r);
  ctx.closePath();
}

function _clip(ctx, x, y, w, h, r) {
  _rrect(ctx, x, y, w, h, r);
  ctx.clip();
}

function _ellipsis(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

async function downloadAlbumImage(albumName, blocks, totalStreams, totalDaily, dateLabel, coverUrl) {
  const W = 800, SCALE = 2;
  const PAD = 16, HDR_H = 132, COL_H = 36, ROW_H = 52, FTR_H = 44;

  const songs = blocks
    .flatMap(b => b.songs)
    .sort((a, b) => (b.daily_streams || 0) - (a.daily_streams || 0))
    .slice(0, 10);

  const H = PAD + HDR_H + COL_H + songs.length * ROW_H + FTR_H + PAD;

  const canvas = document.createElement("canvas");
  canvas.width  = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  /* — background — */
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, "#f4f7f8");
  bgGrad.addColorStop(1, "#edf3f4");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  /* — card shadow + white bg — */
  const cx = PAD, cy = PAD, cw = W - PAD * 2, ch = H - PAD * 2;
  ctx.fillStyle = "#fff";
  _rrect(ctx, cx, cy, cw, ch, 18);
  ctx.fill();

  /* — header dark bg — */
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx + 18, cy);
  ctx.lineTo(cx + cw - 18, cy);
  ctx.arcTo(cx + cw, cy,     cx + cw, cy + 18, 18);
  ctx.lineTo(cx + cw, cy + HDR_H);
  ctx.lineTo(cx, cy + HDR_H);
  ctx.lineTo(cx, cy + 18);
  ctx.arcTo(cx, cy,     cx + 18, cy, 18);
  ctx.closePath();
  ctx.clip();

  const hGrad = ctx.createLinearGradient(cx, cy, cx + cw, cy + HDR_H);
  hGrad.addColorStop(0, "#0d1117");
  hGrad.addColorStop(0.55, "#131e15");
  hGrad.addColorStop(1, "#0e1c24");
  ctx.fillStyle = hGrad;
  ctx.fillRect(cx, cy, cw, HDR_H);

  /* green ambient */
  const g1 = ctx.createRadialGradient(cx + cw * .75, cy + HDR_H * .5, 0, cx + cw * .75, cy + HDR_H * .5, 160);
  g1.addColorStop(0, "rgba(29,185,84,.18)"); g1.addColorStop(1, "transparent");
  ctx.fillStyle = g1; ctx.fillRect(cx, cy, cw, HDR_H);

  /* — album cover — */
  const SZ = 92, ax = cx + 20, ay = cy + (HDR_H - SZ) / 2;
  try {
    const img = await _loadImg(coverUrl);
    ctx.save(); _clip(ctx, ax, ay, SZ, SZ, 10);
    ctx.drawImage(img, ax, ay, SZ, SZ);
    ctx.restore();
  } catch {
    ctx.fillStyle = "#1f2937"; _rrect(ctx, ax, ay, SZ, SZ, 10); ctx.fill();
  }
  ctx.restore();

  /* — header text — */
  const tx = ax + SZ + 20;
  ctx.fillStyle = "#fff";
  ctx.font = "800 21px Inter,system-ui,sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(_ellipsis(ctx, albumName, cw - SZ - 60), tx, cy + 42);

  ctx.fillStyle = "rgba(255,255,255,.6)";
  ctx.font = "500 12.5px Inter,system-ui,sans-serif";
  ctx.fillText("Taylor Swift · " + dateLabel, tx, cy + 64);

  ctx.fillStyle = "#e8e8e8";
  ctx.font = "700 15px Inter,system-ui,sans-serif";
  ctx.fillText(formatFull(totalStreams) + " total streams", tx, cy + 90);

  ctx.fillStyle = "#1db954";
  ctx.font = "700 15px Inter,system-ui,sans-serif";
  ctx.fillText("+" + formatFull(totalDaily) + " daily streams", tx, cy + 114);

  /* — column headers — */
  const hY = cy + HDR_H;
  ctx.fillStyle = "#f1f5f6";
  ctx.fillRect(cx, hY, cw, COL_H);
  ctx.fillStyle = "rgba(16,24,40,.07)";
  ctx.fillRect(cx, hY + COL_H - 1, cw, 1);

  ctx.fillStyle = "#667085";
  ctx.font = "700 9.5px Inter,system-ui,sans-serif";
  ctx.textBaseline = "middle";
  const mh = hY + COL_H / 2;
  ctx.textAlign = "left";
  ctx.fillText("#",      cx + 20,  mh);
  ctx.fillText("TRACK",  cx + 106, mh);
  ctx.textAlign = "right";
  ctx.fillText("DAILY",  cx + cw - 110, mh);
  ctx.fillText("TOTAL",  cx + cw - 16,  mh);

  /* — song rows — */
  for (let i = 0; i < songs.length; i++) {
    const s  = songs[i];
    const rY = cy + HDR_H + COL_H + i * ROW_H;
    const mr = rY + ROW_H / 2;

    /* row bg */
    if (i === 0) {
      const gg = ctx.createLinearGradient(cx, rY, cx + cw, rY);
      gg.addColorStop(0, "#fff8d0"); gg.addColorStop(.35, "#fffbee"); gg.addColorStop(1, "#fff");
      ctx.fillStyle = gg; ctx.fillRect(cx, rY, cw, ROW_H);
      ctx.fillStyle = "#e8b91a"; ctx.fillRect(cx, rY, 3, ROW_H);
    } else {
      ctx.fillStyle = i % 2 !== 0 ? "#f8fafc" : "#fff";
      ctx.fillRect(cx, rY, cw, ROW_H);
    }
    ctx.fillStyle = "rgba(16,24,40,.05)"; ctx.fillRect(cx, rY + ROW_H - 1, cw, 1);

    /* rank */
    ctx.fillStyle = "#0b1f44";
    ctx.font = "900 16px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`#${i + 1}`, cx + 36, mr);

    /* artwork 42×42 */
    const imgX = cx + 60, imgY = rY + (ROW_H - 42) / 2;
    try {
      const a = await _loadImg(s.image_url);
      ctx.save(); _clip(ctx, imgX, imgY, 42, 42, 6);
      ctx.drawImage(a, imgX, imgY, 42, 42);
      ctx.restore();
    } catch {
      ctx.fillStyle = "#dde3ea"; _rrect(ctx, imgX, imgY, 42, 42, 6); ctx.fill();
    }

    /* title + artist */
    const nameX = imgX + 48;
    const maxW  = cw - (nameX - cx) - 220;
    ctx.textAlign = "left";
    ctx.fillStyle = "#101828";
    ctx.font = "700 13px Inter,system-ui,sans-serif";
    ctx.fillText(_ellipsis(ctx, s.title_clean || s.title, maxW), nameX, mr - 7);
    ctx.fillStyle = "#667085";
    ctx.font = "500 11px Inter,system-ui,sans-serif";
    ctx.fillText("Taylor Swift", nameX, mr + 9);

    /* streams */
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#344054";
    ctx.font = "500 12px Inter,system-ui,sans-serif";
    ctx.fillText(formatFull(s.daily_streams), cx + cw - 110, mr);
    ctx.fillText(formatFull(s.streams),       cx + cw - 16,  mr);
  }

  /* — footer — */
  const fY = cy + HDR_H + COL_H + songs.length * ROW_H;
  ctx.fillStyle = "#f1f5f6"; ctx.fillRect(cx, fY, cw, FTR_H);
  ctx.fillStyle = "rgba(16,24,40,.07)"; ctx.fillRect(cx, fY, cw, 1);

  ctx.fillStyle = "#1db954";
  ctx.font = "700 11px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("@swiftiescharts", cx + 16, fY + FTR_H / 2);

  ctx.fillStyle = "#667085";
  ctx.font = "500 11px Inter,system-ui,sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(dateLabel, cx + cw - 16, fY + FTR_H / 2);

  /* — download — */
  const link = document.createElement("a");
  link.download = `${albumName.replace(/[^a-z0-9]/gi, "_")}_${state.selectedDate}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}


/* =========================
   HOME PAGE
========================= */

function _buildHomeRows() {
  const raw    = enrichSongsForDate(state.selectedDate);
  const base   = state.combineVersions ? combineSongVersions(raw) : raw;
  const ranked = withRankChanges(base, state.selectedDate, state.sortMode);
  const filtered = filterSongsByQuery(ranked);
  const sorted   = sortSongs(filtered, state.sortMode);
  return { ranked, filtered, sorted };
}

function _bindHomeButtons() {
  document.getElementById("sortStreamsBtn")?.addEventListener("click", () => {
    state.sortMode = "streams"; _updateHomeTable();
  });
  document.getElementById("sortDailyBtn")?.addEventListener("click", () => {
    state.sortMode = "daily"; _updateHomeTable();
  });
  document.getElementById("combineBtn")?.addEventListener("click", () => {
    state.combineVersions = !state.combineVersions; _updateHomeTable();
  });
}

function _updateHomeTable() {
  const { filtered, sorted } = _buildHomeRows();

  const tbody = document.getElementById("home-songs-body");
  if (tbody) tbody.innerHTML = sorted.map(songRow).join("");

  const desc = document.getElementById("home-sort-desc");
  if (desc) {
    desc.textContent = `${state.selectedDate} • sorted by ${state.sortMode === "daily" ? "daily streams" : "total streams"} • ${filtered.length} result${filtered.length !== 1 ? "s" : ""}`;
  }

  const btns = {
    sortStreamsBtn: state.sortMode === "streams",
    sortDailyBtn:  state.sortMode === "daily",
    combineBtn:    state.combineVersions,
  };
  for (const [id, active] of Object.entries(btns)) {
    const el = document.getElementById(id);
    if (el) el.className = active ? "active" : "";
  }

  const si = document.getElementById("searchInput");
  if (si && document.activeElement !== si) si.value = state.searchQuery;
}

export function renderHome(container) {
  const shell = document.getElementById("home-shell");

  // Partial update: date and data-generation unchanged → only refresh table
  // (sort/search/combine trigger _updateHomeTable() directly; renderPage() forces full re-render via generation bump)
  if (shell && shell.dataset.date === state.selectedDate && shell.dataset.gen === String(state._dataGen || 0)) {
    _updateHomeTable();
    return; // topbar/controls preserved in DOM, already bound
  }

  // Full render (first load or date changed)
  const { ranked, filtered, sorted } = _buildHomeRows();

  container.innerHTML = `
    <div id="home-shell" data-date="${state.selectedDate}" data-gen="${state._dataGen || 0}">
      ${renderTopbar()}
      ${renderNewsSection(ranked, state.selectedDate)}

      ${renderStats(ranked)}

      <section class="section-card">
        <div class="section-head">
          <div>
            <h2>Main Ranking</h2>
            <p id="home-sort-desc">
              ${state.selectedDate} • sorted by
              ${state.sortMode === "daily" ? "daily streams" : "total streams"}
              • ${filtered.length} result${filtered.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div class="toolbar">
            ${renderSearchBar()}
            <button id="sortStreamsBtn" class="${state.sortMode === "streams" ? "active" : ""}">Total streams</button>
            <button id="sortDailyBtn"  class="${state.sortMode === "daily"   ? "active" : ""}">Daily streams</button>
            <button id="combineBtn"    class="${state.combineVersions        ? "active" : ""}">Combine</button>
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
            <tbody id="home-songs-body">
              ${sorted.map(songRow).join("")}
            </tbody>
          </table>
        </div>
      </section>

      ${renderFocusModal()}
    </div>
  `;

  _bindHomeButtons();
}
/* =========================
   ALBUM CARD
========================= */

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

export function renderAlbums(container) {
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
      window.dispatchEvent(new Event("site:render"));
    };
  }

  const sortAlbumDailyBtn = document.getElementById("sortAlbumDailyBtn");
  if (sortAlbumDailyBtn) {
    sortAlbumDailyBtn.onclick = () => {
      state.albumSortMode = "daily";
      window.dispatchEvent(new Event("site:render"));
    };
  }

  const albumsCombineBtn = document.getElementById("albumsCombineBtn");
  if (albumsCombineBtn) {
    albumsCombineBtn.onclick = () => {
      state.combineVersions = !state.combineVersions;
      window.dispatchEvent(new Event("site:render"));
    };
  }
}


/* =========================
   ALBUM DETAIL PAGE
========================= */

export function renderAlbumPage(container) {
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
    const appearance = (song.appearances || []).find(app => app.album === albumName) || null;
    const sectionName = appearance?.display_section || "Other";
    const songOrder = appearance?.display_order ?? 9999;
    if (!groups.has(sectionName)) {
      groups.set(sectionName, { name: sectionName, firstSongOrder: songOrder, songs: [] });
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
      if (state.combineVersions) songs = combineSongVersions(songs);
      songs.sort((a, b) =>
        state.albumSortMode === "daily"
          ? ((b.daily_streams || 0) - (a.daily_streams || 0)) || ((b.streams || 0) - (a.streams || 0)) || a.title.localeCompare(b.title)
          : ((b.streams || 0) - (a.streams || 0)) || ((b.daily_streams || 0) - (a.daily_streams || 0)) || a.title.localeCompare(b.title)
      );
      return { ...block, songs };
    });

  const totalStreams = blocks.reduce((s, b) => s + b.songs.reduce((ss, song) => ss + (song.streams || 0), 0), 0);
  const totalDaily  = blocks.reduce((s, b) => s + b.songs.reduce((ss, song) => ss + (song.daily_streams || 0), 0), 0);
  const totalPrevDaily = blocks.reduce((s, b) => s + b.songs.reduce((ss, song) => ss + (song.previous_daily_streams || 0), 0), 0);
  const totalPct = totalPrevDaily ? ((totalDaily - totalPrevDaily) / totalPrevDaily * 100) : null;

  // Header image — looks for discography/albums/headers/{albumName}.{ext}
  const coverUrl  = withCacheBuster(getAlbumCover(album));
  const _hdrBase  = `discography/albums/headers/${encodeURIComponent(albumName)}`;
  // Try jpg first, browser will ignore missing urls gracefully via onerror
  const headerImg = `${_hdrBase}.jpg`;
  const hdrStyle  = `background-image:linear-gradient(rgba(0,0,0,.52),rgba(0,0,0,.52)),url('${headerImg}');background-size:cover;background-position:center top;background-color:#0d1117;`;

  // Date label
  const dateLabel = state.selectedDate
    ? new Date(state.selectedDate + "T12:00:00").toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" })
    : "";

  function pctHtml(pct) {
    if (pct === null || pct === undefined) return '<span class="alb-neutral">—</span>';
    const cls = pct >= 0 ? "alb-pos" : "alb-neg";
    return `<span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
  }

  function blocksHtml() {
    return blocks.map(block => {
      const secStreams    = block.songs.reduce((s, sg) => s + (sg.streams || 0), 0);
      const secDaily     = block.songs.reduce((s, sg) => s + (sg.daily_streams || 0), 0);
      const secPrevDaily = block.songs.reduce((s, sg) => s + (sg.previous_daily_streams || 0), 0);
      const secPct       = secPrevDaily ? ((secDaily - secPrevDaily) / secPrevDaily * 100) : null;
      const secDailySign = secDaily >= 0 ? "+" : "";

      const rows = block.songs.map((song, i) => {
        const pct    = song.percent_change ?? null;
        const art    = song.image_url
          ? `<img class="alb-art" src="${withCacheBuster(song.image_url)}" loading="lazy" alt="">`
          : `<div class="alb-art-ph"></div>`;
        const sub    = state.combineVersions && (song.combined_versions_count || 1) > 1
          ? `${song.combined_versions_count} versions`
          : (song.version_tag || "");
        const rowCls = i === 0 ? "alb-row alb-row-gold" : (i % 2 !== 0 ? "alb-row alb-row-odd" : "alb-row");
        return `
        <div class="${rowCls}">
          <div class="alb-col-num">${i + 1}</div>
          <div class="alb-col-song">
            ${art}
            <div class="alb-song-text">
              <div class="alb-song-title">${song.title_clean || song.title}</div>
              ${sub ? `<div class="alb-song-sub">${sub}</div>` : ""}
            </div>
          </div>
          <div class="alb-col-num alb-right">${formatFull(song.streams)}</div>
          <div class="alb-col-num alb-right">${formatFull(song.daily_streams)}</div>
          <div class="alb-col-num alb-right">${pctHtml(pct)}</div>
        </div>`;
      }).join("");

      return `
      <div class="alb-section-hdr">${block.name}</div>
      ${rows}
      <div class="alb-section-total">
        <span class="alb-total-label">${block.name} — Total</span>
        <span class="alb-total-streams">${formatFull(secStreams)}</span>
        <span class="alb-total-daily">${secDailySign}${formatFull(secDaily)}</span>
        <span>${pctHtml(secPct)}</span>
      </div>`;
    }).join("");
  }

  container.innerHTML = `
    ${renderTopbar()}
    <div class="alb-wrap">

      <div class="alb-hdr" style="${hdrStyle}">
        <img class="alb-cover" src="${coverUrl}" alt="${albumName}">
        <div class="alb-hdr-info">
          <div class="alb-title">${albumName}</div>
          <div class="alb-hdr-sub">Taylor Swift &middot; ${dateLabel}</div>
          <div class="alb-hdr-total">
            ${formatFull(totalStreams)} streams &nbsp;&middot;&nbsp;
            <span class="${totalPct !== null ? (totalPct >= 0 ? "alb-pos" : "alb-neg") : "alb-neutral"}">
              ${totalPct !== null ? (totalPct >= 0 ? "+" : "") + totalPct.toFixed(1) + "%" : ""} today
            </span>
          </div>
        </div>
        <div class="alb-toolbar">
          <button id="albumSortStreamsBtn" class="${state.albumSortMode === "streams" ? "active" : ""}">Total</button>
          <button id="albumSortDailyBtn"  class="${state.albumSortMode === "daily"   ? "active" : ""}">Daily</button>
          <button id="albumCombineBtn"    class="${state.combineVersions             ? "active" : ""}">Combine</button>
          <button id="albumDownloadBtn" class="alb-dl-btn" title="Download image">⬇ Image</button>
        </div>
      </div>

      <div class="alb-col-heads">
        <span>#</span>
        <span>Song</span>
        <span class="alb-right">Streams</span>
        <span class="alb-right">Daily</span>
        <span class="alb-right">Change</span>
      </div>

      ${blocksHtml()}

    </div>
  `;

  document.getElementById("albumSortStreamsBtn")?.addEventListener("click", () => { state.albumSortMode = "streams"; window.dispatchEvent(new Event("site:render")); });
  document.getElementById("albumSortDailyBtn") ?.addEventListener("click", () => { state.albumSortMode = "daily";   window.dispatchEvent(new Event("site:render")); });
  document.getElementById("albumCombineBtn")   ?.addEventListener("click", () => { state.combineVersions = !state.combineVersions; window.dispatchEvent(new Event("site:render")); });

  document.getElementById("albumDownloadBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("albumDownloadBtn");
    if (btn) { btn.textContent = "⏳ …"; btn.disabled = true; }
    try {
      await downloadAlbumImage(albumName, blocks, totalStreams, totalDaily, dateLabel, coverUrl);
    } finally {
      if (btn) { btn.textContent = "⬇ Image"; btn.disabled = false; }
    }
  });
}


/* =========================
   SONG PAGE
========================= */

export function renderSongPage(container){

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

  const song = state.songByTrackId?.get(item.track_id) || state.songs.find(s => s.track_id === item.track_id);
  if (!song) return "";

  const currentStreams = item.current_streams ?? song.streams ?? 0;
  const avgDaily =
    item.estimated_base_daily ??
    item.latest_daily_streams ??
    item.daily_streams ??
    0;

  const remaining = item.progress?.remaining ?? 0;

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

export function renderMilestones(container) {
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
   ADMIN
========================= */

export function renderAdmin(container) {

  if (!state.lastRunState) {
    container.innerHTML = `
      ${renderTopbar()}
      <section class="section-card">
        <div class="section-head"><div><h2>Admin</h2><p>Pipeline monitoring</p></div></div>
        <div class="empty">No run state data yet — run the update pipeline first.</div>
      </section>
    `;
    return;
  }

  const statuses = Object.values(state.lastRunState);
  const counts = { updated: 0, ok: 0, timeout: 0, not_found: 0, pending: 0 };
  statuses.forEach(s => { if (counts[s] !== undefined) counts[s]++; else counts.pending++; });

  const problemTracks = Object.entries(state.lastRunState)
    .filter(([, v]) => v === "timeout" || v === "not_found")
    .map(([id, status]) => ({ id, status, song: state.songByTrackId?.get(id) }));

  const streakEntries = state.notFoundStreak
    ? Object.entries(state.notFoundStreak).map(([id, days]) => ({ id, days, song: state.songByTrackId?.get(id) }))
      .sort((a, b) => b.days - a.days)
    : [];

  const latestDate = state.dates[state.dates.length - 1] || "N/A";

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head"><div><h2>Admin</h2><p>Pipeline monitoring</p></div></div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Updated</div>
          <div class="stat-value admin-status-updated">${counts.updated}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">OK (no change)</div>
          <div class="stat-value">${counts.ok}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Timeout</div>
          <div class="stat-value admin-status-timeout">${counts.timeout}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Not found</div>
          <div class="stat-value admin-status-not_found">${counts.not_found}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Pending</div>
          <div class="stat-value admin-status-pending">${counts.pending}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total tracks</div>
          <div class="stat-value">${statuses.length}</div>
        </div>
      </div>
    </section>

    ${problemTracks.length ? `
    <section class="section-card">
      <div class="section-head"><div><h2>Problem tracks</h2><p>Timeout or not found on last run</p></div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Song</th><th>Album</th><th>Track ID</th><th>Status</th></tr></thead>
          <tbody>
            ${problemTracks.map(({ id, status, song }) => `
            <tr>
              <td>${song ? (song.title_clean || song.title) : "Unknown"}</td>
              <td>${song ? (song.primary_album || song.album || "") : ""}</td>
              <td style="font-size:11px;font-family:monospace">${id}</td>
              <td><span class="admin-status-${status}">${status}</span></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>` : ""}

    ${streakEntries.length ? `
    <section class="section-card">
      <div class="section-head"><div><h2>Not-found streaks</h2><p>Auto-deleted after 7 consecutive days</p></div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Song</th><th>Album</th><th>Days missing</th><th>Days left</th></tr></thead>
          <tbody>
            ${streakEntries.map(({ id, days, song }) => `
            <tr>
              <td>${song ? (song.title_clean || song.title) : id}</td>
              <td>${song ? (song.primary_album || song.album || "") : ""}</td>
              <td class="${days >= 5 ? "admin-streak-danger" : ""}">${days}</td>
              <td class="${(7 - days) <= 2 ? "admin-streak-danger" : ""}">${Math.max(0, 7 - days)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>` : ""}

    <section class="section-card">
      <div class="section-head"><div><h2>Update</h2><p>Last update: ${latestDate} &nbsp;•&nbsp; Next: 14:05 UTC / 15:05 CET (daily)</p></div></div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:0 4px 4px">
        <button id="updateBtn" class="update-btn">Refresh data</button>
        <div class="${state.updateLogClass}">${state.updateLogText || ""}</div>
        <pre class="admin-log-pre" id="adminLog">${state.updateLogText || "No recent log."}</pre>
      </div>
    </section>
  `;
}


/* =========================
   BILLBOARD
========================= */

export function renderBillboard(container) {

  if (!state.billboard) {
    container.innerHTML = `
      ${renderTopbar()}
      <section class="section-card">
        <div class="section-head"><div><h2>Billboard</h2><p>Taylor Swift chart entries</p></div></div>
        <div class="empty">No Billboard data available yet — run scrape_billboard.py first.</div>
      </section>
    `;
    return;
  }

  const tabs = [
    { key: "hot_100",          label: "Hot 100" },
    { key: "billboard_200",    label: "Billboard 200" },
    { key: "ts_chart_history", label: "TS Chart History" },
  ];

  const activeTab = state.billboardTab;
  const rows = state.billboard[activeTab] || [];
  const scrapedAt = state.billboard.scraped_at
    ? state.billboard.scraped_at.replace("T", " ").slice(0, 16)
    : "recently";

  const greatestArtists = state.billboard.greatest_artists;

  container.innerHTML = `
    ${renderTopbar()}

    <section class="section-card">
      <div class="section-head">
        <div>
          <h2>Billboard Charts</h2>
          <p>Taylor Swift entries &nbsp;•&nbsp; Scraped ${scrapedAt}</p>
        </div>
        <div class="toolbar">
          ${tabs.map(t =>
            `<button id="bbTab_${t.key}"
               class="${activeTab === t.key ? "active" : ""}">
               ${t.label}
             </button>`
          ).join("")}
        </div>
      </div>

      ${greatestArtists ? `
      <div class="admin-greatest-badge">
        Greatest of All Time Artists: <strong>#${greatestArtists.rank}</strong>
      </div>` : ""}

      ${rows.length === 0 ? `<div class="empty">No entries for this chart.</div>` : `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th style="width:52px">#</th>
              <th>Title</th>
              <th>Artist</th>
              <th style="width:130px">Weeks on Chart</th>
              <th style="width:100px">Peak Rank</th>
              ${activeTab === "ts_chart_history" ? "<th>Chart</th>" : ""}
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
            <tr>
              <td>${r.rank ?? "-"}</td>
              <td>${r.title ?? "-"}</td>
              <td>${r.artist ?? "Taylor Swift"}</td>
              <td>${r.weeks_on_chart ?? "-"}</td>
              <td>${r.peak_rank ?? "-"}</td>
              ${activeTab === "ts_chart_history" ? `<td>${r.chart ?? "-"}</td>` : ""}
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`}
    </section>
  `;

  tabs.forEach(t => {
    document.getElementById(`bbTab_${t.key}`)?.addEventListener("click", () => {
      state.billboardTab = t.key;
      window.dispatchEvent(new Event("site:render"));
    });
  });
}
