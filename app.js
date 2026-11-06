// Register the service worker so the portal can be installed and opens offline
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}

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
