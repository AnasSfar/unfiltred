import { state } from "./state.js";
import {
  formatFull, formatSigned, withCacheBuster,
  getDayData, getPreviousDate, formatArtists, formatArtistAlbum
} from "./utils.js";
import { getCombineKey } from "./data.js";
import { renderThemeSwitcher } from "./theme.js";

/* =========================
   NAVIGATION
========================= */

export function renderNav() {

  return `
  <header class="site-nav">
    <div class="site-nav-inner">

      <a class="site-nav-brand" href="index.html">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/>
        </svg>
        <span>Taylor Swift <em>Streams</em></span>
      </a>

      <nav class="site-nav-links">
        <a href="../index.html" class="nav-home">🏠 Home</a>
        <a href="index.html"
          class="${state.page==="home"?"active":""}">Top Songs</a>
        <a href="albums.html"
          class="${state.page==="albums"||state.page==="album"?"active":""}">Albums</a>
        <a href="milestones.html"
          class="${state.page==="milestones"?"active":""}">Milestones</a>
        <a href="billboard.html"
          class="${state.page==="billboard"?"active":""}">Billboard</a>
        <a href="admin.html"
          class="${state.page==="admin"?"active":""}"
          style="opacity:.5;font-size:12px">Admin</a>
      </nav>

      <div class="site-nav-end">
        ${renderThemeSwitcher()}
      </div>

    </div>
  </header>
  `;

}


/* =========================
   SPARKLINE
========================= */

export function renderSparkline(values){

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

export function renderAmbientEffects(){

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


export function bindCursorGlow(){

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

export function renderTopbar(){

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
  ${renderNav()}

  <div class="topbar">

    <div class="tb-artist">
      ${artistImg
        ? `<img class="tb-photo" src="${withCacheBuster(artistImg)}">`
        : `<div class="tb-photo tb-photo-ph">${artist[0]}</div>`
      }
      <div class="tb-info">
        <div class="tb-name">${artist}</div>
        <div class="tb-daily number-update">+${formatFull(dailyStreams)}</div>
        <div class="tb-daily-lbl">daily streams</div>
        <div class="tb-meta">
          <span>${formatFull(totalStreams)} total</span>
          ${monthlyListeners !== null
            ? `<span class="tb-sep">·</span><span>${formatFull(monthlyListeners)} listeners</span>`
            : ""}
          ${monthlyRank !== null
            ? `<span class="tb-rank">#${monthlyRank}</span>`
            : ""}
        </div>
      </div>
    </div>

    <div class="tb-right">
      <div class="tb-chips">
        <span class="tb-chip">${updatedTracks}/${state.songs.length} updated</span>
        <span class="tb-chip">${selected}</span>
      </div>
      ${renderSparkline(sparklineData)}
      <div class="date-controls">
        <button id="prevDayBtn">←</button>
        <input id="dateInput" type="date" value="${selected}"
          min="${state.dates[0]||""}" max="${latest}">
        <button id="nextDayBtn">→</button>
      </div>
      <button id="updateBtn" class="update-btn">Refresh data</button>
      <div class="${state.updateLogClass}">${state.updateLogText||""}</div>
    </div>

  </div>
  `;

}
/* =========================
   SEARCH BAR
========================= */

export function renderSearchBar(placeholder="Search songs..."){
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

export function renderRankChange(change){

  if(change==null) return `<span class="delta neutral">• 0</span>`;
  if(change>0) return `<span class="delta up">↑ ${change}</span>`;
  if(change<0) return `<span class="delta down">↓ ${Math.abs(change)}</span>`;

  return `<span class="delta neutral">• 0</span>`;
}


export function renderStreamChange(change){

  if(change==null) return `<span class="delta neutral">-</span>`;
  if(change>0) return `<span class="delta up">+${formatFull(change)}</span>`;
  if(change<0) return `<span class="delta down">${formatFull(change)}</span>`;

  return `<span class="delta neutral">0</span>`;
}


export function renderPercentChange(change){

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

export function songRow(song){

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

export function renderStats(rows){

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

export function renderNewsSection(rows,date){

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
