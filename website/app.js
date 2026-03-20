import { state } from "./state.js";
import {
  fetchJSON, normalize, persistSelectedDate,
  getPreviousDate, getNextDate
} from "./utils.js";
import { loadHistory, getCombineKey } from "./data.js";
import { applyTheme, bindThemeSwitcher } from "./theme.js";
import { renderAmbientEffects, bindCursorGlow } from "./components.js";
import {
  renderHome, renderAlbums, renderAlbumPage,
  renderSongPage, renderMilestones, renderAdmin, renderBillboard
} from "./pages.js";

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

      const r = await fetch("/api/update",{
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
  } else if (state.page === "admin") {
    renderAdmin(container);
  } else if (state.page === "billboard") {
    renderBillboard(container);
  }

  bindThemeSwitcher(renderPage);
  bindCursorGlow();
  bindDateControls();
  bindSearch();
  bindUpdateButton();
}

// Listen for re-render requests from page modules (avoids circular imports)
window.addEventListener("site:render", () => renderPage());


/* =========================
   DATA LOADING
========================= */

async function loadData() {
  const [
    songsData,
    albumsData,
    artistData,
    expectedMilestonesData,
    albumCoversData,
    lastRunStateData,
    notFoundStreakData,
    billboardData
  ] = await Promise.all([
    fetchJSON("site/data/songs.json"),
    fetchJSON("site/data/albums.json"),
    fetchJSON("site/data/artist.json").catch(() => null),
    fetchJSON("site/data/expected_milestones.json").catch(() => null),
    fetchJSON("../db/discography/covers.json").catch(() => ({})),
    fetchJSON("site/data/last_run_state.json").catch(() => null),
    fetchJSON("site/data/not_found_streak.json").catch(() => null),
    fetchJSON("site/data/billboard.json").catch(() => null)
  ]);

  state.songs = songsData.songs || [];

  // Pre-compute per-song cache keys to avoid 13+ regex per render
  state.songs.forEach(s => {
    s._combineKey = getCombineKey(s);
    s._searchText = normalize([
      s.title, s.title_clean, s.primary_album, s.primary_artist,
      Array.isArray(s.artists) ? s.artists.join(" ") : (s.primary_artist || ""),
      s.version_tag, s.edition, s.type
    ].join(" "));
  });
  state.songByTrackId = new Map(state.songs.map(s => [s.track_id, s]));

  state.albums = albumsData.albums || [];
  state.artist = artistData || null;
  state.expectedMilestones = expectedMilestonesData?.forecasts || [];
  state.albumCovers = albumCoversData || {};
  state.lastRunState   = lastRunStateData   || null;
  state.notFoundStreak = notFoundStreakData || null;
  state.billboard      = billboardData      || null;

  // Increment generation counter so partial-render guards know data changed
  state._dataGen = (state._dataGen || 0) + 1;

  state.history = {};

  let allDates = songsData.dates || expectedMilestonesData?.dates || [];

  if (!allDates.length) {
    const r = await fetchJSON("site/history/index.json");
    allDates = r.dates || [];
  }

  state.dates = allDates;

  const storedDate = localStorage.getItem("site-selected-date");
  const latestDate = state.dates[state.dates.length - 1] || null;

  if (storedDate && storedDate === latestDate) {
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
