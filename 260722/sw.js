const CACHE_PREFIX = "jamkkan-matgimso";
const CACHE_VERSION = "v2";
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./logic.js",
  "./example.md",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith(`${CACHE_PREFIX}-`) && key !== CACHE_NAME
              )
              .map((key) => caches.delete(key))
          )
        ),
      self.clients.claim()
    ])
  );
});

// The app may send this only after the user accepts an available update.
// Without the message, a new worker waits until existing tabs are closed.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    request.mode === "navigate"
      ? serveNavigation(request)
      : serveCachedAsset(request)
  );
});

async function serveNavigation(request) {
  try {
    const response = await fetch(request);

    if (response.ok && isAppEntryRequest(request)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put("./index.html", response.clone());
    }

    return response;
  } catch {
    const cachedPage = await caches.match("./index.html");
    if (cachedPage) return cachedPage;

    return new Response("오프라인에서도 쓸 준비를 마치지 못했어요.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
}

function isAppEntryRequest(request) {
  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  const scopePath = scopeUrl.pathname.endsWith("/")
    ? scopeUrl.pathname
    : `${scopeUrl.pathname}/`;

  return (
    requestUrl.origin === scopeUrl.origin &&
    (requestUrl.pathname === scopePath ||
      requestUrl.pathname === `${scopePath}index.html`)
  );
}

async function serveCachedAsset(request) {
  try {
    const response = await fetch(request);

    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;
    return new Response("오프라인에서 이 파일을 찾지 못했어요.", {
      status: 504,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
}
