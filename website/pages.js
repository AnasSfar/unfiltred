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

  document.getElementById("albumSortStreamsBtn")?.addEventListener("click", () => { state.albumSortMode = "streams"; renderPage(); });
  document.getElementById("albumSortDailyBtn") ?.addEventListener("click", () => { state.albumSortMode = "daily";   renderPage(); });
  document.getElementById("albumCombineBtn")   ?.addEventListener("click", () => { state.combineVersions = !state.combineVersions; renderPage(); });
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
