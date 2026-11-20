const VOLUNTEER_PIN = "2026"; // Поменяй PIN перед запуском в школе!

// Публичные ключи Supabase (fallback, если /api/config недоступен; secret key здесь НЕ используется)
const DEFAULT_SUPABASE_URL = "https://ntydadkgtmwujzdfgfvh.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_Nr672uZIhT8t8-hImebYPw__XhOx4EM";

let sb = null;
let currentView = "volunteering";
let allOpportunities = [];
let selectedInterests = new Set();
let html5QrScanner = null;

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

async function initApp() {
  // 1. Привязываем все кнопки СРАЗУ, чтобы вкладки и окна работали мгновенно
  bindEvents();

  // 2. Получаем публичный URL и publishable key из Vercel или fallback
  let url = DEFAULT_SUPABASE_URL;
  let key = DEFAULT_SUPABASE_KEY;
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.supabaseUrl) url = cfg.supabaseUrl;
      if (cfg.supabaseKey) key = cfg.supabaseKey;
    }
  } catch (e) {}

  sb = window.supabase.createClient(url, key);

  // 3. Трекинг NFC / QR-меток (?point=hall, ?point=canteen, ?point=library)
  const params = new URLSearchParams(window.location.search);
  const point = params.get("point");
  if (point) {
    sb.from("nfc_hits").insert({ point_name: point.slice(0, 60) }).then(() => {});
  }

  await Promise.all([loadStats(), loadOpportunities(), renderProfile()]);
}

function bindEvents() {
  document.querySelectorAll(".view-btn, .bnav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("btn-hero-profile").addEventListener("click", () => switchView("profile"));
  document.getElementById("filter-school").addEventListener("change", renderFeed);
  document.getElementById("filter-search").addEventListener("input", renderFeed);

  // Кнопка "Стать первым волонтёром (+10 ч.)" на карточке буфета
  document.getElementById("btn-join-first-volo").addEventListener("click", async () => {
    const profileId = localStorage.getItem("binom_profile_id");
    if (!profileId) {
      showToast("Сначала зарегистрируйся за 20 секунд — и сразу попадёшь в команду!");
      switchView("profile");
      return;
    }
    const firstOp = allOpportunities.find((o) => o.type === "volunteering");
    if (firstOp) {
      await sb.from("applications").upsert(
        { opportunity_id: firstOp.id, student_id: profileId },
        { onConflict: "opportunity_id,student_id" }
      );
    }
    showToast("Заявка на смену в буфете (+10 ч.) отправлена! После смены куратор начислит +10 ч. и бейдж.");
  });

  // Выбор интересов
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

  // Регистрация
  document.getElementById("register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("btn-reg-submit");
    btn.disabled = true;
    btn.textContent = "Создаём профиль...";
    const fd = new FormData(e.target);
    const payload = {
      full_name: fd.get("full_name").toString().trim(),
      school_name: fd.get("school_name").toString(),
      grade: fd.get("grade").toString().trim(),
      telegram: fd.get("telegram").toString().trim(),
      interests: Array.from(selectedInterests),
    };
    const { data, error } = await sb.from("profiles").insert(payload).select().single();
    btn.disabled = false;
    btn.textContent = "Создать профиль и получить QR-купон";
    if (error) {
      showToast("Ошибка регистрации: " + error.message);
      return;
    }
    localStorage.setItem("binom_profile_id", data.id);
    showToast("Профиль создан! Твой одноразовый QR-купон готов.");
    await loadStats();
    await renderProfile();
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    localStorage.removeItem("binom_profile_id");
    renderProfile();
    showToast("Вы вышли из профиля");
  });

  document.getElementById("btn-copy-token").addEventListener("click", () => {
    const txt = document.getElementById("qr-token-text").textContent;
    if (txt && navigator.clipboard) {
      navigator.clipboard.writeText(txt);
      showToast("Код купона скопирован");
    }
  });

  // Модалка создания задачи/проекта
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
      showToast("Ошибка публикации: " + error.message);
      return;
    }
    e.target.reset();
    modalCreate.classList.add("hidden");
    showToast("Опубликовано в ленту!");
    switchView(payload.type);
    await loadOpportunities();
  });

  // Модалка QR-сканера / Админки
  const modalAdmin = document.getElementById("modal-admin");
  const openAdmin = () => modalAdmin.classList.remove("hidden");
  document.getElementById("btn-open-admin").addEventListener("click", openAdmin);
  document.getElementById("bnav-admin").addEventListener("click", openAdmin);
  document.getElementById("btn-close-admin").addEventListener("click", () => {
    stopScanner();
    modalAdmin.classList.add("hidden");
  });

  document.getElementById("btn-admin-unlock").addEventListener("click", async () => {
    const pin = document.getElementById("admin-pin-input").value.trim();
    if (pin !== VOLUNTEER_PIN) {
      showToast("Неверный PIN-код (по умолчанию 2026)");
      return;
    }
    document.getElementById("admin-pin-gate").classList.add("hidden");
    document.getElementById("admin-panel").classList.remove("hidden");
    startScanner();
    await loadAdminStudents();
  });

  document.getElementById("btn-refresh-admin").addEventListener("click", loadAdminStudents);
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
  document.querySelectorAll(".bnav-btn").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("bnav-active", active);
    btn.classList.toggle("bnav-idle", !active);
  });
  document.getElementById("section-feed").classList.toggle("hidden", view === "profile");
  document.getElementById("section-profile").classList.toggle("hidden", view !== "profile");
  document.getElementById("featured-buffet-card").classList.toggle("hidden", view !== "volunteering");

  if (view === "profile") renderProfile();
  else renderFeed();
}

async function loadStats() {
  if (!sb) return;
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
  if (!sb) return;
  const { data, error } = await sb
    .from("opportunities")
    .select("*")
    .eq("is_approved", true)
    .order("created_at", { ascending: false });
  if (error) {
    document.getElementById("feed-list").innerHTML = `<div class="p-4 text-sm text-red-600 bg-red-50 rounded-xl">${escapeHtml(error.message)}</div>`;
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
      <article class="bg-white rounded-2xl border border-slate-200 p-4 space-y-2.5 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-bold ${item.type === "volunteering" ? "bg-teal-50 text-teal-800" : "bg-blue-50 text-blue-900"}">${escapeHtml(item.category)}</span>
          <span class="text-xs font-bold text-slate-600">+${item.hours} ч. · мест: ${item.spots_total}</span>
        </div>
        <h3 class="text-base font-extrabold text-slate-900 leading-snug">${escapeHtml(item.title)}</h3>
        <p class="text-sm text-slate-600 leading-relaxed">${escapeHtml(item.description)}</p>
        <div class="pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
          <div class="text-xs text-slate-500">${escapeHtml(item.school_name)} · ${escapeHtml(item.author_name)}</div>
          <button onclick="applyOpportunity('${item.id}', '${escapeHtml(item.author_telegram)}')" class="px-4 py-2 rounded-xl bg-blue-900 hover:bg-blue-800 text-white text-xs font-bold transition">
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
    showToast("Сначала создай профиль за 20 секунд!");
    switchView("profile");
    return;
  }
  await sb.from("applications").upsert({ opportunity_id: opportunityId, student_id: profileId }, { onConflict: "opportunity_id,student_id" });
  showToast("Отклик сохранён!");
  const handle = authorTelegram.replace(/^@/, "");
  if (handle && confirm(`Отклик сохранён! Открыть Telegram (${authorTelegram}), чтобы написать организатору?`)) {
    window.open(`https://t.me/${handle}`, "_blank");
  }
};

async function renderProfile() {
  const profileId = localStorage.getItem("binom_profile_id");
  const regCard = document.getElementById("register-card");
  const profCard = document.getElementById("profile-card");

  if (!profileId || !sb) {
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
  document.getElementById("prof-coupon-status").className = prof.qr_used ? "text-sm font-bold text-slate-400" : "text-sm font-extrabold text-teal-800";

  const badges = [];
  if (prof.is_first_volunteer) badges.push('<span class="px-2.5 py-1 rounded-full text-xs font-extrabold bg-amber-300 text-slate-950">★ First Volunteer</span>');
  (prof.interests || []).forEach((i) => badges.push(`<span class="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">${escapeHtml(i)}</span>`));
  document.getElementById("prof-badges").innerHTML = badges.join("");

  const qrBox = document.getElementById("qrcode-box");
  qrBox.innerHTML = "";
  new QRCode(qrBox, { text: prof.qr_token, width: 190, height: 190, colorDark: "#0F172A", colorLight: "#FFFFFF" });
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
  await Promise.all([loadAdminStudents(), renderProfile()]);
}

async function loadAdminStudents() {
  const { data } = await sb.from("profiles").select("*").order("created_at", { ascending: false }).limit(30);
  const el = document.getElementById("admin-students-list");
  if (!data || !data.length) {
    el.innerHTML = '<div class="text-slate-400 py-2">Пока нет зарегистрированных учеников.</div>';
    return;
  }
  el.innerHTML = data
    .map(
      (s) => `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200">
        <div>
          <div class="font-bold text-slate-900">${escapeHtml(s.full_name)} (${escapeHtml(s.grade)})</div>
          <div class="text-slate-500">${s.verified_hours} ч. · ${s.is_first_volunteer ? "★ First Volunteer" : "Ученик"} · QR: ${s.qr_used ? "погашен" : "активен"}</div>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button onclick="grantFirstVolo10h('${s.id}', ${s.verified_hours})" class="px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold">★ +10 ч. (буфет)</button>
          <button onclick="addHours('${s.id}', ${s.verified_hours}, 2)" class="px-2.5 py-1.5 rounded-lg bg-blue-900 text-white font-bold">+2 ч.</button>
        </div>
      </div>`
    )
    .join("");
}

window.grantFirstVolo10h = async function (id, currentHours) {
  await sb.from("profiles").update({
    verified_hours: (currentHours || 0) + 10,
    is_first_volunteer: true,
    role: "volunteer",
  }).eq("id", id);
  showToast("Начислено +10 часов и бейдж First Volunteer!");
  await Promise.all([loadAdminStudents(), loadStats(), renderProfile()]);
};

window.addHours = async function (id, currentHours, delta) {
  await sb.from("profiles").update({ verified_hours: (currentHours || 0) + delta }).eq("id", id);
  showToast(`Начислено +${delta} ч.`);
  await Promise.all([loadAdminStudents(), loadStats(), renderProfile()]);
};

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

initApp();
