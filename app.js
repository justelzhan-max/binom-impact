// Конфигурация: ключи подтягиваются из Vercel Environment Variables через /api/config
const VOLUNTEER_PIN = "2026"; // Поменяй PIN перед запуском в школе!

let sb = null;
let currentView = "volunteering";
let allOpportunities = [];
let selectedInterests = new Set();
let html5QrScanner = null;

async function initApp() {
  let url = "";
  let key = "";
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const cfg = await res.json();
      url = cfg.supabaseUrl || "";
      key = cfg.supabaseKey || "";
    }
  } catch (e) {
    console.warn("Config API fallback", e);
  }

  if (!url || !key) {
    document.getElementById("feed-list").innerHTML =
      '<div class="p-5 bg-amber-50 border border-amber-200 rounded-2xl text-sm text-amber-900">Добавь <b>NEXT_PUBLIC_SUPABASE_URL</b> и <b>NEXT_PUBLIC_SUPABASE_ANON_KEY</b> в Environment Variables в Vercel и нажми Redeploy.</div>';
    return;
  }

  sb = window.supabase.createClient(url, key);

  // Трекинг NFC / QR-меток (?point=hall, ?point=library и т.д.)
  const params = new URLSearchParams(window.location.search);
  const point = params.get("point");
  if (point) {
    sb.from("nfc_hits").insert({ point_name: point.slice(0, 60) }).then(() => {});
  }

  bindEvents();
  await Promise.all([loadStats(), loadOpportunities(), renderProfile()]);
}

function bindEvents() {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("btn-hero-profile").addEventListener("click", () => switchView("profile"));
  document.getElementById("filter-school").addEventListener("change", renderFeed);
  document.getElementById("filter-search").addEventListener("input", renderFeed);

  // Interest chips
  document.querySelectorAll(".interest-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const val = chip.dataset.val;
      if (selectedInterests.has(val)) {
        selectedInterests.delete(val);
        chip.classList.remove("chip-active");
        chip.classList.add("chip-idle");
      } else {
        selectedInterests.add(val);
        chip.classList.remove("chip-idle");
        chip.classList.add("chip-active");
      }
    });
  });

  // Registration form
  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      full_name: fd.get("full_name").toString().trim(),
      school_name: fd.get("school_name").toString(),
      grade: fd.get("grade").toString().trim(),
      telegram: fd.get("telegram").toString().trim(),
      interests: Array.from(selectedInterests),
    };
    const { data, error } = await sb.from("profiles").insert(payload).select().single();
    if (error) {
      alert("Ошибка регистрации: " + error.message);
      return;
    }
    localStorage.setItem("binom_profile_id", data.id);
    await loadStats();
    await renderProfile();
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    localStorage.removeItem("binom_profile_id");
    renderProfile();
  });

  // Create opportunity modal
  const modalCreate = document.getElementById("modal-create");
  document.getElementById("btn-open-create").addEventListener("click", () => modalCreate.classList.remove("hidden"));
  document.getElementById("btn-close-create").addEventListener("click", () => modalCreate.classList.add("hidden"));
  document.getElementById("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      type: fd.get("type").toString(),
      category: fd.get("category").toString(),
      title: fd.get("title").toString().trim(),
      description: fd.get("description").toString().trim(),
      hours: Number(fd.get("hours")) || 2,
      spots_total: Number(fd.get("spots_total")) || 5,
      author_name: fd.get("author_name").toString().trim(),
      author_telegram: fd.get("author_telegram").toString().trim(),
      school_name: fd.get("school_name").toString(),
    };
    const { error } = await sb.from("opportunities").insert(payload);
    if (error) {
      alert("Ошибка публикации: " + error.message);
      return;
    }
    e.target.reset();
    modalCreate.classList.add("hidden");
    await loadOpportunities();
  });

  // Admin QR scanner modal
  const modalAdmin = document.getElementById("modal-admin");
  document.getElementById("btn-open-admin").addEventListener("click", () => modalAdmin.classList.remove("hidden"));
  document.getElementById("btn-close-admin").addEventListener("click", () => {
    stopScanner();
    modalAdmin.classList.add("hidden");
  });

  document.getElementById("btn-admin-unlock").addEventListener("click", async () => {
    const pin = document.getElementById("admin-pin-input").value.trim();
    if (pin !== VOLUNTEER_PIN) {
      alert("Неверный PIN-код");
      return;
    }
    document.getElementById("admin-pin-gate").classList.add("hidden");
    document.getElementById("admin-panel").classList.remove("hidden");
    startScanner();
    await loadAdminStudents();
  });

  document.getElementById("btn-manual-verify").addEventListener("click", () => {
    const token = document.getElementById("manual-qr-input").value.trim();
    if (token) verifyCoupon(token);
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view-btn").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("tab-active", active);
    btn.classList.toggle("tab-idle", !active);
  });
  document.getElementById("section-feed").classList.toggle("hidden", view === "profile");
  document.getElementById("section-profile").classList.toggle("hidden", view !== "profile");
  if (view === "profile") renderProfile();
  else renderFeed();
}

async function loadStats() {
  const [{ count: studentsCount }, { data: hoursRows }, { count: nfcCount }] = await Promise.all([
    sb.from("profiles").select("*", { count: "exact", head: true }),
    sb.from("profiles").select("verified_hours"),
    sb.from("nfc_hits").select("*", { count: "exact", head: true }),
  ]);
  const totalHours = (hoursRows || []).reduce((acc, r) => acc + (r.verified_hours || 0), 0);
  document.getElementById("stat-students").textContent = studentsCount ?? 0;
  document.getElementById("stat-hours").textContent = totalHours;
  document.getElementById("stat-nfc").textContent = nfcCount ?? 0;
}

async function loadOpportunities() {
  const { data, error } = await sb
    .from("opportunities")
    .select("*")
    .eq("is_approved", true)
    .order("created_at", { ascending: false });
  if (error) {
    document.getElementById("feed-list").innerHTML = `<div class="p-4 text-sm text-red-600 bg-red-50 rounded-xl">${error.message}</div>`;
    return;
  }
  allOpportunities = data || [];
  renderFeed();
}

function renderFeed() {
  const school = document.getElementById("filter-school").value;
  const q = document.getElementById("filter-search").value.trim().toLowerCase();
  const list = allOpportunities.filter((item) => {
    if (item.type !== currentView) return false;
    if (school !== "all" && item.school_name !== school && item.school_name !== "Все школы BINOM") return false;
    if (q && !(item.title + " " + item.description + " " + item.category).toLowerCase().includes(q)) return false;
    return true;
  });

  const container = document.getElementById("feed-list");
  if (!list.length) {
    container.innerHTML = '<div class="p-6 text-center text-sm text-slate-500 bg-white rounded-2xl border border-slate-200">Пока нет задач по этому фильтру. Нажми «+ Добавить», чтобы создать первую!</div>';
    return;
  }

  container.innerHTML = list
    .map(
      (item) => `
      <article class="bg-white rounded-2xl border border-slate-200 p-4 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${item.type === "volunteering" ? "bg-teal-50 text-teal-800" : "bg-blue-50 text-blue-900"}">${escapeHtml(item.category)}</span>
          <span class="text-xs font-semibold text-slate-500">+${item.hours} ч. · мест: ${item.spots_total}</span>
        </div>
        <h3 class="text-base font-bold text-slate-900 leading-snug">${escapeHtml(item.title)}</h3>
        <p class="text-sm text-slate-600 leading-relaxed">${escapeHtml(item.description)}</p>
        <div class="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
          <div class="text-xs text-slate-500">${escapeHtml(item.school_name)} · ${escapeHtml(item.author_name)}</div>
          <button onclick="applyOpportunity('${item.id}', '${escapeHtml(item.author_telegram)}')" class="px-3.5 py-1.5 rounded-xl bg-blue-900 hover:bg-blue-800 text-white text-xs font-semibold transition">
            Откликнуться
          </button>
        </div>
      </article>`
    )
    .join("");
}

window.applyOpportunity = async function (opportunityId, authorTelegram) {
  const profileId = localStorage.getItem("binom_profile_id");
  if (!profileId) {
    alert("Сначала пройди быструю регистрацию во вкладке «Профиль и QR» (20 секунд).");
    switchView("profile");
    return;
  }
  await sb.from("applications").upsert({ opportunity_id: opportunityId, student_id: profileId }, { onConflict: "opportunity_id,student_id" });
  const handle = authorTelegram.replace(/^@/, "");
  if (confirm(`Отклик сохранён! Открыть Telegram (${authorTelegram}), чтобы написать организатору?`)) {
    window.open(`https://t.me/${handle}`, "_blank");
  }
};

async function renderProfile() {
  const profileId = localStorage.getItem("binom_profile_id");
  const regCard = document.getElementById("register-card");
  const profCard = document.getElementById("profile-card");

  if (!profileId) {
    regCard.classList.remove("hidden");
    profCard.classList.add("hidden");
    return;
  }

  const { data: prof } = await sb.from("profiles").select("*").eq("id", profileId).single();
  if (!prof) {
    localStorage.removeItem("binom_profile_id");
    regCard.classList.remove("hidden");
    profCard.classList.add("hidden");
    return;
  }

  regCard.classList.add("hidden");
  profCard.classList.remove("hidden");

  document.getElementById("prof-name").textContent = prof.full_name;
  document.getElementById("prof-meta").textContent = `${prof.school_name} · ${prof.grade} · ${prof.telegram}`;
  document.getElementById("prof-hours").textContent = `${prof.verified_hours} ч.`;
  document.getElementById("prof-coupon-status").textContent = prof.qr_used ? "Использован" : "Активен (1 раз)";
  document.getElementById("prof-coupon-status").className = prof.qr_used ? "text-sm font-bold text-slate-400" : "text-sm font-bold text-teal-700";

  const badges = [];
  if (prof.is_first_volunteer) badges.push('<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900">★ First Volunteer</span>');
  (prof.interests || []).forEach((i) => badges.push(`<span class="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">${escapeHtml(i)}</span>`));
  document.getElementById("prof-badges").innerHTML = badges.join("");

  const qrBox = document.getElementById("qrcode-box");
  qrBox.innerHTML = "";
  new QRCode(qrBox, { text: prof.qr_token, width: 180, height: 180, colorDark: "#0F172A", colorLight: "#FFFFFF" });
  document.getElementById("qr-token-text").textContent = prof.qr_token;
}

function startScanner() {
  if (html5QrScanner) return;
  try {
    html5QrScanner = new Html5Qrcode("qr-reader");
    html5QrScanner
      .start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 220 } }, (decodedText) => {
        verifyCoupon(decodedText.trim());
      })
      .catch(() => {});
  } catch (e) {}
}

function stopScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().catch(() => {});
    html5QrScanner = null;
  }
}

async function verifyCoupon(token) {
  const resBox = document.getElementById("scan-result");
  resBox.classList.remove("hidden", "bg-emerald-50", "text-emerald-900", "bg-red-50", "text-red-900");

  const { data: prof, error } = await sb.from("profiles").select("*").eq("qr_token", token).single();
  if (error || !prof) {
    resBox.classList.add("bg-red-50", "text-red-900");
    resBox.textContent = "Купон не найден в базе.";
    return;
  }

  if (prof.qr_used) {
    resBox.classList.add("bg-red-50", "text-red-900");
    resBox.textContent = `УЖЕ ИСПОЛЬЗОВАН: ${prof.full_name} (${prof.grade}). Повторная выдача запрещена.`;
    return;
  }

  await sb.from("profiles").update({ qr_used: true, qr_used_at: new Date().toISOString() }).eq("id", prof.id);
  resBox.classList.add("bg-emerald-50", "text-emerald-900");
  resBox.textContent = `КУПОН ПОДТВЕРЖДЁН! Выдайте угощение: ${prof.full_name} (${prof.school_name}, ${prof.grade}).`;
  await loadAdminStudents();
}

async function loadAdminStudents() {
  const { data } = await sb.from("profiles").select("*").order("created_at", { ascending: false }).limit(25);
  const el = document.getElementById("admin-students-list");
  el.innerHTML = (data || [])
    .map(
      (s) => `
      <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200">
        <div>
          <div class="font-bold text-slate-900">${escapeHtml(s.full_name)} (${escapeHtml(s.grade)})</div>
          <div class="text-slate-500">${s.verified_hours} ч. · ${s.is_first_volunteer ? "First Volunteer" : "Ученик"}</div>
        </div>
        <div class="flex gap-1">
          <button onclick="addHours('${s.id}', ${s.verified_hours})" class="px-2 py-1 rounded bg-blue-900 text-white font-semibold">+2 ч.</button>
          <button onclick="grantFirstBadge('${s.id}')" class="px-2 py-1 rounded bg-amber-500 text-slate-950 font-semibold">★ Бейдж</button>
        </div>
      </div>`
    )
    .join("");
}

window.addHours = async function (id, currentHours) {
  await sb.from("profiles").update({ verified_hours: (currentHours || 0) + 2 }).eq("id", id);
  await Promise.all([loadAdminStudents(), loadStats(), renderProfile()]);
};

window.grantFirstBadge = async function (id) {
  await sb.from("profiles").update({ is_first_volunteer: true, role: "volunteer" }).eq("id", id);
  await Promise.all([loadAdminStudents(), renderProfile()]);
};

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

initApp();
