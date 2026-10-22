const appOrigin = "https://chibichara-studio-prototype.onrender.com";
const requestedPath = new URLSearchParams(location.search).get("next");
const destination = new URL(["/avatar", "/voice", "/movie"].includes(requestedPath) ? requestedPath : "/avatar", appOrigin);
const status = document.getElementById("status");
const description = document.getElementById("description");
const spinner = document.getElementById("spinner");
const retry = document.getElementById("retry");
let deadline = 0;
let timer;
let controller;
let stopped = false;

async function check() {
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(new URL("/api/ready", appOrigin), {
      cache: "no-store", credentials: "omit", signal: controller.signal,
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      if (!stopped && data.ready === true && data.service === "chibichara-studio") {
        location.replace(destination.href);
        return;
      }
    }
  } catch {
    // Startup pages, CORS failures and network timeouts are retried while the page is open.
  } finally {
    clearTimeout(timeout);
  }
  if (stopped) return;
  if (Date.now() >= deadline) {
    status.textContent = "接続に時間がかかっています";
    description.textContent = "少し待ってから、もう一度お試しください。";
    spinner.hidden = true;
    retry.disabled = false;
    retry.hidden = false;
    return;
  }
  timer = setTimeout(check, 4000);
}

function start() {
  stopped = false;
  deadline = Date.now() + 120000;
  retry.hidden = true;
  retry.disabled = true;
  spinner.hidden = false;
  status.textContent = "読み込み中…";
  description.textContent = "アプリの準備をしています。初回は約1分かかることがあります。このままお待ちください。";
  void check();
}

retry.addEventListener("click", start);
window.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(timer);
  controller?.abort();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) start(); });
start();
