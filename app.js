// Register the service worker so the portal can be installed and opens offline
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

// Page text in each language. Albanian is the default; the choice is remembered on the phone.
// Albanian wording is a draft: have a native speaker check it.
const TRANSLATIONS = {
  sq: {
    home_title: "Berati Ndan Mbetjet",
    resident: "Banor",
    employee: "Punonjës",
    bcg: "BCG / Bashkia",
    report_problem: "Raporto një problem",
    nearest_bins: "Koshat më të afërt (së shpejti)",
    location_check: "Kontrolli i koshave",
    lock: "Kyç",
    open_dashboards: "Shiko të dhënat",
  },
  en: {
    home_title: "Berat Waste",
    resident: "Resident",
    employee: "Employee",
    bcg: "BCG / Municipality",
    report_problem: "Report a problem",
    nearest_bins: "Nearest bins (coming soon)",
    location_check: "Location check",
    lock: "Lock",
    open_dashboards: "Open dashboards",
  },
};
const LANG_KEY = "language";

function applyLanguage(lang) {
  const text = TRANSLATIONS[lang];
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = text[el.dataset.i18n];
  });
  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.classList.toggle("active", button.dataset.lang === lang);
  });
}

applyLanguage(localStorage.getItem(LANG_KEY) || "sq");
document.querySelectorAll("[data-lang]").forEach((button) => {
  button.addEventListener("click", () => {
    localStorage.setItem(LANG_KEY, button.dataset.lang);
    applyLanguage(button.dataset.lang);
  });
});

// SHA-256 of the employee PIN (test PIN is 1111). To change the PIN, replace this
// with the SHA-256 of the new PIN; the PIN itself never appears in the code.
const EMPLOYEE_PIN_HASH = "0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c";
const UNLOCK_KEY = "employeeUnlocked";

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showEmployeeLinks(show) {
  document.getElementById("pin-screen").hidden = show;
  document.getElementById("employee-links").hidden = !show;
}

function setupPinPad() {
  let entered = "";
  const dots = document.getElementById("pin-dots");
  const render = () => { dots.textContent = "•".repeat(entered.length); };

  // The phone remembers a correct PIN, so workers enter it once
  showEmployeeLinks(localStorage.getItem(UNLOCK_KEY) === "yes");

  document.querySelectorAll("[data-digit]").forEach((button) => {
    button.addEventListener("click", () => {
      if (entered.length < 8) { entered += button.dataset.digit; }
      dots.classList.remove("wrong");
      render();
    });
  });

  document.getElementById("pin-clear").addEventListener("click", () => { entered = ""; render(); });

  document.getElementById("pin-enter").addEventListener("click", async () => {
    if ((await sha256(entered)) === EMPLOYEE_PIN_HASH) {
      localStorage.setItem(UNLOCK_KEY, "yes");
      showEmployeeLinks(true);
      dots.textContent = "";
    } else {
      dots.textContent = "✕";
      dots.classList.add("wrong");
    }
    entered = "";
  });

  document.getElementById("lock").addEventListener("click", () => {
    localStorage.removeItem(UNLOCK_KEY);
    dots.textContent = "";
    showEmployeeLinks(false);
  });
}
