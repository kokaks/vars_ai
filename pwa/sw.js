const CACHE_NAME = "barbershop-shell-v1";
const SHELL_FILES = ["/", "/css/style.css", "/js/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for API calls (always want fresh appointment data), cache-first for the shell.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // let it hit the network directly
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// --- Push notifications: reminder N minutes before appointment ---
self.addEventListener("push", (event) => {
  let data = { title: "Reminder", body: "You have an upcoming appointment." };
  try {
    data = event.data.json();
  } catch (e) {
    /* fall back to default */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: data.data || {},
      tag: data.data?.appointmentId ? `appt-${data.data.appointmentId}` : undefined,
    })
  );
});

// Tapping the notification opens the app straight to that appointment.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const appointmentId = event.notification.data?.appointmentId;
  const targetUrl = appointmentId ? `/?appointment=${appointmentId}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      const existing = clientsArr.find((c) => "focus" in c);
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
