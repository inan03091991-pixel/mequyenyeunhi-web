import {
  openDatabase,
  getEntries,
  getEntry,
  saveEntry,
  softDeleteEntry,
  setMeta,
  syncData,
  pendingCount,
  clearLocalSession,
} from "./db.js";

let PROFILE = {
  name: "",
  shortName: "Hỷ Nhi",
  sex: "",
  birthAt: null,
  birthPlace: "",
  timezone: "Asia/Ho_Chi_Minh",
};

const VACCINE_NAMES = {
  hepb: "Viêm gan B sơ sinh",
  bcg: "Lao (BCG)",
  combo: "Vắc-xin 6 trong 1",
  opv: "Bại liệt uống (OPV)",
  ipv: "Bại liệt tiêm (IPV)",
  rota: "Rota",
  pcv: "Phế cầu",
  measles: "Sởi",
  mr: "Sởi – Rubella",
  je: "Viêm não Nhật Bản",
  other: "Vắc-xin khác",
};

const SINGLE_DOSE_VACCINES = new Set(["hepb", "bcg", "measles", "mr"]);
const HIDDEN_VACCINE_CODES = new Set(["opv", "ipv"]);

const state = {
  user: null,
  entries: [],
  page: "today",
  selectedDay: null,
  lastCalendarDay: null,
  editingId: null,
  sheetType: null,
  syncTimer: null,
  syncInFlight: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE = String(globalThis.HY_NHI_CONFIG?.apiBase || "").replace(/\/$/, "");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  lockMobileViewport();
  state.selectedDay = localDateKey(new Date());
  state.lastCalendarDay = state.selectedDay;
  bindStaticEvents();
  updateNetworkState();
  updateGreeting();
  await openDatabase();
  const savedTheme = localStorage.getItem("hynhi_theme");
  if (savedTheme === "dark") document.body.classList.add("dark");

  const session = localStorage.getItem("hynhi_session");
  const savedProfile = readSavedProfile();
  if (session && savedProfile?.birthAt) {
    PROFILE = savedProfile;
    state.user = session;
    await enterApp();
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  setInterval(renderActiveBottles, 1000);
  setInterval(checkCalendarDayChange, 30000);
  setInterval(() => backgroundSync(), 10000);
}

function lockMobileViewport() {
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("gesturechange", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("gestureend", (event) => event.preventDefault(), { passive: false });
}

function bindStaticEvents() {
  $("#login-form").addEventListener("submit", handleLogin);
  $("#logout-button").addEventListener("click", handleLogout);
  $("#header-logout").addEventListener("click", handleLogout);
  $("#sync-button").addEventListener("click", () => attemptSync(true));
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#close-sheet").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  $("#main-add").addEventListener("click", () => openSheet("feed"));
  $("#export-json").addEventListener("click", exportJson);
  $("#export-csv").addEventListener("click", exportCsv);
  $("#print-report").addEventListener("click", () => window.print());

  document.addEventListener("click", async (event) => {
    const openButton = event.target.closest("[data-open]");
    if (openButton) openSheet(openButton.dataset.open);

    const navButton = event.target.closest("[data-nav],[data-go]");
    if (navButton) navigate(navButton.dataset.nav || navButton.dataset.go);

    const dayShift = event.target.closest("[data-day-shift]");
    if (dayShift) {
      const date = dateFromKey(state.selectedDay || localDateKey(new Date()));
      date.setDate(date.getDate() + Number(dayShift.dataset.dayShift));
      state.selectedDay = localDateKey(date);
      renderDailyOverview();
    }

    if (event.target.closest("#daily-today")) {
      state.selectedDay = localDateKey(new Date());
      renderDailyOverview();
    }

    const editButton = event.target.closest("[data-edit]");
    if (editButton) {
      const entry = await getEntry(editButton.dataset.edit);
      if (entry) openSheet(entry.type, entry);
    }

    const discardButton = event.target.closest("[data-discard]");
    if (discardButton) await discardBottle(discardButton.dataset.discard);

    const amountButton = event.target.closest("[data-amount]");
    if (amountButton && $("#entry-form").contains(amountButton)) selectAmount(amountButton);

    const deleteButton = event.target.closest("[data-delete-entry]");
    if (deleteButton) await deleteCurrentEntry();

    const vaccineAction = event.target.closest("[data-vaccine-action]");
    if (vaccineAction) {
      if (vaccineAction.dataset.vaccineAction === "skipped") {
        await skipVaccineReminder(vaccineAction);
        return;
      }
      openSheet("vaccine", null, {
        code: vaccineAction.dataset.vaccineCode,
        dose: Number(vaccineAction.dataset.vaccineDose || 1),
        status: vaccineAction.dataset.vaccineAction,
        occurredAt: vaccineAction.dataset.vaccineDate,
      });
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("#vaccine-code, #vaccine-status")) updateVaccineFormVisibility();
    if (event.target.matches("#daily-date") && event.target.value) {
      state.selectedDay = event.target.value;
      renderDailyOverview();
    }
  });

  window.addEventListener("online", () => { updateNetworkState(); backgroundSync(); });
  window.addEventListener("offline", updateNetworkState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") backgroundSync();
  });
  window.addEventListener("pageshow", backgroundSync);
}

async function handleLogin(event) {
  event.preventDefault();
  const username = $("#login-username").value.trim().toLowerCase();
  const password = $("#login-password").value;
  const submit = $("#login-form button[type=submit]");
  submit.disabled = true;
  submit.textContent = "Đang mở nhật ký…";
  $("#login-error").textContent = "";
  try {
    if (!navigator.onLine || location.protocol === "file:") {
      throw new Error("Cần kết nối mạng để đăng nhập. Sau đó ứng dụng có thể tiếp tục dùng khi mất mạng.");
    }
    const result = await remoteLogin(username, password);
    PROFILE = result.profile;
    state.user = username;
    localStorage.setItem("hynhi_session", username);
    localStorage.setItem("hynhi_profile", JSON.stringify(PROFILE));
    if (result.token) localStorage.setItem("hynhi_api_token", result.token);
    await setMeta("currentUser", username);
    await enterApp();
    $("#login-form").reset();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "Đăng nhập";
  }
}

async function remoteLogin(username, password) {
  try {
    const response = await fetch(apiUrl("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: API_BASE ? "omit" : "include",
      body: JSON.stringify({ username, password }),
    });
    if (response.status === 401) throw new Error("Tài khoản hoặc mật khẩu chưa đúng.");
    if (response.status === 429) throw new Error("Đã thử đăng nhập quá nhiều lần. Vui lòng chờ 15 phút rồi thử lại.");
    if (!response.ok) throw new Error("Chưa thể kết nối máy chủ. Vui lòng thử lại.");
    return response.json();
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Không kết nối được máy chủ. Vui lòng kiểm tra mạng.");
    throw error;
  }
}

function readSavedProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem("hynhi_profile") || "null");
    // Sửa một lần dữ liệu giờ sinh đã được lưu nhầm ở các phiên bản trước.
    if (profile?.birthAt === "2026-05-25T03:02:00+07:00") {
      profile.birthAt = "2026-05-25T15:03:00+07:00";
      localStorage.setItem("hynhi_profile", JSON.stringify(profile));
    }
    return profile;
  } catch {
    return null;
  }
}

async function enterApp() {
  renderProfile();
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#current-user").textContent = `${state.user} ›`;
  await refreshData();
  attemptSync();
}

async function handleLogout() {
  if (navigator.onLine && location.protocol !== "file:") {
    const token = localStorage.getItem("hynhi_api_token");
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    await fetch(apiUrl("/api/logout"), { method: "POST", headers, credentials: API_BASE ? "omit" : "include", keepalive: true }).catch(() => {});
  }
  await clearLocalSession();
  localStorage.removeItem("hynhi_profile");
  state.user = null;
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#login-password").value = "";
}

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : `.${path}`;
}

function renderProfile() {
  $("#profile-full-name").textContent = PROFILE.name || "NHẬT KÝ CỦA BÉ";
  $("#baby-age").textContent = PROFILE.birthAt ? formatAge(new Date(PROFILE.birthAt), new Date()) : "—";
  $("#baby-birth").textContent = PROFILE.birthAt
    ? `Sinh lúc ${formatShortTime(PROFILE.birthAt)} • ${formatDate(PROFILE.birthAt)}`
    : "Chưa có thông tin ngày sinh";
}

function updateGreeting() {
  const hour = new Date().getHours();
  $("#greeting").textContent = hour < 11 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Một tối dịu dàng";
}

async function refreshData() {
  state.entries = await getEntries();
  renderAll();
}

function renderAll() {
  renderTodayMetrics();
  renderDailyInsights();
  renderDailyOverview();
  renderGrowth();
  renderVaccines();
  renderReport();
  renderActiveBottles();
}

function entriesForDay(date) {
  const key = localDateKey(date);
  return state.entries.filter((entry) => localDateKey(new Date(entry.occurredAt)) === key);
}

function totalsForDay(date) {
  const entries = entriesForDay(date);
  return {
    entries,
    feed: sum(entries.filter((item) => item.type === "feed"), (item) => item.payload.amount || 0),
    pump: sum(entries.filter((item) => item.type === "pump"), (item) => item.payload.amount || 0),
    poo: entries.filter((item) => item.type === "poo").length,
    sleepMinutes: sum(entries.filter((item) => item.type === "sleep"), (item) => item.payload.durationMinutes || 0),
    feedCount: entries.filter((item) => item.type === "feed").length,
    pumpCount: entries.filter((item) => item.type === "pump").length,
  };
}

function renderDailyInsights() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const today = totalsForDay(now);
  const previous = totalsForDay(yesterday);
  const latestPump = today.entries.find((entry) => entry.type === "pump");
  const dayNearlyDone = now.getHours() >= 20;
  const pumpDayFinished = Boolean(latestPump?.payload?.isLastPump);
  const messages = [];

  if (dayNearlyDone && today.poo === 0) {
    messages.push({ mood: "sad", icon: "☹", title: "Chiếc bụng nhỏ đang im ắng", text: "Hôm nay chưa ghi nhận lần vệ sinh cá nhân nào. Ba mẹ nhớ kiểm tra lại nhật ký và để ý Hỷ Nhi thêm nhé." });
  }

  if (dayNearlyDone && previous.feed > 0 && today.feed < previous.feed) {
    messages.push({ mood: "gentle", icon: "♡", title: "Hôm nay Hỷ Nhi uống ít hơn một chút", text: "Ít hơn hôm qua rồi. Ba mẹ mình bình tĩnh, cùng theo dõi thêm và ôm em một cái thật êm nhé." });
  }

  if ((dayNearlyDone || pumpDayFinished) && previous.pump > 0 && today.pump > 0) {
    if (today.pump < previous.pump) {
      messages.push({ mood: "gentle", icon: "♡", title: "Một lời ôm dành cho mẹ Quyên", text: "Hôm nay lượng sữa ít hơn hôm qua một chút. Mẹ Quyên đừng lo, hôm nay mẹ đã cố gắng rất nhiều rồi!" });
    } else if (today.pump > previous.pump) {
      messages.push({ mood: "happy", icon: "✦", title: "Kho sữa của Hỷ Nhi đầy thêm rồi!", text: "Mẹ Quyên hôm nay hút được nhiều sữa quá. Hỷ Nhi có một kho đồ ăn thật ấm áp rồi!" });
    }
  }

  if (pumpDayFinished) {
    messages.push({ mood: "love", icon: "♥", title: "Ca làm sữa hôm nay đã khép lại", text: "Mẹ Quyên hoàn thành xuất sắc nhiệm vụ rồi. Hỷ Nhi và ba yêu mẹ nhiều lắm!" });
  }

  const section = $("#daily-insights-section");
  section.classList.toggle("hidden", !messages.length);
  $("#daily-insights").innerHTML = messages.map((message) => `<article class="insight-card ${message.mood}"><span class="insight-icon" aria-hidden="true">${message.icon}</span><div><strong>${escapeHtml(message.title)}</strong><p>${escapeHtml(message.text)}</p></div></article>`).join("");
}

function navigate(page) {
  state.page = page;
  $$(".page").forEach((section) => section.classList.toggle("active", section.dataset.page === page));
  $$("[data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "more") renderReport();
}

function entriesToday() {
  const today = localDateKey(new Date());
  return state.entries.filter((entry) => localDateKey(new Date(entry.occurredAt)) === today);
}

function renderTodayMetrics() {
  const today = entriesToday();
  const feed = sum(today.filter((item) => item.type === "feed"), (item) => item.payload.amount || 0);
  const pump = sum(today.filter((item) => item.type === "pump"), (item) => item.payload.amount || 0);
  const poo = today.filter((item) => item.type === "poo").length;
  const sleepMinutes = sum(today.filter((item) => item.type === "sleep"), (item) => item.payload.durationMinutes || 0);
  $("#metric-feed").textContent = `${feed} ml`;
  $("#metric-pump").textContent = `${pump} ml`;
  $("#metric-poo").textContent = `${poo} lần`;
  $("#metric-sleep").textContent = formatDuration(sleepMinutes);

}

function dateFromKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function renderDailyOverview() {
  const selectedKey = state.selectedDay || localDateKey(new Date());
  const selectedDate = dateFromKey(selectedKey);
  const previousDate = new Date(selectedDate);
  previousDate.setDate(previousDate.getDate() - 1);
  const totals = totalsForDay(selectedDate);
  const previous = totalsForDay(previousDate);
  const dateInput = $("#daily-date");
  if (!dateInput) return;
  dateInput.value = selectedKey;
  $("#daily-date-heading").textContent = selectedKey === localDateKey(new Date()) ? "Hôm nay" : new Intl.DateTimeFormat("vi-VN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(selectedDate);
  $("#daily-feed").textContent = `${totals.feed} ml`;
  $("#daily-feed-count").textContent = `${totals.feedCount} cữ`;
  $("#daily-pump").textContent = `${totals.pump} ml`;
  $("#daily-pump-count").textContent = `${totals.pumpCount} ca`;
  $("#daily-poo").textContent = `${totals.poo} lần`;
  $("#daily-sleep").textContent = formatDuration(totals.sleepMinutes);

  const summary = [];
  if (totals.entries.length) {
    summary.push(`Hỷ Nhi đã uống ${totals.feed} ml qua ${totals.feedCount} cữ. Mẹ Quyên hút được ${totals.pump} ml qua ${totals.pumpCount} ca. Bé ngủ ${formatDuration(totals.sleepMinutes)} và đi Poo ${totals.poo} lần.`);
    if (previous.feed > 0 && totals.feed !== previous.feed) summary.push(`Lượng sữa bé uống ${totals.feed > previous.feed ? "nhiều hơn" : "ít hơn"} hôm trước ${Math.abs(totals.feed - previous.feed)} ml.`);
    if (previous.pump > 0 && totals.pump !== previous.pump) summary.push(`Lượng sữa mẹ hút ${totals.pump > previous.pump ? "nhiều hơn" : "ít hơn"} hôm trước ${Math.abs(totals.pump - previous.pump)} ml.`);
    if (totals.poo === 0) summary.push("Nhật ký ngày này chưa ghi nhận lần đi Poo nào.");
  } else {
    summary.push("Ngày này chưa có dữ liệu. Khi ba mẹ ghi một hoạt động, phần tổng quan sẽ tự cập nhật tại đây.");
  }
  $("#daily-summary").innerHTML = `<strong>Tổng quan trong ngày</strong><p>${escapeHtml(summary.join(" "))}</p>`;
  const target = $("#daily-activities");
  target.classList.toggle("empty-state", !totals.entries.length);
  target.innerHTML = totals.entries.length ? totals.entries.map(dailyActivityItem).join("") : "Ngày này chưa có dữ liệu.";
}

function dailyActivityItem(entry) {
  const description = describeEntry(entry);
  const icons = { feed: "◒", pump: "◉", poo: "✦", sleep: "☾", growth: "↗", vaccine: "◇" };
  return `<article class="timeline-item"><div class="timeline-icon" aria-hidden="true">${icons[entry.type] || "•"}</div><div><strong>${escapeHtml(description.title)}</strong><small>${escapeHtml(description.detail)}${entry.createdBy ? ` • ${escapeHtml(entry.createdBy)}` : ""}</small></div><div class="timeline-time"><small>${formatShortTime(entry.occurredAt)}</small><button type="button" data-edit="${entry.id}">Sửa</button></div></article>`;
}

function checkCalendarDayChange() {
  const today = localDateKey(new Date());
  if (today === state.lastCalendarDay) return;
  const wasViewingToday = !state.selectedDay || state.selectedDay === state.lastCalendarDay;
  state.lastCalendarDay = today;
  if (wasViewingToday) state.selectedDay = today;
  updateGreeting();
  renderTodayMetrics();
  renderDailyInsights();
  renderDailyOverview();
}

function timelineItem(entry) {
  const description = describeEntry(entry);
  const icons = { feed: "◒", pump: "◉", poo: "✦", sleep: "☾", growth: "↗", vaccine: "◇" };
  return `<article class="timeline-item">
    <div class="timeline-icon" aria-hidden="true">${icons[entry.type] || "•"}</div>
    <div><strong>${escapeHtml(description.title)}</strong><small>${entry.conflictOf ? "⚠ Hai người đã sửa cùng bản ghi • " : ""}${escapeHtml(description.detail)} • ${escapeHtml(entry.createdBy || "")}</small></div>
    <div class="timeline-time"><small>${formatTimelineTime(entry.occurredAt)}</small><button type="button" data-edit="${entry.id}">Sửa</button></div>
  </article>`;
}

function describeEntry(entry) {
  const payload = entry.payload || {};
  if (entry.type === "feed") {
    const milk = payload.milkType === "formula" ? "Sữa công thức" : payload.milkType === "mixed" ? "Sữa trộn" : "Sữa mẹ";
    return { title: `Bé uống ${payload.amount || 0} ml`, detail: `${milk}${payload.leftover ? ` • còn ${payload.leftover} ml` : ""}` };
  }
  if (entry.type === "pump") return { title: `Hút được ${payload.amount || 0} ml`, detail: payload.note || "Sữa mẹ hút bằng máy" };
  if (entry.type === "poo") return { title: `Vệ sinh cá nhân • ${payload.color || "Chưa chọn màu"}`, detail: payload.consistency || "Chưa chọn dạng phân" };
  if (entry.type === "sleep") return { title: `Ngủ ${formatDuration(payload.durationMinutes || 0)}`, detail: `${formatShortTime(payload.startedAt)} – ${formatShortTime(payload.endedAt)}` };
  if (entry.type === "growth") return { title: "Cập nhật số đo", detail: [payload.weight && `${payload.weight} kg`, payload.length && `${payload.length} cm`, payload.head && `vòng đầu ${payload.head} cm`].filter(Boolean).join(" • ") };
  if (entry.type === "vaccine") {
    const name = payload.customName || VACCINE_NAMES[payload.code] || payload.name || "Tiêm chủng";
    const dose = SINGLE_DOSE_VACCINES.has(payload.code) ? "" : ` • mũi ${payload.dose || 1}`;
    if (payload.status === "planned") return { title: `Đổi lịch ${name}${dose}`, detail: `Dự kiến ${formatDate(entry.occurredAt)}` };
    return { title: `${name}${dose}`, detail: `Đã tiêm/uống${payload.place ? ` • ${payload.place}` : ""}` };
  }
  return { title: "Hoạt động", detail: "" };
}

function renderGrowth() {
  const growthEntries = state.entries.filter((entry) => entry.type === "growth");
  const latestTarget = $("#latest-growth");
  if (!growthEntries.length) {
    latestTarget.className = "growth-summary empty-state";
    latestTarget.innerHTML = "Chưa có số đo. Bạn có thể bổ sung sau.";
    $("#growth-history").className = "stack empty-state";
    $("#growth-history").innerHTML = "Chưa có dữ liệu.";
    return;
  }
  const latest = growthEntries[0].payload;
  latestTarget.className = "growth-summary";
  latestTarget.innerHTML = `<div class="growth-cards"><div><strong>${latest.weight || "—"}</strong><small>kg</small></div><div><strong>${latest.length || "—"}</strong><small>cm chiều dài</small></div><div><strong>${latest.head || "—"}</strong><small>cm vòng đầu</small></div></div>`;
  const history = $("#growth-history");
  history.className = "stack";
  history.innerHTML = growthEntries.map((entry) => `<article class="history-card"><div><strong>${formatDate(entry.occurredAt)}</strong><p>${describeEntry(entry).detail}</p></div><button class="text-button" type="button" data-edit="${entry.id}">Sửa</button></article>`).join("");
}

function vaccineSchedule() {
  const completedRecords = state.entries.filter((entry) => entry.type === "vaccine" && entry.payload.status !== "planned" && entry.payload.status !== "skipped");
  const rotaRecords = completedRecords.filter((entry) => entry.payload.code === "rota");
  const isThreeDoseRota = rotaRecords.some((entry) => /rotateq|rotasiil|3\s*liều/i.test(entry.payload.productName || ""));
  const rows = [
    { code: "hepb", dose: 1, ageMonths: 0, note: "Trong vòng 24 giờ sau sinh" },
    { code: "bcg", dose: 1, ageMonths: 0, note: "Trong tháng đầu" },
    { code: "combo", dose: 1, ageMonths: 2 },
    { code: "combo", dose: 2, ageMonths: 3, previousDose: 1, minDays: 28 },
    { code: "combo", dose: 3, ageMonths: 4, previousDose: 2, minDays: 28 },
    { code: "combo", dose: 4, ageMonths: 18, previousDose: 3, minMonths: 6, note: "Mũi nhắc" },
    { code: "rota", dose: 1, ageMonths: 2, note: "Hoàn thành trước 6 tháng theo lịch TCMR" },
    { code: "rota", dose: 2, ageMonths: 3, previousDose: 1, minDays: 28 },
    { code: "pcv", dose: 1, ageMonths: 2 },
    { code: "pcv", dose: 2, ageMonths: 4, previousDose: 1, minMonths: 2, note: "Cách mũi 1 ít nhất 2 tháng" },
    { code: "measles", dose: 1, ageMonths: 9 },
    { code: "mr", dose: 1, ageMonths: 18 },
    { code: "je", dose: 1, ageMonths: 12 },
    { code: "je", dose: 2, ageMonths: 12, previousDose: 1, minDays: 7, note: "1–2 tuần sau mũi 1" },
    { code: "je", dose: 3, ageMonths: 24, previousDose: 1, minMonths: 12, note: "1 năm sau mũi 1" },
  ];
  if (isThreeDoseRota) rows.splice(rows.findIndex((row) => row.code === "pcv"), 0, { code: "rota", dose: 3, ageMonths: 4, previousDose: 2, minDays: 28, note: "Theo sản phẩm 3 liều đã nhập" });
  return rows.map((row) => {
    let dueAt = addMonths(new Date(PROFILE.birthAt), row.ageMonths);
    const previous = completedRecords.find((entry) => entry.payload.code === row.code && Number(entry.payload.dose) === row.previousDose);
    if (previous) {
      let basedOnActual = new Date(previous.occurredAt);
      if (row.minMonths) basedOnActual = addMonths(basedOnActual, row.minMonths);
      if (row.minDays) basedOnActual = new Date(basedOnActual.getTime() + row.minDays * 86400000);
      if (basedOnActual > dueAt) dueAt = basedOnActual;
    }
    return { ...row, dueAt, recalculatedFromActual: Boolean(previous) };
  });
}

function renderVaccines() {
  const vaccineEntries = state.entries.filter((entry) => entry.type === "vaccine");
  const records = vaccineEntries.filter((entry) => entry.payload.status !== "planned" && entry.payload.status !== "skipped");
  const plans = vaccineEntries.filter((entry) => entry.payload.status === "planned");
  const skipped = vaccineEntries.filter((entry) => entry.payload.status === "skipped");
  const now = new Date();
  const schedule = vaccineSchedule();
  const seriesCounts = schedule.reduce((counts, item) => ({ ...counts, [item.code]: (counts[item.code] || 0) + 1 }), {});
  const scheduledHtml = schedule.filter((item) => !skipped.some((entry) => entry.payload.code === item.code && Number(entry.payload.dose || 1) === item.dose)).map((item) => {
    const record = records.find((entry) => entry.payload.code === item.code && Number(entry.payload.dose) === item.dose);
    const plan = plans.find((entry) => entry.payload.code === item.code && Number(entry.payload.dose) === item.dose);
    const dueAt = plan ? new Date(plan.occurredAt) : item.dueAt;
    const days = Math.ceil((dueAt - now) / 86400000);
    const status = record ? "done" : days < 0 ? "due" : days <= 21 ? "soon" : "future";
    const statusText = record ? `Thực hiện ngày ${formatDate(record.occurredAt)}` : plan ? `Đã đổi lịch • dự kiến ${formatDate(dueAt)}` : days < 0 ? "Đã đến lịch, ba mẹ kiểm tra lại nhé" : days === 0 ? "Dự kiến hôm nay" : `Dự kiến ${formatDate(dueAt)}`;
    const doseLabel = seriesCounts[item.code] > 1 ? ` • mũi ${item.dose}` : "";
    const actions = record
      ? `<button class="mini-button" type="button" data-edit="${record.id}">Sửa thông tin</button>`
      : `<button class="mini-button primary" type="button" data-vaccine-action="done" data-vaccine-code="${item.code}" data-vaccine-dose="${item.dose}" data-vaccine-date="${toLocalInput(new Date())}">Ghi đã tiêm/uống</button><button class="mini-button" type="button" data-vaccine-action="planned" data-vaccine-code="${item.code}" data-vaccine-dose="${item.dose}" data-vaccine-date="${toLocalInput(dueAt)}">Đổi lịch</button><button class="mini-button" type="button" data-vaccine-action="skipped" data-vaccine-code="${item.code}" data-vaccine-dose="${item.dose}">BỎ QUA</button>`;
    return `<article class="vaccine-item"><span class="vaccine-status ${status}"></span><div class="vaccine-item-main"><div class="vaccine-item-head"><h3>${escapeHtml(VACCINE_NAMES[item.code])}${doseLabel}</h3>${record ? '<span class="vaccine-done-badge">✓ ĐÃ TIÊM</span>' : `<time>${formatMonthYear(dueAt)}</time>`}</div><p>${escapeHtml(statusText)}${item.recalculatedFromActual && !record && !plan ? " • Đã tính lại từ lần thực tế trước" : ""}${item.note ? ` • ${escapeHtml(item.note)}` : ""}</p><div class="vaccine-actions">${actions}${plan ? `<button class="mini-button" type="button" data-edit="${plan.id}">Sửa lịch đã đổi</button>` : ""}</div></div></article>`;
  }).join("");

  const customRecords = vaccineEntries.filter((entry) => entry.payload.code === "other" || entry.payload.customName);
  const upcomingCustom = customRecords.filter((entry) => entry.payload.nextDoseAt).sort((a, b) => new Date(a.payload.nextDoseAt) - new Date(b.payload.nextDoseAt));
  const regularCustom = customRecords.filter((entry) => !entry.payload.nextDoseAt);
  const customCard = (entry, upcoming = false) => {
    const planned = entry.payload.status === "planned";
    const name = entry.payload.customName || "Vắc-xin khác";
    const nextAt = entry.payload.nextDoseAt ? new Date(entry.payload.nextDoseAt) : null;
    const nextDays = nextAt ? Math.ceil((nextAt - now) / 86400000) : null;
    const nextStatus = nextAt ? (nextDays < 0 ? "due" : nextDays <= 21 ? "soon" : "future") : (planned ? "future" : "done");
    return `<article class="vaccine-item"><span class="vaccine-status ${nextStatus}"></span><div class="vaccine-item-main"><div class="vaccine-item-head"><h3>${escapeHtml(name)}${Number(entry.payload.dose) > 1 ? ` • mũi ${entry.payload.dose}` : ""}</h3>${planned ? `<time>${formatMonthYear(entry.occurredAt)}</time>` : '<span class="vaccine-done-badge">✓ ĐÃ TIÊM</span>'}</div><p>${planned ? `Dự kiến ${formatDate(entry.occurredAt)}` : `Thực hiện ngày ${formatDate(entry.occurredAt)}`}${nextAt ? ` • Đợt tiêm kế tiếp: ${formatDate(nextAt)}` : ""}</p><div class="vaccine-actions"><button class="mini-button" type="button" data-edit="${entry.id}">${upcoming ? "Cập nhật đợt kế tiếp" : "Sửa thông tin"}</button></div></div></article>`;
  };
  const upcomingHtml = upcomingCustom.length ? `<p class="custom-vaccine-label">ĐỢT TIÊM KẾ TIẾP</p>${upcomingCustom.map((entry) => customCard(entry, true)).join("")}` : "";
  const customHtml = regularCustom.length ? `<p class="custom-vaccine-label">VẮC-XIN BỔ SUNG</p>${regularCustom.map((entry) => customCard(entry)).join("")}` : "";

  $("#vaccine-list").innerHTML = upcomingHtml + scheduledHtml + customHtml;
}

async function skipVaccineReminder(button) {
  const code = button.dataset.vaccineCode;
  const dose = Number(button.dataset.vaccineDose || 1);
  const label = `${VACCINE_NAMES[code] || "Lịch tiêm"}${SINGLE_DOSE_VACCINES.has(code) ? "" : ` • mũi ${dose}`}`;
  if (!window.confirm(`Ẩn ${label} khỏi danh sách nhắc hẹn?`)) return;
  const now = new Date().toISOString();
  const existing = state.entries.find((entry) => entry.type === "vaccine" && entry.payload.status === "skipped" && entry.payload.code === code && Number(entry.payload.dose || 1) === dose);
  await saveEntry({
    id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: "vaccine",
    occurredAt: now,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    payload: { code, dose, status: "skipped" },
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || state.user,
    updatedAt: now,
    updatedBy: state.user,
    version: (existing?.version || 0) + 1,
    deleted: false,
    syncStatus: "pending",
  });
  await refreshData();
  showToast("Đã ẩn khỏi danh sách nhắc hẹn");
  scheduleSync();
}

function renderReport() {
  const from = new Date();
  from.setDate(from.getDate() - 6);
  from.setHours(0, 0, 0, 0);
  const recent = state.entries.filter((entry) => new Date(entry.occurredAt) >= from);
  const feed = sum(recent.filter((entry) => entry.type === "feed"), (entry) => entry.payload.amount || 0);
  const pump = sum(recent.filter((entry) => entry.type === "pump"), (entry) => entry.payload.amount || 0);
  const poo = recent.filter((entry) => entry.type === "poo").length;
  $("#report-summary").innerHTML = `<div><strong>${feed}</strong><small>ml bé đã uống</small></div><div><strong>${pump}</strong><small>ml mẹ đã hút</small></div><div><strong>${poo}</strong><small>lần vệ sinh</small></div>`;
}

function renderActiveBottles() {
  if (!state.user) return;
  const now = Date.now();
  const bottles = state.entries.filter((entry) => {
    if (entry.type !== "feed" || !entry.payload.leftover || entry.payload.discardedAt) return false;
    const touched = new Date(entry.payload.touchedAt || entry.occurredAt).getTime();
    return now - touched < 12 * 3600000;
  });
  const section = $("#active-bottles-section");
  section.classList.toggle("hidden", !bottles.length);
  $("#active-bottles").innerHTML = bottles.map((entry) => {
    const deadline = bottleDeadline(entry);
    const remaining = deadline - now;
    const expired = remaining <= 0;
    const milk = entry.payload.milkType === "formula" ? "Sữa công thức" : entry.payload.milkType === "mixed" ? "Sữa trộn" : "Sữa mẹ";
    return `<article class="bottle-card"><div><h3>${milk} • còn ${entry.payload.leftover} ml</h3><p>${expired ? "Đã quá thời gian dùng an toàn" : `Bé chạm miệng lúc ${formatShortTime(entry.payload.touchedAt)}`}<button class="discard-button" type="button" data-discard="${entry.id}">Bỏ bình này</button></p></div><div class="bottle-clock ${expired ? "expired" : ""}"><small>${expired ? "Trạng thái" : "Còn lại"}</small><strong>${expired ? "Nên bỏ" : formatCountdown(remaining)}</strong></div></article>`;
  }).join("");
}

function bottleDeadline(entry) {
  const payload = entry.payload;
  if (payload.milkType === "breast") {
    return new Date(payload.endedAt || payload.touchedAt || entry.occurredAt).getTime() + 120 * 60000;
  }
  return new Date(payload.touchedAt || entry.occurredAt).getTime() + 60 * 60000;
}

async function discardBottle(id) {
  const entry = await getEntry(id);
  if (!entry) return;
  await saveEntry({ ...entry, payload: { ...entry.payload, discardedAt: new Date().toISOString() }, updatedAt: new Date().toISOString(), updatedBy: state.user, version: (entry.version || 1) + 1, syncStatus: "pending" });
  await refreshData();
  scheduleSync();
}

function openSheet(type, entry = null, preset = {}) {
  state.sheetType = type;
  state.editingId = entry?.id || null;
  const titles = {
    feed: ["CỮ SỮA", entry ? "Sửa cữ bé uống" : "Bé vừa uống"],
    pump: ["SỮA MẸ", entry ? "Sửa lần hút sữa" : "Mẹ vừa hút sữa"],
    poo: ["VỆ SINH CÁ NHÂN", entry ? "Sửa lần đi Poo" : "Ghi một lần đi Poo"],
    sleep: ["GIẤC NGỦ", entry ? "Sửa giấc ngủ" : "Ghi một giấc ngủ"],
    growth: ["LỚN LÊN", entry ? "Sửa số đo" : "Thêm số đo"],
    vaccine: ["BẢO VỆ BÉ", entry ? "Sửa thông tin tiêm chủng" : preset.status === "planned" ? "Điều chỉnh lịch dự kiến" : "Ghi lần đã tiêm hoặc uống"],
  };
  $("#sheet-eyebrow").textContent = titles[type][0];
  $("#sheet-title").textContent = titles[type][1];
  $("#entry-form").innerHTML = formTemplate(type, entry, preset);
  $("#entry-form").addEventListener("submit", saveFormEntry);
  $("#sheet-backdrop").classList.remove("hidden");
  $("#form-sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (type === "vaccine") updateVaccineFormVisibility();
  setTimeout(() => $("#entry-form input:not([type=hidden]), #entry-form select")?.focus(), 80);
}

function closeSheet() {
  $("#sheet-backdrop").classList.add("hidden");
  $("#form-sheet").classList.add("hidden");
  document.body.style.overflow = "";
  state.editingId = null;
  state.sheetType = null;
}

function formTemplate(type, entry, preset = {}) {
  const payload = { ...preset, ...(entry?.payload || {}) };
  const occurred = toLocalInput(entry?.occurredAt || preset.occurredAt || new Date());
  const deleteAction = entry ? `<button class="button soft full" type="button" data-delete-entry="${entry.id}">Xóa bản ghi này</button>` : "";
  if (type === "feed") {
    const amount = payload.amount || 0;
    const quick = [30, 60, 90, 120, 150, 180, 210];
    return `
      <fieldset><legend>Loại sữa</legend><div class="choice-grid">${choice("milkType", "breast", "Sữa mẹ", payload.milkType === "breast" || !payload.milkType)}${choice("milkType", "formula", "Sữa công thức", payload.milkType === "formula")}${choice("milkType", "mixed", "Bình trộn", payload.milkType === "mixed")}</div></fieldset>
      <fieldset><legend>Lượng bé đã uống</legend><input id="feed-amount" name="amount" type="hidden" value="${amount}"><div class="amount-grid">${quick.map((value) => `<button class="choice-label ${amount === value ? "amount-selected" : ""}" type="button" data-amount="${value}">${value} ml</button>`).join("")}<button class="choice-label ${amount && !quick.includes(Number(amount)) ? "amount-selected" : ""}" type="button" data-amount="custom">Nhập tay</button></div></fieldset>
      <label id="custom-amount-label" class="${amount && !quick.includes(Number(amount)) ? "" : "hidden"}">Nhập lượng (ml)<input id="custom-amount" type="number" min="1" max="1000" inputmode="decimal" value="${amount && !quick.includes(Number(amount)) ? amount : ""}"></label>
      <label>Lượng còn lại trong bình (ml)<input name="leftover" type="number" min="0" max="1000" inputmode="decimal" value="${payload.leftover || 0}"></label>
      <div class="field-row"><label>Bắt đầu chạm miệng<input name="touchedAt" type="datetime-local" value="${toLocalInput(payload.touchedAt || entry?.occurredAt || new Date())}" required></label><label>Kết thúc cữ<input name="endedAt" type="datetime-local" value="${toLocalInput(payload.endedAt || entry?.occurredAt || new Date())}" required></label></div>
      <p class="field-help">Sữa công thức/bình trộn: 60 phút từ lúc bắt đầu bú. Sữa mẹ còn lại: 2 giờ sau khi kết thúc cữ.</p>
      <label>Ghi chú<textarea name="note" rows="2" placeholder="Ọc, trớ hoặc điều cần nhớ…">${escapeHtml(payload.note || "")}</textarea></label>
      <button class="button primary full" type="submit">${entry ? "Lưu thay đổi" : "Lưu cữ sữa"}</button>${deleteAction}`;
  }
  if (type === "pump") return `<label>Lượng sữa mẹ hút được (ml)<input name="amount" type="number" min="1" max="2000" inputmode="decimal" value="${payload.amount || ""}" required></label><label>Thời gian hút sữa<input name="occurredAt" type="datetime-local" value="${occurred}" required></label><label class="check-card"><input name="isLastPump" type="checkbox" ${payload.isLastPump ? "checked" : ""}><span><strong>Đây là cữ hút cuối hôm nay</strong><small>Đánh dấu để cả nhà chúc mừng mẹ Quyên nhé!</small></span></label><label>Ghi chú<textarea name="note" rows="2">${escapeHtml(payload.note || "")}</textarea></label><button class="button primary full" type="submit">Lưu cữ hút sữa</button>${deleteAction}`;
  if (type === "poo") return `<fieldset><legend>Màu phân</legend><div class="choice-grid">${["Vàng", "Xanh", "Nâu", "Đen", "Đỏ", "Trắng/nhạt", "Màu khác"].map((value) => choice("color", value, value, payload.color === value || (!payload.color && value === "Vàng"))).join("")}</div></fieldset><fieldset><legend>Dạng phân</legend><div class="choice-grid">${["Lỏng", "Hơi lỏng", "Sệt", "Thành khuôn", "Cứng"].map((value) => choice("consistency", value, value, payload.consistency === value || (!payload.consistency && value === "Sệt"))).join("")}</div></fieldset><label>Thời gian<input name="occurredAt" type="datetime-local" value="${occurred}" required></label><label>Ghi chú<textarea name="note" rows="2">${escapeHtml(payload.note || "")}</textarea></label><button class="button primary full" type="submit">Lưu lần vệ sinh</button>${deleteAction}`;
  if (type === "sleep") return `<div class="field-row"><label>Bắt đầu<input name="startedAt" type="datetime-local" value="${toLocalInput(payload.startedAt || new Date(Date.now() - 60 * 60000))}" required></label><label>Kết thúc<input name="endedAt" type="datetime-local" value="${toLocalInput(payload.endedAt || new Date())}" required></label></div><label>Ghi chú<textarea name="note" rows="2">${escapeHtml(payload.note || "")}</textarea></label><button class="button primary full" type="submit">Lưu giấc ngủ</button>${deleteAction}`;
  if (type === "growth") return `<div class="field-row"><label>Cân nặng (kg)<input name="weight" type="number" min="0.5" max="40" step="0.01" inputmode="decimal" value="${payload.weight || ""}"></label><label>Chiều dài (cm)<input name="length" type="number" min="20" max="150" step="0.1" inputmode="decimal" value="${payload.length || ""}"></label></div><label>Vòng đầu (cm)<input name="head" type="number" min="20" max="80" step="0.1" inputmode="decimal" value="${payload.head || ""}"></label><label>Thời gian đo<input name="occurredAt" type="datetime-local" value="${occurred}" required></label><label>Nơi đo / ghi chú<input name="note" value="${escapeHtml(payload.note || "")}"></label><button class="button primary full" type="submit">Lưu số đo</button>${deleteAction}`;
  if (type === "vaccine") return `
    <label>Trạng thái<select id="vaccine-status" name="status"><option value="done" ${payload.status !== "planned" ? "selected" : ""}>Đã tiêm hoặc uống</option><option value="planned" ${payload.status === "planned" ? "selected" : ""}>Chỉ điều chỉnh lịch dự kiến</option></select></label>
    <label>Loại vắc-xin<select id="vaccine-code" name="code">${Object.entries(VACCINE_NAMES).filter(([code]) => !HIDDEN_VACCINE_CODES.has(code)).map(([code, name]) => `<option value="${code}" ${payload.code === code ? "selected" : ""}>${name}</option>`).join("")}</select></label>
    <label id="custom-vaccine-name" class="${payload.code === "other" ? "" : "hidden"}">Tên vắc-xin bổ sung<input name="customName" value="${escapeHtml(payload.customName || "")}" placeholder="Ví dụ: COVID-19"></label>
    <label id="custom-vaccine-next" class="${payload.code === "other" ? "" : "hidden"}">Đợt tiêm kế tiếp<input name="nextDoseAt" type="date" value="${payload.nextDoseAt ? toLocalInput(payload.nextDoseAt).slice(0, 10) : ""}"><small>Nhập ngày dự kiến; lịch này sẽ tự được đưa lên đầu danh sách.</small></label>
    <div class="field-row"><label id="vaccine-dose-field" class="${SINGLE_DOSE_VACCINES.has(payload.code) ? "hidden" : ""}">Mũi số<input name="dose" type="number" min="1" max="20" value="${payload.dose || 1}"></label><label><span id="vaccine-date-label">${payload.status === "planned" ? "Ngày giờ dự kiến" : "Ngày giờ thực tế"}</span><input name="occurredAt" type="datetime-local" value="${occurred}" required></label></div>
    <div id="vaccine-completed-fields" class="stack"><label>Tên sản phẩm (nếu biết)<input name="productName" value="${escapeHtml(payload.productName || "")}" placeholder="Ví dụ: Rotavin, RotaTeq…"></label><label>Nơi tiêm hoặc uống<input name="place" value="${escapeHtml(payload.place || "")}"></label><label>Phản ứng hoặc ghi chú<textarea name="note" rows="2">${escapeHtml(payload.note || "")}</textarea></label></div>
    <button class="button primary full" type="submit">${payload.status === "planned" ? "Lưu lịch dự kiến" : "Lưu thông tin tiêm chủng"}</button>${deleteAction}`;
  return "";
}

function updateVaccineFormVisibility() {
  const code = $("#vaccine-code")?.value;
  const planned = $("#vaccine-status")?.value === "planned";
  $("#custom-vaccine-name")?.classList.toggle("hidden", code !== "other");
  $("#custom-vaccine-next")?.classList.toggle("hidden", code !== "other");
  $("#vaccine-dose-field")?.classList.toggle("hidden", SINGLE_DOSE_VACCINES.has(code));
  if (SINGLE_DOSE_VACCINES.has(code)) $("#vaccine-dose-field input").value = "1";
  $("#vaccine-completed-fields")?.classList.toggle("hidden", planned);
  if ($("#vaccine-date-label")) $("#vaccine-date-label").textContent = planned ? "Ngày giờ dự kiến" : "Ngày giờ thực tế";
  const submit = $("#entry-form button[type=submit]");
  if (submit) submit.textContent = planned ? "Lưu lịch dự kiến" : "Lưu thông tin tiêm chủng";
}

function choice(name, value, label, checked) {
  const id = `${name}-${slug(value)}-${Math.random().toString(16).slice(2, 7)}`;
  return `<input class="choice-input" id="${id}" type="radio" name="${name}" value="${escapeHtml(value)}" ${checked ? "checked" : ""}><label class="choice-label" for="${id}">${escapeHtml(label)}</label>`;
}

function selectAmount(button) {
  $$("[data-amount]", $("#entry-form")).forEach((item) => item.classList.remove("amount-selected"));
  button.classList.add("amount-selected");
  const custom = button.dataset.amount === "custom";
  $("#custom-amount-label").classList.toggle("hidden", !custom);
  if (custom) {
    $("#feed-amount").value = "";
    $("#custom-amount").focus();
  } else {
    $("#feed-amount").value = button.dataset.amount;
    $("#custom-amount").value = "";
  }
}

async function saveFormEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  let existing = state.editingId ? await getEntry(state.editingId) : null;
  const now = new Date().toISOString();
  let occurredAt = fromLocalInput(data.get("occurredAt") || data.get("touchedAt") || data.get("startedAt"));
  let payload;
  let vaccinePlanToRemove = null;

  if (state.sheetType === "feed") {
    const amount = Number(data.get("amount") || $("#custom-amount")?.value || 0);
    if (!amount) return showToast("Hãy chọn hoặc nhập lượng sữa bé đã uống.");
    payload = { milkType: data.get("milkType"), amount, leftover: Number(data.get("leftover") || 0), touchedAt: fromLocalInput(data.get("touchedAt")), endedAt: fromLocalInput(data.get("endedAt")), note: data.get("note")?.trim() || "", discardedAt: existing?.payload?.discardedAt || null };
    occurredAt = payload.touchedAt;
  } else if (state.sheetType === "pump") {
    payload = { amount: Number(data.get("amount")), isLastPump: data.get("isLastPump") === "on", note: data.get("note")?.trim() || "" };
  } else if (state.sheetType === "poo") {
    payload = { color: data.get("color"), consistency: data.get("consistency"), note: data.get("note")?.trim() || "" };
  } else if (state.sheetType === "sleep") {
    const startedAt = fromLocalInput(data.get("startedAt"));
    const endedAt = fromLocalInput(data.get("endedAt"));
    const durationMinutes = Math.round((new Date(endedAt) - new Date(startedAt)) / 60000);
    if (durationMinutes <= 0) return showToast("Giờ kết thúc cần sau giờ bắt đầu.");
    occurredAt = startedAt;
    payload = { startedAt, endedAt, durationMinutes, note: data.get("note")?.trim() || "" };
  } else if (state.sheetType === "growth") {
    payload = { weight: numberOrNull(data.get("weight")), length: numberOrNull(data.get("length")), head: numberOrNull(data.get("head")), note: data.get("note")?.trim() || "" };
    if (!payload.weight && !payload.length && !payload.head) return showToast("Hãy nhập ít nhất một số đo.");
  } else if (state.sheetType === "vaccine") {
    const code = data.get("code");
    const status = data.get("status") === "planned" ? "planned" : "done";
    const customName = data.get("customName")?.trim() || "";
    if (code === "other" && !customName) return showToast("Hãy nhập tên vắc-xin bổ sung.");
    const dose = SINGLE_DOSE_VACCINES.has(code) ? 1 : Number(data.get("dose") || 1);
    const nextDoseAt = code === "other" && data.get("nextDoseAt") ? fromLocalInput(`${data.get("nextDoseAt")}T09:00`) : null;
    payload = { code, dose, status, customName, nextDoseAt, productName: data.get("productName")?.trim() || "", place: data.get("place")?.trim() || "", note: data.get("note")?.trim() || "" };
    if (!existing) {
      existing = state.entries.find((entry) => entry.type === "vaccine"
        && entry.payload.code === code
        && Number(entry.payload.dose || 1) === dose
        && (entry.payload.status === "planned" ? "planned" : "done") === status
        && (code !== "other" || (entry.payload.customName || "").toLowerCase() === customName.toLowerCase())) || null;
    }
    if (status === "done") {
      vaccinePlanToRemove = state.entries.find((entry) => entry.type === "vaccine"
        && entry.id !== existing?.id
        && entry.payload.status === "planned"
        && entry.payload.code === code
        && Number(entry.payload.dose || 1) === dose
        && (code !== "other" || (entry.payload.customName || "").toLowerCase() === customName.toLowerCase())) || null;
    }
  }

  const entry = {
    id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: state.sheetType,
    occurredAt,
    timezoneOffsetMinutes: -new Date(occurredAt).getTimezoneOffset(),
    payload,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || state.user,
    updatedAt: now,
    updatedBy: state.user,
    version: (existing?.version || 0) + 1,
    deleted: false,
    syncStatus: "pending",
  };

  await saveEntry(entry);
  if (vaccinePlanToRemove) await softDeleteEntry(vaccinePlanToRemove.id, state.user);
  closeSheet();
  await refreshData();
  showToast(payload?.isLastPump ? "Mẹ Quyên hoàn thành ca làm sữa rồi! ♥" : existing ? "Đã lưu thay đổi" : "Đã thêm vào nhật ký");
  scheduleSync();
}

async function deleteCurrentEntry() {
  if (!state.editingId) return;
  if (!window.confirm("Xóa bản ghi này khỏi nhật ký?")) return;
  await softDeleteEntry(state.editingId, state.user);
  closeSheet();
  await refreshData();
  showToast("Đã xóa bản ghi");
  scheduleSync();
}

function scheduleSync() {
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => attemptSync(), 900);
  updateNetworkState();
}

function backgroundSync() {
  if (!state.user || !navigator.onLine || state.sheetType || document.visibilityState === "hidden") return;
  attemptSync();
}

async function attemptSync(showResult = false) {
  if (!state.user || state.syncInFlight) return;
  state.syncInFlight = true;
  try {
    const result = await syncData(state.user);
    updateNetworkState(result);
    if (result.status === "synced") {
      await refreshData();
      if (showResult) showToast("Dữ liệu đã đồng bộ");
    } else if (showResult) {
      showToast(navigator.onLine ? "Đã lưu trên máy, máy chủ đồng bộ chưa được kết nối" : "Đang offline • dữ liệu đã lưu trên máy");
    }
  } finally {
    state.syncInFlight = false;
  }
}

async function updateNetworkState(result = null) {
  if (!state.user) return;
  const pending = result?.pending ?? await pendingCount();
  const dot = $("#sync-dot");
  dot.className = "sync-dot";
  if (!navigator.onLine) {
    dot.classList.add("offline");
    $("#sync-label").textContent = pending ? `Mất mạng • ${pending} chờ` : "Mất mạng";
  } else if (result?.status === "auth") {
    dot.classList.add("pending");
    $("#sync-label").textContent = "Cần đăng nhập lại";
  } else if (result?.status === "local") {
    dot.classList.add("pending");
    $("#sync-label").textContent = "Chưa nối máy chủ";
  } else if (result?.status === "synced") {
    $("#sync-label").textContent = "Đã đồng bộ";
  } else if (pending) {
    dot.classList.add("pending");
    $("#sync-label").textContent = `${pending} chờ đồng bộ`;
  } else {
    $("#sync-label").textContent = "Đã lưu trên máy";
  }
}

function exportJson() {
  const content = JSON.stringify({ generatedAt: new Date().toISOString(), profile: PROFILE, entries: state.entries.map(stripSyncFields) }, null, 2);
  downloadFile(`hy-nhi-report-${localDateKey(new Date())}.json`, content, "application/json");
}

function exportCsv() {
  const header = ["id", "loai", "thoi_gian_thuc_te", "nguoi_nhap", "chi_tiet"];
  const rows = state.entries.map((entry) => [entry.id, entry.type, entry.occurredAt, entry.createdBy, describeEntry(entry).title + " | " + describeEntry(entry).detail]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(`hy-nhi-report-${localDateKey(new Date())}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
}

function stripSyncFields(entry) {
  const { syncStatus, ...safeEntry } = entry;
  return safeEntry;
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem("hynhi_theme", document.body.classList.contains("dark") ? "dark" : "light");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function formatAge(birth, now) {
  let months = (now.getFullYear() - birth.getFullYear()) * 12 + now.getMonth() - birth.getMonth();
  let anchor = addMonths(birth, months);
  if (anchor > now) { months -= 1; anchor = addMonths(birth, months); }
  const days = Math.max(0, Math.floor((now - anchor) / 86400000));
  return `${months} tháng ${days} ngày`;
}

function toLocalInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  return new Date(String(value)).toISOString();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: PROFILE.timezone }).format(new Date(value));
}

function formatMonthYear(value) {
  return new Intl.DateTimeFormat("vi-VN", { month: "2-digit", year: "numeric", timeZone: PROFILE.timezone }).format(new Date(value));
}

function formatShortTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: PROFILE.timezone }).format(new Date(value));
}

function formatTimelineTime(value) {
  const date = new Date(value);
  return `${localDateKey(date) === localDateKey(new Date()) ? "Hôm nay" : formatDate(date)}<br>${formatShortTime(date)}`;
}

function localDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: PROFILE.timezone }).format(date);
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} phút`;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

function formatCountdown(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} phút`;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

function numberOrNull(value) {
  return value === "" || value == null ? null : Number(value);
}

function sum(items, selector) {
  return Math.round(items.reduce((total, item) => total + Number(selector(item) || 0), 0) * 100) / 100;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function slug(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
