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
