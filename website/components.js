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
