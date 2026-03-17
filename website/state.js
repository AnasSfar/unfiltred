/* =========================
   STATE
========================= */

export const state = {
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

  expectedMilestones: [],

  songByTrackId: new Map(),
  _dataGen: 0,

  lastRunState: null,
  notFoundStreak: null,

  billboard: null,
  billboardTab: "hot_100"
};
