/**
 * PWA CLIENT
 * ----------------------------------------------------------------------------
 * MVP assumption: one barber uses this device/login (matches "barber views
 * their own day on their phone"). BARBER_ID is picked as the first active
 * barber returned by the API and cached in localStorage. For a multi-barber
 * shop where each barber has their own phone, this is exactly the right
 * model already — a shop-owner "all barbers" view is a straightforward
 * later addition (drop the barberId filter), intentionally not built here
 * to keep the MVP screen legible on a phone.
 * ----------------------------------------------------------------------------
 */
const API = "/api";
let BARBER_ID = localStorage.getItem("barberId") ? Number(localStorage.getItem("barberId")) : null;
let SERVICES = [];
let APPOINTMENTS = [];
// NOTE: day tabs are generated from the DEVICE's local date, not the shop's
// configured timezone (the client has no cheap way to know that ahead of a
// fetch). This is fine in practice since the barber's own phone is almost
// always physically in the same timezone as the shop — if that's ever not
// true for your setup, switch this to read shop.timezone from GET /api/shop
// on init and generate tab dates with that offset instead.
let SELECTED_DATE = toDateStr(new Date()); // "YYYY-MM-DD", defaults to today
const DAYS_AHEAD = 6; // Today + this many future days as tabs

const $ = (sel) => document.querySelector(sel);
const toast = (msg) => {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
};

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || body.reason || `Request failed: ${path}`);
    err.body = body;
    throw err;
  }
  return res.json();
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function dayTabLabel(dateStr, offset) {
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  $("#todayDate").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

  const barbers = await api("/barbers");
  if (!BARBER_ID) {
    BARBER_ID = barbers[0]?.id;
    localStorage.setItem("barberId", BARBER_ID);
  }
  const me = barbers.find((b) => b.id === BARBER_ID) || barbers[0];
  $("#barberName").textContent = me ? me.name : "";

  SERVICES = await api("/services");
  const walkinSelect = $("#walkinService");
  walkinSelect.innerHTML = SERVICES.map((s) => `<option value="${s.id}">${s.name} — ${s.duration_minutes}min</option>`).join("");

  await loadAppointments();
  wireEvents();
  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// Data + rendering
// ---------------------------------------------------------------------------
async function loadAppointments() {
  APPOINTMENTS = await api(`/appointments?barberId=${BARBER_ID}&from=${SELECTED_DATE}&to=${SELECTED_DATE}`);
  renderDayTabs();
  render();
}

function renderDayTabs() {
  const container = $("#dayTabs");
  const todayStr = toDateStr(new Date());
  let html = "";
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const dateStr = addDays(todayStr, i);
    const d = new Date(dateStr + "T00:00:00");
    const active = dateStr === SELECTED_DATE ? "active" : "";
    html += `
      <div class="day-tab ${active}" data-date="${dateStr}">
        <span class="label">${dayTabLabel(dateStr, i)}</span>
        <span class="num">${d.getDate()}</span>
      </div>`;
  }
  container.innerHTML = html;
  container.querySelectorAll(".day-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      SELECTED_DATE = tab.dataset.date;
      loadAppointments();
    })
  );
}

function render() {
  const isToday = SELECTED_DATE === toDateStr(new Date());
  const now = new Date();
  const upcoming = APPOINTMENTS.filter((a) => a.status === "confirmed" && new Date(a.start_local) >= now)
    .sort((a, b) => new Date(a.start_local) - new Date(b.start_local));

  if (isToday) {
    renderNextUp(upcoming[0]);
  } else {
    renderFutureDaySummary();
  }
  renderList();

  $("#listLabel").textContent = isToday ? "Today" : dayTabLabel(SELECTED_DATE, 1) === "Tomorrow" ? "Tomorrow" : new Date(SELECTED_DATE + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  $("#walkinBtn").style.display = isToday ? "flex" : "none";
}

function renderFutureDaySummary() {
  const el = $("#nextUp");
  const confirmed = APPOINTMENTS.filter((a) => a.status === "confirmed").sort((a, b) => new Date(a.start_local) - new Date(b.start_local));
  if (confirmed.length === 0) {
    el.className = "next-up empty";
    el.innerHTML = "Nothing booked this day yet.";
    return;
  }
  el.className = "next-up";
  const dayLabel = new Date(SELECTED_DATE + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  el.innerHTML = `
    <div class="eyebrow">${dayLabel}</div>
    <div class="time">${confirmed.length}</div>
    <div class="client">appointment${confirmed.length === 1 ? "" : "s"} booked</div>
    <div class="service">First at ${fmtTime(confirmed[0].start_local)} — ${escapeHtml(confirmed[0].client_name || "Walk-in")}</div>
  `;
}

function renderNextUp(appt) {
  const el = $("#nextUp");
  if (!appt) {
    el.className = "next-up empty";
    el.innerHTML = "No more appointments today.";
    return;
  }
  el.className = "next-up";
  const minsAway = Math.round((new Date(appt.start_local) - new Date()) / 60000);
  const away = minsAway <= 0 ? "now" : minsAway < 60 ? `in ${minsAway} min` : `at ${fmtTime(appt.start_local)}`;
  el.innerHTML = `
    <div class="eyebrow">Next up · ${away}</div>
    <div class="time">${fmtTime(appt.start_local)}</div>
    <div class="client">${escapeHtml(appt.client_name || "Walk-in")}</div>
    <div class="service">${escapeHtml(appt.service_label)}${appt.phone_number ? " · " + appt.phone_number : ""}</div>
    ${appt.client_tags?.includes("returning") ? '<span class="tag">Returning</span>' : ""}
    ${appt.client_tags?.includes("at_risk") ? '<span class="tag" style="color:#A85C4A;background:rgba(168,92,74,0.15)">At risk</span>' : ""}
  `;
}

function renderList() {
  const list = $("#apptList");
  const sorted = [...APPOINTMENTS].sort((a, b) => new Date(a.start_local) - new Date(b.start_local));

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty-state">Nothing booked today yet. New calls will show up here automatically.</div>';
    return;
  }

  list.innerHTML = sorted
    .map((a) => {
      const statusClass = a.status === "completed" ? "completed" : a.status === "cancelled" ? "cancelled" : a.status === "no_show" ? "cancelled" : "";
      const walkinClass = a.source === "walkin" ? "walkin" : "";
      const actions =
        a.status === "confirmed"
          ? `<button class="done" data-action="complete" data-id="${a.id}" title="Mark done">✓</button>
             <button data-action="detail" data-id="${a.id}" title="Details">i</button>`
          : `<button data-action="detail" data-id="${a.id}" title="Details">i</button>`;

      return `
        <div class="appt-row ${statusClass} ${walkinClass}" data-id="${a.id}">
          <div class="t">${fmtTime(a.start_local)}</div>
          <div class="info">
            <div class="name">${escapeHtml(a.client_name || "Walk-in")}</div>
            <div class="svc">${escapeHtml(a.service_label)}</div>
            ${a.source === "walkin" ? '<div class="badge">Walk-in</div>' : ""}
          </div>
          <div class="actions">${actions}</div>
        </div>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function completeAppointment(id) {
  await api(`/appointments/${id}/complete`, { method: "POST" });
  const row = document.querySelector(`.appt-row[data-id="${id}"]`);
  if (row) row.classList.add("completed"); // instant feedback, animation runs via CSS
  await loadAppointments();
  toast("Marked done ✓");
}

async function showDetail(id) {
  const appt = await api(`/appointments/${id}`);
  const sheet = $("#detailSheet");
  sheet.innerHTML = `
    <h2>${fmtTime(appt.start_local)} — ${escapeHtml(appt.client_name || "Walk-in")}</h2>
    <div class="row"><label>Service</label><div>${escapeHtml(appt.service_label)} · ${appt.price_amd} AMD</div></div>
    ${appt.phone_number ? `<div class="row"><label>Phone</label><div>${appt.phone_number}</div></div>` : ""}
    ${appt.client_notes ? `<div class="row"><label>Notes</label><div>${escapeHtml(appt.client_notes)}</div></div>` : ""}
    <div class="row"><label>Status</label><div>${appt.status}${appt.source === "walkin" ? " · walk-in" : ""}</div></div>
    ${
      appt.status === "confirmed"
        ? `<button class="primary-btn" data-action="noshow" data-id="${appt.id}">Mark no-show</button>
           <button class="cancel-link" data-action="cancel" data-id="${appt.id}" style="color:#A85C4A">Cancel appointment</button>`
        : ""
    }
    <button class="cancel-link" data-close="detailBackdrop">Close</button>
  `;
  openSheet("detailBackdrop");
}

// ---------------------------------------------------------------------------
// Walk-in flow
// ---------------------------------------------------------------------------
async function submitWalkin() {
  const serviceId = Number($("#walkinService").value);
  const name = $("#walkinName").value.trim() || "Walk-in";
  try {
    const result = await api("/walkins", {
      method: "POST",
      body: JSON.stringify({ barberId: BARBER_ID, serviceId, name }),
    });
    closeSheet("walkinBackdrop");
    $("#walkinName").value = "";
    await loadAppointments();
    if (result.advisory) {
      toast(result.advisory.message);
    } else {
      toast("Walk-in added ✓");
    }
  } catch (err) {
    toast(describeWalkinError(err));
  }
}

// Turns a raw {reason, detail} failure into something a barber can actually
// act on, instead of a bare code like "during_break". If this fires when
// you don't expect it to, check GET /api/debug/now?barberId=X — it shows
// exactly what time/weekday the server computed and why.
function describeWalkinError(err) {
  const body = err.body || {};
  const reason = body.reason;
  const detail = body.detail || {};
  const startLocal = detail.startUtc ? new Date(detail.startUtc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const endLocal = detail.endUtc ? new Date(detail.endUtc).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const svc = detail.resolved?.label;

  switch (reason) {
    case "during_break":
      return `Can't add — a ${svc || "service"} from ${startLocal}–${endLocal} would run into "${detail.detail || "a break"}". Try a shorter service or wait until after the break.`;
    case "outside_working_hours":
      return `Can't add — ${startLocal}–${endLocal} falls outside working hours.`;
    case "day_off":
      return `Can't add — barber has the day off${detail.detail ? `: ${detail.detail}` : ""}.`;
    case "conflict":
      return "Can't add — that would overlap another appointment.";
    default:
      return `Couldn't add walk-in: ${reason || err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function openSettings() {
  const { barber } = await api(`/barbers/${BARBER_ID}/settings`);
  $("#bufferInput").value = barber.buffer_minutes ?? "";
  $("#reminderInput").value = barber.notification_lead_minutes ?? "";
  openSheet("settingsBackdrop");
}

async function saveSettings() {
  await api(`/barbers/${BARBER_ID}/settings`, {
    method: "PUT",
    body: JSON.stringify({
      bufferMinutes: $("#bufferInput").value ? Number($("#bufferInput").value) : null,
      notificationLeadMinutes: $("#reminderInput").value ? Number($("#reminderInput").value) : null,
    }),
  });
  closeSheet("settingsBackdrop");
  toast("Settings saved");
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("/sw.js");
}

async function enablePush() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    toast("Push not supported on this device/browser.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Notifications were not enabled.");
    return;
  }
  const { publicKey } = await api("/push/vapid-public-key");
  if (!publicKey) {
    toast("Server push isn't configured yet (VAPID keys missing) — notifications will just log server-side for now.");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api(`/barbers/${BARBER_ID}/push-subscription`, { method: "POST", body: JSON.stringify(sub) });
  toast("Reminders enabled on this device ✓");
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Sheets + event wiring
// ---------------------------------------------------------------------------
function openSheet(id) { $(`#${id}`).classList.add("open"); }
function closeSheet(id) { $(`#${id}`).classList.remove("open"); }

function wireEvents() {
  $("#walkinBtn").addEventListener("click", () => openSheet("walkinBackdrop"));
  $("#walkinConfirm").addEventListener("click", submitWalkin);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#saveSettingsBtn").addEventListener("click", saveSettings);
  $("#enablePushBtn").addEventListener("click", enablePush);

  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => closeSheet(btn.dataset.close))
  );
  document.querySelectorAll(".sheet-backdrop").forEach((backdrop) =>
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("open");
    })
  );

  $("#apptList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "complete") completeAppointment(id);
    if (btn.dataset.action === "detail") showDetail(id);
  });

  $("#detailSheet").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "noshow") {
      await api(`/appointments/${id}/no_show`, { method: "POST" });
      closeSheet("detailBackdrop");
      await loadAppointments();
      toast("Marked as no-show");
    }
    if (btn.dataset.action === "cancel") {
      await api(`/appointments/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason: "barber_cancelled" }) });
      closeSheet("detailBackdrop");
      await loadAppointments();
      toast("Appointment cancelled");
    }
  });

  // Periodic refresh so a booking made by the AI mid-shift shows up without a manual pull.
  setInterval(loadAppointments, 30_000);

  // Deep-link from a tapped notification: /?appointment=123
  const params = new URLSearchParams(location.search);
  if (params.get("appointment")) {
    showDetail(params.get("appointment"));
  }
}

init().catch((err) => {
  console.error(err);
  toast("Couldn't load — check the backend is running.");
});
