/**
 * Bot Telegram - Pencatat Pemasukan & Pengeluaran + Dashboard
 * Versi Cloudflare Workers (gratis, tanpa kartu kredit, tidak pernah tidur)
 * =========================================================================
 */

const BULAN_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// Fungsi untuk menarik zona waktu Server ke Waktu Indonesia Barat (WIB / UTC+7)
function toWIB(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(d.getTime() + (7 * 60 * 60 * 1000));
}

function rupiah(n) {
  return "Rp" + Math.abs(n).toLocaleString("id-ID");
}

function parseEntry(text) {
  let t = text.trim();
  let type = "out";

  if (t.startsWith("+")) {
    type = "in";
    t = t.slice(1).trim();
  } else if (t.toLowerCase().startsWith("gaji")) {
    type = "in";
  }

  const m = t.match(/(\d+)\s*(rb|ribu|k|jt|juta)?$/i);
  if (!m) return null;

  let amount = parseInt(m[1], 10);
  const suf = m[2] ? m[2].toLowerCase() : null;

  if (suf === "rb" || suf === "ribu" || suf === "k") {
    amount *= 1000;
  } else if (suf === "jt" || suf === "juta") {
    amount *= 1000000;
  }

  const desc = t.slice(0, m.index).trim() || "Tanpa keterangan";
  return { desc, amount, type };
}

async function getEntries(env, chatId) {
  const raw = await env.EXPENSES_KV.get(`expenses:${chatId}`);
  if (!raw) return [];
  const list = JSON.parse(raw);
  return list.map((e) => ({ ...e, type: e.type || "out" }));
}

async function saveEntries(env, chatId, list) {
  await env.EXPENSES_KV.put(`expenses:${chatId}`, JSON.stringify(list));
}

function filterByPeriod(list, period) {
  const nowWib = toWIB();
  return list.filter((e) => {
    const dWib = toWIB(e.date);
    
    // Pencocokan batas hari berdasarkan jam WIB
    const nowDay = `${nowWib.getUTCFullYear()}-${nowWib.getUTCMonth()}-${nowWib.getUTCDate()}`;
    const dDay = `${dWib.getUTCFullYear()}-${dWib.getUTCMonth()}-${dWib.getUTCDate()}`;

    if (period === "harian") return dDay === nowDay;
    if (period === "mingguan") return nowWib.getTime() - dWib.getTime() <= 7 * 24 * 60 * 60 * 1000;
    if (period === "bulanan")
      return dWib.getUTCMonth() === nowWib.getUTCMonth() && dWib.getUTCFullYear() === nowWib.getUTCFullYear();
    if (period === "tahunan") return dWib.getUTCFullYear() === nowWib.getUTCFullYear();
    return true;
  });
}

function sumByType(rows, type) {
  return rows.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0);
}

function formatRekap(rows, title) {
  if (rows.length === 0) return `${title}\n\nBelum ada transaksi tercatat.`;
  const lines = [title, ""];
  for (const r of rows) {
    const dWib = toWIB(r.date);
    const tanggal = `${String(dWib.getUTCDate()).padStart(2, "0")}/${String(dWib.getUTCMonth() + 1).padStart(2, "0")} ${String(dWib.getUTCHours()).padStart(2, "0")}:${String(dWib.getUTCMinutes()).padStart(2, "0")}`;
    const sign = r.type === "in" ? "+" : "-";
    lines.push(`- ${tanggal} | ${r.desc}: ${sign}${rupiah(r.amount)}`);
  }
  const totalIn = sumByType(rows, "in");
  const totalOut = sumByType(rows, "out");
  lines.push("");
  lines.push(`Pemasukan: +${rupiah(totalIn)}`);
  lines.push(`Pengeluaran: -${rupiah(totalOut)}`);
  lines.push(`Saldo: ${totalIn - totalOut >= 0 ? "+" : "-"}${rupiah(totalIn - totalOut)}`);
  return lines.join("\n");
}

function formatRekapTahunan(rows) {
  if (rows.length === 0) return "Rekap Tahun Ini\n\nBelum ada transaksi tercatat.";
  const perBulan = {};
  for (const r of rows) {
    const idx = toWIB(r.date).getUTCMonth();
    if (!perBulan[idx]) perBulan[idx] = { in: 0, out: 0 };
    perBulan[idx][r.type] += r.amount;
  }
  const lines = [`Rekap Tahun Ini (${toWIB().getUTCFullYear()})`, ""];
  Object.keys(perBulan)
    .sort((a, b) => a - b)
    .forEach((idx) => {
      const { in: inn, out } = perBulan[idx];
      lines.push(`- ${BULAN_ID[idx]}: masuk +${rupiah(inn)}, keluar -${rupiah(out)}`);
    });
  const totalIn = sumByType(rows, "in");
  const totalOut = sumByType(rows, "out");
  lines.push("");
  lines.push(`Total pemasukan: +${rupiah(totalIn)}`);
  lines.push(`Total pengeluaran: -${rupiah(totalOut)}`);
  lines.push(`Saldo tahun ini: ${totalIn - totalOut >= 0 ? "+" : "-"}${rupiah(totalIn - totalOut)}`);
  return lines.join("\n");
}

async function sendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message || !message.text) return;
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(
      env,
      chatId,
      "Halo! Kirim transaksimu dengan format:\nketerangan nominal\n\nContoh pengeluaran:\nmakan siang 25k\nbensin 50rb\n\nContoh pemasukan (ketik 'gaji' atau awali +):\ngaji 5jt\n+bonus 200k\n\nBisa banyak item sekaligus, satu baris satu item.\n\nPerintah lain:\n/rekap_harian\n/rekap_mingguan\n/rekap_bulanan\n/rekap_tahunan\n/hapus_terakhir\n/hapus_semua\n/myid"
    );
    return;
  }
  if (text === "/myid") {
    await sendMessage(env, chatId, `Chat ID kamu: ${chatId}`);
    return;
  }
  if (text.startsWith("/rekap_")) {
    const list = await getEntries(env, chatId);
    if (text === "/rekap_harian") {
      await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "harian"), "Rekap Hari Ini"));
    } else if (text === "/rekap_mingguan") {
      await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "mingguan"), "Rekap 7 Hari Terakhir"));
    } else if (text === "/rekap_bulanan") {
      await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "bulanan"), "Rekap Bulan Ini"));
    } else if (text === "/rekap_tahunan") {
      await sendMessage(env, chatId, formatRekapTahunan(filterByPeriod(list, "tahunan")));
    }
    return;
  }
  if (text === "/hapus_semua") {
    await saveEntries(env, chatId, []);
    await sendMessage(env, chatId, "Semua data transaksi sudah dihapus.");
    return;
  }
  if (text === "/hapus_terakhir") {
    const list = await getEntries(env, chatId);
    if (list.length === 0) {
      await sendMessage(env, chatId, "Tidak ada data untuk dihapus.");
    } else {
      const removed = list.pop();
      await saveEntries(env, chatId, list);
      const sign = removed.type === "in" ? "+" : "-";
      await sendMessage(env, chatId, `Dihapus:\n${removed.desc} (${sign}${rupiah(removed.amount)})`);
    }
    return;
  }

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length > 1) {
    const list = await getEntries(env, chatId);
    const recorded = [];
    const failed = [];
    for (const line of lines) {
      const parsed = parseEntry(line);
      if (parsed) {
        list.push({ desc: parsed.desc, amount: parsed.amount, type: parsed.type, date: new Date().toISOString() });
        recorded.push(parsed);
      } else {
        failed.push(line);
      }
    }
    if (recorded.length > 0) await saveEntries(env, chatId, list);
    const totalIn = sumByType(recorded, "in");
    const totalOut = sumByType(recorded, "out");
    const msgLines = [`Tercatat ${recorded.length} item:`];
    for (const r of recorded) {
      const sign = r.type === "in" ? "+" : "-";
      msgLines.push(`- ${r.desc}: ${sign}${rupiah(r.amount)}`);
    }
    if (failed.length > 0) {
      msgLines.push("");
      msgLines.push(`Tidak dikenali (${failed.length}):`);
      for (const f of failed) msgLines.push(`- ${f}`);
    }
    msgLines.push("");
    if (totalIn > 0) msgLines.push(`Total pemasukan: +${rupiah(totalIn)}`);
    if (totalOut > 0) msgLines.push(`Total pengeluaran: -${rupiah(totalOut)}`);
    await sendMessage(env, chatId, msgLines.join("\n"));
    return;
  }

  const parsed = parseEntry(text);
  if (!parsed) {
    await sendMessage(env, chatId, "Format tidak dikenali. Contoh: 'makan siang 25k', 'gaji 5jt', atau '+bonus 200rb'");
    return;
  }
  const list = await getEntries(env, chatId);
  list.push({ desc: parsed.desc, amount: parsed.amount, type: parsed.type, date: new Date().toISOString() });
  await saveEntries(env, chatId, list);
  const sign = parsed.type === "in" ? "+" : "-";
  const label = parsed.type === "in" ? "Pemasukan" : "Pengeluaran";
  await sendMessage(env, chatId, `Tercatat ${label}:\n${parsed.desc} (${sign}${rupiah(parsed.amount)})`);
}

async function handleScheduled(event, env) {
  const chatId = env.TARGET_CHAT_ID;
  if (!chatId) return;
  const list = await getEntries(env, chatId);
  const cron = event.cron;

  if (cron === "0 21 * * *") {
    await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "harian"), "Rekap Otomatis Harian"));
  } else if (cron === "0 21 * * 0") {
    await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "mingguan"), "Rekap Otomatis Mingguan"));
  } else if (cron === "0 8 1 * *") {
    await sendMessage(env, chatId, formatRekap(filterByPeriod(list, "bulanan"), "Rekap Otomatis Bulanan"));
    if (toWIB().getUTCMonth() === 0) {
      await sendMessage(env, chatId, formatRekapTahunan(filterByPeriod(list, "tahunan")));
    }
  }
}

async function handleApiExpenses(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!env.DASHBOARD_SECRET || token !== env.DASHBOARD_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const chatId = env.TARGET_CHAT_ID;
  const list = chatId ? await getEntries(env, chatId) : [];

  const periods = ["harian", "mingguan", "bulanan", "tahunan"];
  const totals = {};
  for (const p of periods) {
    const rows = filterByPeriod(list, p);
    const inn = sumByType(rows, "in");
    const out = sumByType(rows, "out");
    totals[p] = { in: inn, out, saldo: inn - out };
  }

  const body = {
    totals,
    all: list.reverse() 
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Recaptan Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root {
    /* Dark Theme */
    --bg-main: #141414;
    --bg-panel: #1e1e1e;
    --bg-sidebar: #191919;
    --text-main: #ffffff;
    --text-muted: #8b8b93;
    --border: #2a2a32;
    --input-bg: #151518;
    --icon-bg: rgba(255,255,255,0.05);

    --green: #10b981;
    --red: #ef4444;
    --blue: #3b82f6;
    --purple: #8b5cf6;
    --glow-purple: rgba(139, 92, 246, 0.4);
  }

  [data-theme="light"] {
    /* Light Theme */
    --bg-main: #f3f4f6;
    --bg-panel: #ffffff;
    --bg-sidebar: #ffffff;
    --text-main: #111827;
    --text-muted: #6b7280;
    --border: #e5e7eb;
    --input-bg: #f9fafb;
    --icon-bg: #f3f4f6;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body { 
    font-family: 'Inter', -apple-system, sans-serif; 
    background: var(--bg-main); 
    color: var(--text-main); 
    height: 100vh;
    height: 100dvh; 
    display: flex;
    overflow: hidden; 
    transition: background-color 0.3s, color 0.3s;
  }

  /* --- LOGIN SCREEN --- */
  #loginScreen {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: radial-gradient(circle at center, #1a0b2e 0%, var(--bg-main) 100%);
    display: flex; justify-content: center; align-items: center; z-index: 9999;
  }
  [data-theme="light"] #loginScreen { background: radial-gradient(circle at center, #e2e8f0 0%, #f3f4f6 100%); }

  .login-glow-ring {
    position: absolute; width: 600px; height: 600px; border-radius: 50%;
    box-shadow: 0 0 100px 20px var(--glow-purple);
    border: 1px solid rgba(255,255,255,0.05); z-index: 0; pointer-events: none;
  }
  [data-theme="light"] .login-glow-ring { box-shadow: 0 0 100px 20px rgba(139, 92, 246, 0.15); }

  .login-container {
    background: var(--bg-panel); backdrop-filter: blur(20px);
    border: 1px solid var(--border); border-radius: 24px;
    padding: 40px; width: 400px; max-width: 90%; z-index: 1; text-align: center;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }
  
  .login-logo {
    width: 64px; height: 64px;
    margin: 0 auto 20px;
    display: flex; justify-content: center; align-items: center;
    filter: drop-shadow(0 0 12px rgba(139, 92, 246, 0.6));
  }
  .login-logo svg {
    width: 100%; height: 100%;
  }

  .login-title { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
  .login-subtitle { font-size: 13px; color: var(--text-muted); margin-bottom: 30px; line-height: 1.5; }
  .login-input-group { text-align: left; margin-bottom: 16px; }
  .login-label { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; display: block; }
  .input-wrapper { position: relative; }
  .login-input {
    width: 100%; background: var(--input-bg); border: 1px solid var(--border);
    border-radius: 12px; padding: 12px 40px 12px 16px; color: var(--text-main);
    font-size: 14px; transition: all 0.3s ease; font-family: inherit;
  }
  .login-input:focus { outline: none; border-color: var(--purple); box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.2); }
  .pw-toggle {
    position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    display: flex; align-items: center; justify-content: center; padding: 4px; transition: color 0.2s;
  }
  .pw-toggle:hover { color: var(--text-main); }
  .remember-group { display: flex; align-items: center; gap: 8px; text-align: left; margin-bottom: 24px; }
  .remember-group input[type="checkbox"] { cursor: pointer; }
  .remember-group label { font-size: 13px; color: var(--text-muted); cursor: pointer; }
  .btn-submit {
    width: 100%; background: #d884ff; color: #1a0b2e; border: none; border-radius: 12px;
    padding: 14px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s ease;
  }
  .btn-submit:hover { background: #e29eff; transform: translateY(-1px); }
  #loginError { color: var(--red); font-size: 12px; margin-top: -10px; margin-bottom: 15px; display: none; text-align: left; }

  /* --- APP LAYOUT --- */
  #app { 
    display: none; width: 100%; height: 100vh; height: 100dvh; flex-direction: row; 
  }

  .sidebar-overlay { 
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 40;
    opacity: 0; visibility: hidden; transition: opacity 0.3s ease;
  }
  .sidebar-overlay.open { opacity: 1; visibility: visible; }

  .sidebar {
    width: 260px; background: var(--bg-sidebar); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 20px 0; flex-shrink: 0;
    transition: margin-left 0.3s ease, left 0.3s ease, background 0.3s, border 0.3s;
    overflow: hidden; white-space: nowrap; z-index: 50;
  }
  .sidebar.collapsed { margin-left: -260px; } 

  .sidebar-brand { padding: 0 24px 24px; display: flex; align-items: center; gap: 12px; font-size: 18px; font-weight: 600; }
  .brand-icon { width: 24px; height: 24px; background: var(--text-main); clip-path: polygon(0 10%, 100% 0, 90% 90%, 10% 100%); }

  .nav-menu { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-top: 10px;}
  .nav-item {
    display: flex; align-items: center; gap: 12px; padding: 12px 24px;
    color: var(--text-muted); text-decoration: none; font-size: 14px; transition: all 0.2s; cursor: pointer;
  }
  .nav-item:hover { color: var(--text-main); background: var(--icon-bg); }
  .nav-item.active { color: var(--text-main); background: var(--icon-bg); font-weight: 500; border-right: 3px solid var(--text-main); }
  .nav-item svg { width: 18px; height: 18px; opacity: 0.8; }
  .bottom-actions { padding: 20px 24px; border-top: 1px solid var(--border); margin-top: auto; }

  .main-content { 
    flex: 1; display: flex; flex-direction: column; 
    height: 100vh; height: 100dvh; overflow-y: auto; overflow-x: hidden;
  }

  .top-nav {
    display: flex; justify-content: space-between; align-items: center;
    padding: 20px 32px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg-main); z-index: 10;
  }
  .nav-left { display: flex; align-items: center; gap: 16px; }
  .menu-btn { 
    background: none; border: none; color: var(--text-main); padding: 6px; 
    border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background 0.2s; margin-left: -6px;
  }
  .menu-btn:hover { background: var(--icon-bg); }
  .brand-text-mobile { display: none; font-size: 18px; font-weight: 600; }

  .nav-right { display: flex; align-items: center; gap: 12px; }
  .nav-controls-desktop { display: flex; gap: 12px; align-items: center;}

  .period-selector, .custom-date-input {
    background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;
    color: var(--text-main); font-size: 13px; outline: none; cursor: pointer; font-family: inherit;
  }
  .period-selector:focus, .custom-date-input:focus { border-color: var(--text-muted); }

  .icon-btn { 
    background: var(--bg-panel); border: 1px solid var(--border); color: var(--text-muted); 
    cursor: pointer; display: flex; padding: 8px; border-radius: 8px; transition: 0.2s; align-items: center; justify-content: center;
  }
  .icon-btn:hover { color: var(--text-main); border-color: var(--text-muted); }
  .lang-btn { font-weight: 600; font-size: 12px; color: var(--text-main); border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; cursor: pointer; background: var(--bg-panel); }

  .profile-circle { 
    width: 36px; height: 36px; border-radius: 50%; background: var(--icon-bg); 
    display: flex; align-items: center; justify-content: center; color: var(--text-muted); border: 1px solid var(--border);
  }

  .mobile-sub-nav { display: none; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; padding: 16px 20px 0; }

  .dashboard-wrapper {
    padding: 24px 32px 40px; 
    max-width: 1200px; 
    margin: 0 auto; 
    width: 100%;
    display: flex; flex-direction: column; gap: 20px;
  }

  .panel { 
    background: var(--bg-panel); border-radius: 12px; padding: 20px; 
    border: 1px solid var(--border); display: flex; flex-direction: column; transition: background 0.3s, border 0.3s;
  }
  .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .panel-title { font-size: 15px; font-weight: 600; color: var(--text-main); }
  .panel-subtitle { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .kpi-card { 
    background: var(--bg-panel); border-radius: 12px; padding: 20px; border: 1px solid var(--border); 
    display:flex; flex-direction:column; justify-content: space-between; min-height: 120px; 
  }
  .kpi-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .kpi-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-icon { width: 28px; height: 28px; border-radius: 8px; background: var(--icon-bg); display: flex; align-items: center; justify-content: center; color: var(--text-muted);}
  .kpi-value { font-size: 26px; font-weight: 600; margin-bottom: 6px; letter-spacing: -0.5px; }
  .kpi-trend { font-size: 11px; display: flex; align-items: center; gap: 4px; }
  .trend-up { color: var(--green); }
  .trend-down { color: var(--red); }

  .charts-row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: stretch;}
  .chart-container { flex: 1; min-height: 250px; position: relative; width: 100%;}

  .donut-container { display: flex; align-items: center; justify-content: center; height: 220px; position: relative; margin-bottom: 20px;}
  .donut-inner-text { position: absolute; text-align: center; }
  .donut-inner-val { font-size: 16px; font-weight: 600; white-space: nowrap; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .donut-inner-lbl { font-size: 11px; color: var(--text-muted); }

  .category-list { display: flex; flex-direction: column; gap: 12px; }
  .cat-item { display: flex; align-items: center; font-size: 12px; }
  .cat-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 12px; }
  .cat-name { color: var(--text-muted); flex: 1; word-break: break-word; }
  .cat-amount { font-weight: 500; margin-right: 12px; }
  .cat-pct { color: var(--text-muted); font-size: 11px; width: 35px; text-align: right; }

  .tx-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;}
  .search-wrapper { position: relative; flex: 1; max-width: 300px; }
  .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-muted); pointer-events: none;}
  .search-box {
    width: 100%; background: var(--bg-main); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 12px 8px 36px; color: var(--text-main); font-size: 13px; transition: border 0.2s;
  }
  .search-box:focus { outline: none; border-color: var(--text-muted); }

  .filter-wrapper { position: relative; }
  .btn-filter {
    display:flex; gap:8px; align-items:center; background:var(--bg-main); border:1px solid var(--border); 
    color:var(--text-main); padding:8px 16px; border-radius:8px; cursor: pointer; font-size: 13px;
  }
  .btn-filter:hover { border-color: var(--text-muted); }
  .filter-dropdown {
    position: absolute; top: 110%; right: 0; background: var(--bg-panel); border: 1px solid var(--border);
    border-radius: 8px; width: 150px; box-shadow: 0 10px 25px rgba(0,0,0,0.2);
    display: none; flex-direction: column; z-index: 100; overflow: hidden;
  }
  .filter-dropdown.show { display: flex; }
  .filter-opt { padding: 10px 16px; font-size: 13px; cursor: pointer; color: var(--text-muted); transition: 0.2s; border-bottom: 1px solid var(--border);}
  .filter-opt:last-child { border-bottom: none; }
  .filter-opt:hover, .filter-opt.active { background: var(--icon-bg); color: var(--text-main); }

  /* PAGINATION STYLES */
  .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  .page-btn {
    background: var(--bg-main); border: 1px solid var(--border); color: var(--text-muted);
    border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; transition: 0.2s;
  }
  .page-btn:hover { color: var(--text-main); border-color: var(--text-muted); }
  .page-btn.active { background: var(--purple); color: #fff; border-color: var(--purple); font-weight: 600; }

  table { width: 100%; border-collapse: collapse; text-align: left; }
  th { color: var(--text-muted); font-size: 11px; font-weight: 500; padding: 12px 16px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.02); font-size: 13px; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }

  .badge { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 500; display: inline-block;}
  .badge.in { background: rgba(16, 185, 129, 0.1); color: var(--green); }
  .badge.out { background: rgba(239, 68, 68, 0.1); color: var(--red); }
  .amt-in { color: var(--green); font-weight: 500;}
  .amt-out { color: var(--text-main); font-weight: 500;}

  /* Mobile List Layout */
  .tx-list-mobile { display: none; flex-direction: column; gap: 12px; width: 100%; }
  .tx-item { 
    display: grid; grid-template-columns: 32px 1fr auto auto; gap: 12px; align-items: center; 
    padding: 10px 12px; border-radius: 12px; background: var(--bg-main); border: 1px solid var(--border);
  }
  .tx-icon-wrap { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .tx-icon-wrap.in { background: rgba(16, 185, 129, 0.1); color: var(--green); }
  .tx-icon-wrap.out { background: rgba(239, 68, 68, 0.1); color: var(--red); }
  .tx-name { font-weight: 500; font-size: 13px; word-break: break-word; min-width: 0; }
  .tx-date { font-size: 11px; color: var(--text-muted); display: none;} 
  .tx-amt { font-weight: 500; font-size: 13px; text-align: right; white-space: nowrap;}

  /* SCROLLBAR */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
  [data-theme="light"] ::-webkit-scrollbar-thumb { background: #ccc; }
  ::-webkit-scrollbar-thumb:hover { background: #555; }

  /* --- RESPONSIVE LOGIC --- */
  @media (max-width: 900px) {
    .kpi-grid { grid-template-columns: repeat(2, 1fr); }
    .charts-row { grid-template-columns: 1fr; }
  }

  @media (max-width: 768px) {
    .sidebar {
      position: fixed; top: 0; bottom: 0; left: -260px; z-index: 50; 
      margin-left: 0 !important; 
      height: 100%; 
      height: 100dvh; 
      padding-bottom: env(safe-area-inset-bottom, 20px); 
    }
    .sidebar.open { left: 0; }
    
    .bottom-actions {
      padding-bottom: calc(20px + env(safe-area-inset-bottom, 20px)); 
    }

    .top-nav { padding: 16px 20px; }
    .nav-controls-desktop { display: none; } 
    .brand-text-mobile { display: block; }

    .mobile-sub-nav { display: flex; } 

    .dashboard-wrapper { padding: 16px 20px 30px; gap: 16px; }
    .kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 12px;}
    .kpi-card { min-height: 100px; padding: 16px; }
    .kpi-value { font-size: 20px; }

    .charts-row { grid-template-columns: 1fr; gap: 16px; }
    .panel { padding: 16px; }
    .search-wrapper { max-width: none; }

    .tx-table-desktop { display: none; }
    .tx-list-mobile { display: flex; }
  }

  @media (max-width: 480px) {
     .kpi-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<!-- LOGIN SCREEN -->
<div id="loginScreen">
  <div class="login-glow-ring"></div>
  <div class="login-container">
    
    <!-- PURE SVG ICON: Checkmarks + Coin -->
    <div class="login-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <!-- Kertas Dokumen -->
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <!-- Checklist 1 -->
        <path d="M8 12l1.5 1.5 3-3"></path>
        <!-- Checklist 2 -->
        <path d="M8 16l1.5 1.5 3-3"></path>
        <!-- Koin -->
        <circle cx="17" cy="18" r="4" fill="var(--bg-panel)" stroke="var(--purple)"></circle>
        <path d="M17 16v4"></path>
        <path d="M15.5 17h3"></path>
      </svg>
    </div>

    <h1 class="login-title" data-i18n="titleLogin">Login to Dashboard</h1>
    <p class="login-subtitle" data-i18n="subLogin">To get started, enter your access code.</p>

    <div class="login-input-group">
      <label class="login-label" data-i18n="lblAccess">Enter Access Code</label>
      <div class="input-wrapper">
        <input id="tokenInput" type="password" class="login-input" data-i18n="phAccess" placeholder="Enter your access code" onkeydown="if(event.key==='Enter')saveToken()" />
        <button class="pw-toggle" onclick="togglePw()" id="pwToggleBtn" title="Show/Hide Password">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
    </div>

    <div id="loginError" data-i18n="errLogin">Access code incorrect. Please try again.</div>

    <div class="remember-group">
      <input type="checkbox" id="rememberMe">
      <label for="rememberMe" data-i18n="remember">Save Access Code</label>
    </div>

    <button class="btn-submit" onclick="saveToken()" data-i18n="submit">Submit</button>
  </div>
</div>

<!-- MAIN APP WRAPPER -->
<div id="app">

  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>

  <!-- SIDEBAR -->
  <aside class="sidebar collapsed" id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon"></div>
      <div>Recaptan</div>
    </div>
    <nav class="nav-menu">
      <a class="nav-item active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        <span data-i18n="menuDash">Dashboard Cashflow</span>
      </a>
    </nav>
    <div class="bottom-actions">
      <a class="nav-item" style="padding:10px 0" onclick="logout()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span data-i18n="btnLogout">Logout</span>
      </a>
    </div>
  </aside>

  <!-- MAIN CONTENT AREA -->
  <main class="main-content">

    <!-- TOP NAV -->
    <div class="top-nav">
      <div class="nav-left">
        <button class="menu-btn" onclick="toggleSidebar()">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="brand-icon brand-text-mobile" style="width:20px; height:20px;"></div>
        <div class="brand-text-mobile">Recaptan</div>
      </div>
      <div class="nav-right">
        <!-- Desktop Controls -->
        <div class="nav-controls-desktop">
          <button class="lang-btn" onclick="toggleLanguage()" id="langBtnD" title="Switch Language">ID</button>
          
          <select class="period-selector" id="periodSelectD">
            <option value="tahunan" data-i18n="optYear">Tahun Ini</option>
            <option selected value="bulanan" data-i18n="optMonth">Bulan Ini</option>
            <option value="mingguan" data-i18n="optWeek">Minggu Ini</option>
            <option value="harian" data-i18n="optDay">Hari Ini</option>
            <option value="lainnya" data-i18n="optOther">Lainnya</option>
          </select>
          
          <!-- Month & Year Select (Only shows for 'Lainnya') -->
          <div id="customDateWrapperD" style="display:none; align-items:center; gap:8px;">
            <select id="customMonthD" class="custom-date-input" style="width:110px;" onchange="onCustomDateChange(true)"></select>
            <select id="customYearD" class="custom-date-input" style="width:90px;" onchange="onCustomDateChange(true)"></select>
            <button onclick="resetCustomDate()" class="icon-btn" style="padding: 6px;" title="Reset Date">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>

          <button class="icon-btn" onclick="toggleTheme()"><svg id="themeIconD" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg></button>
        </div>
        <!-- Profile Button -->
        <div class="profile-circle" title="Profile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
        </div>
      </div>
    </div>

    <!-- MOBILE SUB NAV -->
    <div class="mobile-sub-nav" id="mobileControlsBlock">
      <select class="period-selector" id="periodSelectM">
        <option value="tahunan" data-i18n="optYear">Tahun Ini</option>
        <option selected value="bulanan" data-i18n="optMonth">Bulan Ini</option>
        <option value="mingguan" data-i18n="optWeek">Minggu Ini</option>
        <option value="harian" data-i18n="optDay">Hari Ini</option>
        <option value="lainnya" data-i18n="optOther">Lainnya</option>
      </select>
      
      <!-- Mobile View Selects -->
      <div id="customDateWrapperM" style="display:none; align-items:center; gap:8px; width:100%; margin-top:8px;">
        <select id="customMonthM" class="custom-date-input" style="flex:1;" onchange="onCustomDateChange(false)"></select>
        <select id="customYearM" class="custom-date-input" style="flex:1;" onchange="onCustomDateChange(false)"></select>
        <button onclick="resetCustomDate()" class="icon-btn" style="padding: 6px;" title="Reset Date">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      
      <div style="display:flex; gap:8px; margin-top: 8px;">
        <button class="lang-btn" onclick="toggleLanguage()" id="langBtnM" title="Switch Language">ID</button>
        <button class="icon-btn" onclick="toggleTheme()"><svg id="themeIconM" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg></button>
      </div>
    </div>

    <!-- DASHBOARD CONTENT WRAPPER -->
    <div class="dashboard-wrapper">

      <!-- KPI CARDS -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title" data-i18n="kpiBal">Total Saldo</span>
            <div class="kpi-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h0M2 9.5h20"/></svg></div>
          </div>
          <div>
            <div class="kpi-value" id="kpi-balance">Rp0</div>
            <div class="kpi-trend trend-up"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg> <span style="margin-left:4px;" data-i18n="avail">Tersedia</span></div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title" data-i18n="kpiInc">Pemasukan</span>
            <div class="kpi-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
          </div>
          <div>
            <div class="kpi-value" id="kpi-income">Rp0</div>
            <div class="kpi-trend trend-up" data-i18n="currPeriod">Periode Saat Ini</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title" data-i18n="kpiExp">Pengeluaran</span>
            <div class="kpi-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg></div>
          </div>
          <div>
            <div class="kpi-value" id="kpi-expense">Rp0</div>
            <div class="kpi-trend trend-down" data-i18n="currPeriod">Periode Saat Ini</div>
          </div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title" data-i18n="kpiRate">Tingkat Tabungan</span>
            <div class="kpi-icon" style="color:var(--purple); background:rgba(139, 92, 246, 0.1)"><span style="font-weight:700; font-size:12px;">%</span></div>
          </div>
          <div>
            <div class="kpi-value" id="kpi-rate">0%</div>
            <div class="kpi-trend" style="color:var(--text-muted)" data-i18n="ofInc">Dari Pemasukan</div>
          </div>
        </div>
      </div>

      <!-- CHARTS ROW -->
      <div class="charts-row">
        <!-- LINE CHART -->
        <div class="panel">
          <div class="panel-header" style="margin-bottom:10px;">
            <div>
              <div class="panel-title" data-i18n="chTitleIncExp">Pemasukan vs Pengeluaran</div>
              <div class="panel-subtitle" data-i18n="chSubIncExp">Perbandingan bulanan</div>
            </div>
          </div>
          <div class="chart-container">
            <canvas id="lineChart"></canvas>
          </div>
        </div>

        <!-- DONUT CHART -->
        <div class="panel">
          <div class="panel-header" style="margin-bottom:10px;">
            <div>
              <div class="panel-title" data-i18n="chTitleDonut">Rincian Pengeluaran</div>
              <div class="panel-subtitle" data-i18n="chSubDonut">Periode saat ini</div>
            </div>
          </div>
          <div class="donut-container">
            <canvas id="donutChart"></canvas>
            <div class="donut-inner-text">
              <div class="donut-inner-val" id="donut-total">Rp0</div>
              <div class="donut-inner-lbl" data-i18n="kpiExp">Pengeluaran</div>
            </div>
          </div>
          <div class="category-list" id="cat-list">
            <!-- Populated by JS -->
          </div>
        </div>
      </div>

      <!-- TRANSACTIONS PANEL -->
      <div class="panel">
        <div class="tx-controls">
          <div class="panel-title" data-i18n="txTitle">Transaksi Terbaru</div>

          <div style="display:flex; gap:12px; flex:1; justify-content:flex-end;">
            <div class="search-wrapper">
               <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
               <input type="text" class="search-box" id="searchInput" data-i18n="phSearch" placeholder="Cari transaksi" oninput="applyTxFilter()">
            </div>

            <div class="filter-wrapper">
              <button class="btn-filter" onclick="toggleFilterMenu()" id="filterBtn">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
                <span data-i18n="btnFilter">Saring</span>
              </button>
              <div class="filter-dropdown" id="filterDropdown">
                <div class="filter-opt active" onclick="setTxFilter('all', this)" data-i18n="fltAll">Semua</div>
                <div class="filter-opt" onclick="setTxFilter('in', this)" data-i18n="fltIn">Pemasukan</div>
                <div class="filter-opt" onclick="setTxFilter('out', this)" data-i18n="fltOut">Pengeluaran</div>
              </div>
            </div>
          </div>
        </div>

        <!-- DESKTOP TABLE -->
        <div class="tx-table-desktop" style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th data-i18n="thTx">TRANSAKSI</th>
                <th data-i18n="thType">TIPE</th>
                <th data-i18n="thDate">TANGGAL</th>
                <th style="text-align:right" data-i18n="thAmt">JUMLAH</th>
              </tr>
            </thead>
            <tbody id="tx-tbody-desktop">
              <!-- Populated by JS -->
            </tbody>
          </table>
        </div>

        <!-- MOBILE LIST -->
        <div class="tx-list-mobile" id="tx-tbody-mobile">
            <!-- Populated by JS -->
        </div>
        
        <!-- PAGINATION CONTROLS -->
        <div id="pagination-controls"></div>

      </div>

    </div> <!-- End Dashboard Wrapper -->
  </main>

</div> <!-- End App Wrapper -->

<script>
// --- GLOBAL SETTINGS & THEME ---
let currentPeriod = "bulanan";
let lastData = null;
let currentTxFilter = 'all'; 
let currentSearch = '';
let customSelectedMonth = null; 

// VARIABEL UNTUK PAGINATION
let currentPage = 1;
const itemsPerPage = 5;
let currentTxListForPagination = [];

let currentTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', currentTheme);

let pollTimer = null;

function applyThemeIcon() {
  const isLight = currentTheme === 'light';
  const iconHtml = isLight ? 
    '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>' 
    : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';

  if(document.getElementById('themeIconD')) document.getElementById('themeIconD').innerHTML = iconHtml;
  if(document.getElementById('themeIconM')) document.getElementById('themeIconM').innerHTML = iconHtml;
}
applyThemeIcon(); 

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', currentTheme);
  document.documentElement.setAttribute('data-theme', currentTheme);
  applyThemeIcon();

  Chart.defaults.color = currentTheme === 'light' ? '#6b7280' : '#8b8b93';
  if(lastData) renderDashboard(lastData); 
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
    sidebar.classList.remove('collapsed');
  } else {
    sidebar.classList.toggle('collapsed');
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  }
}

function handleResize() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');

  if(window.innerWidth > 768) {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    sidebar.classList.remove('collapsed');
  }
}
window.addEventListener('resize', handleResize);
handleResize();

const dict = {
  en: {
    titleLogin: "Login to Dashboard", subLogin: "To get started, enter your access code.",
    lblAccess: "Enter Access Code", phAccess: "Enter your access code",
    remember: "Save Access Code", submit: "Submit",
    errLogin: "Access code incorrect. Please try again.",
    kpiBal: "Total Balance", kpiInc: "Income", kpiExp: "Expenses", kpiRate: "Savings Rate",
    avail: "Available", currPeriod: "Current Period", ofInc: "Of Income",
    chTitleIncExp: "Income vs Expenses", chSubIncExp: "Monthly comparison",
    chTitleDonut: "Spending Breakdown", chSubDonut: "Current period", lblTotal: "Total",
    txTitle: "Recent Transactions", phSearch: "Search transactions...", btnFilter: "Filter",
    fltAll: "All", fltIn: "Income", fltOut: "Expense",
    optMonth: "This Month", optYear: "This Year", optWeek: "This Week", optDay: "Today", optOther: "Others",
    noTx: "No transactions found.", noExp: "No expenses recorded",
    thTx: "TRANSACTION", thType: "TYPE", thDate: "DATE", thAmt: "AMOUNT",
    bdgIn: "Income", bdgOut: "Expense",
    cat1: "Food & Dining", cat2: "Housing", cat3: "Transport", cat4: "Shopping", cat5: "Other",
    phYear: "Year", phMonth: "Month",
    monthMap: { "Januari": "Jan", "Februari": "Feb", "Maret": "Mar", "April": "Apr", "Mei": "May", "Juni": "Jun", "Juli": "Jul", "Agustus": "Aug", "September": "Sep", "Oktober": "Oct", "November": "Nov", "Desember": "Dec" },
    monthNames: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    menuDash: "Dashboard Cashflow", btnLogout: "Logout"
  },
  id: {
    titleLogin: "Masuk ke Dashboard", subLogin: "Untuk memulai, masukkan kode akses Anda.",
    lblAccess: "Masukkan Kode Akses", phAccess: "Masukkan kode akses Anda",
    remember: "Simpan Kode Akses", submit: "Masuk",
    errLogin: "Kode akses salah. Silakan coba lagi.",
    kpiBal: "Total Saldo", kpiInc: "Pemasukan", kpiExp: "Pengeluaran", kpiRate: "Tingkat Tabungan",
    avail: "Tersedia", currPeriod: "Periode Saat Ini", ofInc: "Dari Pemasukan",
    chTitleIncExp: "Pemasukan vs Pengeluaran", chSubIncExp: "Perbandingan bulanan",
    chTitleDonut: "Rincian Pengeluaran", chSubDonut: "Periode saat ini", lblTotal: "Total",
    txTitle: "Transaksi Terbaru", phSearch: "Cari transaksi", btnFilter: "Saring",
    fltAll: "Semua", fltIn: "Pemasukan", fltOut: "Pengeluaran",
    optMonth: "Bulan Ini", optYear: "Tahun Ini", optWeek: "Minggu Ini", optDay: "Hari Ini", optOther: "Lainnya",
    noTx: "Tidak ada transaksi ditemukan.", noExp: "Belum ada pengeluaran",
    thTx: "TRANSAKSI", thType: "TIPE", thDate: "TANGGAL", thAmt: "JUMLAH",
    bdgIn: "Pemasukan", bdgOut: "Pengeluaran",
    cat1: "Makan & Minum", cat2: "Tempat Tinggal", cat3: "Transportasi", cat4: "Belanja", cat5: "Lainnya",
    phYear: "Tahun", phMonth: "Bulan",
    monthMap: null, 
    monthNames: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
    menuDash: "Dashboard Arus Kas", btnLogout: "Keluar"
  }
};

let currentLang = localStorage.getItem('dash_lang') || 'id';

function initCustomDateDropdowns() {
  const currentYear = new Date().getFullYear();
  const phYear = dict[currentLang].phYear;
  const phMonth = dict[currentLang].phMonth;

  const curM = document.getElementById('customMonthD') ? document.getElementById('customMonthD').value : '';
  const curY = document.getElementById('customYearD') ? document.getElementById('customYearD').value : '';

  let yearHtml = \`<option value="" disabled \${!curY ? 'selected' : ''}>\${phYear}</option>\`;
  for(let y = currentYear - 5; y <= currentYear + 5; y++) {
     yearHtml += \`<option value="\${y}" \${curY == y ? 'selected' : ''}>\${y}</option>\`;
  }
  
  let monthHtml = \`<option value="" disabled \${!curM ? 'selected' : ''}>\${phMonth}</option>\`;
  dict[currentLang].monthNames.forEach((m, i) => {
     let mVal = String(i + 1).padStart(2, '0');
     monthHtml += \`<option value="\${mVal}" \${curM === mVal ? 'selected' : ''}>\${m}</option>\`;
  });

  ['customYearD', 'customYearM'].forEach(id => {
     if(document.getElementById(id)) document.getElementById(id).innerHTML = yearHtml;
  });
  ['customMonthD', 'customMonthM'].forEach(id => {
     if(document.getElementById(id)) document.getElementById(id).innerHTML = monthHtml;
  });
}

function updateLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[currentLang][key]) {
      if (el.tagName === 'INPUT') el.placeholder = dict[currentLang][key];
      else el.textContent = dict[currentLang][key];
    }
  });
  
  initCustomDateDropdowns();
  
  if(document.getElementById('langBtnD')) document.getElementById('langBtnD').textContent = currentLang.toUpperCase();
  if(document.getElementById('langBtnM')) document.getElementById('langBtnM').textContent = currentLang.toUpperCase();
  if (lastData) renderDashboard(lastData); 
}

function toggleLanguage() {
  currentLang = currentLang === 'en' ? 'id' : 'en';
  localStorage.setItem('dash_lang', currentLang);
  updateLang();
}

function formatShortNum(n) { return (n/1000).toLocaleString("id-ID") + "k"; }
function rupiah(n) { return "Rp" + Math.abs(n).toLocaleString("id-ID"); }
function formatDateStr(dateString) {
  const d = new Date(dateString);
  const day = d.getDate();
  const mName = dict[currentLang].monthNames[d.getMonth()];
  const year = d.getFullYear();
  return \`\${day} \${mName} \${year}\`;
}

Chart.defaults.color = currentTheme === 'light' ? '#6b7280' : '#8b8b93';
Chart.defaults.font.family = "'Inter', sans-serif";

function togglePw() {
  const inp = document.getElementById("tokenInput");
  const btn = document.getElementById("pwToggleBtn");
  if (inp.type === "password") {
    inp.type = "text";
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 4.22-5.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  } else {
    inp.type = "password";
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

function logout() {
  sessionStorage.removeItem("dashboard_token");
  localStorage.removeItem("dashboard_token");
  document.getElementById("tokenInput").value = "";
  document.getElementById("app").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  
  if (pollTimer) {
     clearInterval(pollTimer);
     pollTimer = null;
  }
}

function sessionTokenFallback() {
  return sessionStorage.getItem("dashboard_token") || localStorage.getItem("dashboard_token");
}

function saveToken() {
  const t = document.getElementById("tokenInput").value.trim();
  if (!t) return;
  document.getElementById("loginError").style.display = "none";
  const remember = document.getElementById("rememberMe").checked;
  loadData(t, true, remember);
}

function onCustomDateChange(isDesktop) {
  const mId = isDesktop ? 'customMonthD' : 'customMonthM';
  const yId = isDesktop ? 'customYearD' : 'customYearM';
  
  const mVal = document.getElementById(mId).value;
  const yVal = document.getElementById(yId).value;

  const otherMId = isDesktop ? 'customMonthM' : 'customMonthD';
  const otherYId = isDesktop ? 'customYearM' : 'customYearD';
  if(document.getElementById(otherMId)) document.getElementById(otherMId).value = mVal;
  if(document.getElementById(otherYId)) document.getElementById(otherYId).value = yVal;

  if (mVal && yVal) {
     customSelectedMonth = \`\${yVal}-\${mVal}\`;
     currentPage = 1;
     if(lastData) renderDashboard(lastData);
  }
}

function resetCustomDate() {
  customSelectedMonth = null;
  ['customMonthD', 'customMonthM', 'customYearD', 'customYearM'].forEach(id => {
     if(document.getElementById(id)) document.getElementById(id).value = "";
  });
  currentPage = 1;
  if(lastData) renderDashboard(lastData);
}

function syncPeriod(val) {
  currentPeriod = val;
  document.getElementById("periodSelectD").value = val;
  document.getElementById("periodSelectM").value = val;
  
  const dateWrapperD = document.getElementById("customDateWrapperD");
  const dateWrapperM = document.getElementById("customDateWrapperM");
  
  if (val === "lainnya") {
    if(dateWrapperD) dateWrapperD.style.display = "flex";
    if(dateWrapperM) dateWrapperM.style.display = "flex";
  } else {
    if(dateWrapperD) dateWrapperD.style.display = "none";
    if(dateWrapperM) dateWrapperM.style.display = "none";
  }
  
  currentPage = 1;
  if (lastData) renderDashboard(lastData);
}

document.getElementById("periodSelectD").addEventListener("change", (e) => syncPeriod(e.target.value));
document.getElementById("periodSelectM").addEventListener("change", (e) => syncPeriod(e.target.value));

function toggleFilterMenu() { document.getElementById('filterDropdown').classList.toggle('show'); }
window.onclick = function(event) {
  if (!event.target.closest('.filter-wrapper')) {
    const dd = document.getElementById('filterDropdown');
    if (dd.classList.contains('show')) dd.classList.remove('show');
  }
}

function setTxFilter(type, el) {
  currentTxFilter = type;
  document.querySelectorAll('.filter-opt').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('filterDropdown').classList.remove('show');
  currentPage = 1;
  applyTxFilter();
}

function applyTxFilter() {
  currentSearch = document.getElementById('searchInput').value.toLowerCase();
  currentPage = 1; 
  if(lastData) renderDashboard(lastData); 
}

function generateLineChartData(period, allData, customList = null) {
  const now = new Date();
  let labels = [];
  let inData = [];
  let outData = [];
  
  const dataToProcess = customList || allData;

  // We rely on local time parsing for the chart as before
  if (period === 'tahunan') {
    labels = dict[currentLang].monthNames.map(m => m.slice(0,3));
    inData = Array(12).fill(0);
    outData = Array(12).fill(0);
    dataToProcess.forEach(tx => {
      const d = new Date(tx.date);
      if (d.getFullYear() === now.getFullYear()) {
         if (tx.type === 'in') inData[d.getMonth()] += tx.amount;
         else outData[d.getMonth()] += tx.amount;
      }
    });
  } 
  else if (period === 'bulanan') {
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    labels = Array.from({length: daysInMonth}, (_, i) => String(i + 1));
    inData = Array(daysInMonth).fill(0);
    outData = Array(daysInMonth).fill(0);
    dataToProcess.forEach(tx => {
      const d = new Date(tx.date);
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
         const dayIdx = d.getDate() - 1;
         if (tx.type === 'in') inData[dayIdx] += tx.amount;
         else outData[dayIdx] += tx.amount;
      }
    });
  }
  else if (period === 'mingguan') {
    const last7Days = [];
    for(let i=6; i>=0; i--) {
       let d = new Date();
       d.setDate(d.getDate() - i);
       last7Days.push(d.toDateString()); 
    }
    labels = last7Days.map(dateStr => {
       let d = new Date(dateStr);
       return d.getDate() + " " + dict[currentLang].monthNames[d.getMonth()].slice(0,3);
    });
    inData = Array(7).fill(0);
    outData = Array(7).fill(0);

    dataToProcess.forEach(tx => {
       const txDateStr = new Date(tx.date).toDateString();
       const idx = last7Days.indexOf(txDateStr);
       if(idx !== -1) {
          if (tx.type === 'in') inData[idx] += tx.amount;
          else outData[idx] += tx.amount;
       }
    });
  }
  else if (period === 'harian') {
    labels = Array.from({length: 24}, (_, i) => String(i).padStart(2, '0') + ":00");
    inData = Array(24).fill(0);
    outData = Array(24).fill(0);
    const todayStr = now.toDateString();

    dataToProcess.forEach(tx => {
       const d = new Date(tx.date);
       if(d.toDateString() === todayStr) {
          const h = d.getHours();
          if (tx.type === 'in') inData[h] += tx.amount;
          else outData[h] += tx.amount;
       }
    });
  }
  else if (period === 'lainnya') {
    if(customSelectedMonth) {
       const [y, m] = customSelectedMonth.split('-');
       const year = parseInt(y, 10);
       const month = parseInt(m, 10) - 1; 
       const daysInMonth = new Date(year, month + 1, 0).getDate();
       
       labels = Array.from({length: daysInMonth}, (_, i) => String(i + 1));
       inData = Array(daysInMonth).fill(0);
       outData = Array(daysInMonth).fill(0);
       
       dataToProcess.forEach(tx => {
         const d = new Date(tx.date);
         if (d.getFullYear() === year && d.getMonth() === month) {
            const dayIdx = d.getDate() - 1;
            if (tx.type === 'in') inData[dayIdx] += tx.amount;
            else outData[dayIdx] += tx.amount;
         }
       });
    }
  }

  return { labels, inData, outData };
}

function getCustomTotals(allData) {
  if (!customSelectedMonth) return { totals: {in:0, out:0, saldo:0}, filtered: [] };
  
  const [yearStr, monthStr] = customSelectedMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;
  
  const start = new Date(year, month, 1, 0, 0, 0, 0).getTime();
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
  
  const filtered = allData.filter(tx => {
    const d = new Date(tx.date).getTime();
    return d >= start && d <= end;
  });
  
  let inn = 0, out = 0;
  filtered.forEach(tx => {
    if(tx.type === 'in') inn += tx.amount;
    else out += tx.amount;
  });
  
  return { totals: { in: inn, out: out, saldo: inn - out }, filtered };
}

function renderDashboard(data) {
  let t, txList, chartData;
  
  if (currentPeriod === 'lainnya') {
    const customData = getCustomTotals(data.all || []);
    t = customData.totals;
    txList = customData.filtered;
    chartData = generateLineChartData('lainnya', data.all || [], txList);
  } else {
    t = data.totals[currentPeriod];
    txList = data.all || data.recent;
    chartData = generateLineChartData(currentPeriod, data.all || []);
  }

  document.getElementById("kpi-balance").textContent = rupiah(t.saldo);
  document.getElementById("kpi-income").textContent = rupiah(t.in);
  document.getElementById("kpi-expense").textContent = rupiah(t.out);

  let rate = 0;
  if(t.in > 0) rate = Math.max(0, Math.round(((t.in - t.out) / t.in) * 100));
  document.getElementById("kpi-rate").textContent = rate + "%";

  renderLineChart(chartData.labels, chartData.inData, chartData.outData);
  renderDonutChart(txList); 
  
  // Simpan data ke variabel global agar pagination berfungsi
  currentTxListForPagination = txList;
  renderTransactions(txList);
}

function renderLineChart(labels, inData, outData) {
  const ctx = document.getElementById("lineChart");
  if (window._lineChart) window._lineChart.destroy();

  const gridColor = currentTheme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
  const tooltipBg = currentTheme === 'light' ? '#ffffff' : '#1e1e1e';
  const tooltipText = currentTheme === 'light' ? '#111827' : '#ffffff';
  const tooltipBorder = currentTheme === 'light' ? '#e5e7eb' : '#2a2a32';

  window._lineChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: dict[currentLang].kpiInc,
          data: inData,
          borderColor: "#3b82f6", backgroundColor: "transparent",
          borderWidth: 2, tension: 0.4, pointRadius: 0, pointHoverRadius: 6
        },
        {
          label: dict[currentLang].kpiExp,
          data: outData,
          borderColor: "#ef4444", backgroundColor: "transparent",
          borderWidth: 2, tension: 0.4, pointRadius: 0, pointHoverRadius: 6
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: tooltipBg, titleColor: tooltipText, bodyColor: Chart.defaults.color, borderColor: tooltipBorder,
          borderWidth: 1, padding: 10, displayColors: true,
          callbacks: { label: function(c) { return c.dataset.label + ': Rp' + c.raw.toLocaleString("id-ID"); } }
        }
      },
      scales: {
        x: { grid: { display: false, drawBorder: false } },
        y: { grid: { color: gridColor, drawBorder: false }, ticks: { callback: (v) => v === 0 ? '0' : (v/1000) + 'k' } }
      },
      interaction: { mode: 'index', intersect: false }
    }
  });
}

function renderDonutChart(txList) {
  const ctx = document.getElementById("donutChart");
  
  let outTotal = 0;
  let catMap = {};
  
  txList.forEach(tx => {
    if (tx.type === 'out') {
      outTotal += tx.amount;
      
      let words = tx.desc.trim().split(' ').filter(w => w !== ''); 
      let rawWord = words.length > 0 ? words[0] : "Lainnya";
      
      let cat = rawWord.toLowerCase();
      cat = cat.charAt(0).toUpperCase() + cat.substring(1);
      
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat] += tx.amount;
    }
  });

  let sortedCats = Object.keys(catMap).map(k => ({name: k, amount: catMap[k]})).sort((a,b) => b.amount - a.amount);
  
  let topCats = sortedCats.slice(0, 4);
  let othersAmount = sortedCats.slice(4).reduce((s, c) => s + c.amount, 0);
  if (othersAmount > 0) {
    topCats.push({name: dict[currentLang].cat5 || "Lainnya", amount: othersAmount});
  }

  document.getElementById("donut-total").textContent = outTotal > 0 ? rupiah(outTotal) : rupiah(0);

  if (window._donutChart) window._donutChart.destroy();
  
  const colors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];

  window._donutChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: topCats.length > 0 ? topCats.map(c => c.name) : [dict[currentLang].noExp],
      datasets: [{
        data: topCats.length > 0 ? topCats.map(c => c.amount) : [1],
        backgroundColor: topCats.length > 0 ? colors.slice(0, topCats.length) : ["#2a2a32"],
        borderWidth: 0, hoverOffset: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, 
      cutout: '78%', 
      plugins: { legend: { display: false }, tooltip: { enabled: topCats.length > 0 } }
    }
  });

  let listHtml = '';
  if(outTotal > 0) {
    topCats.forEach((c, i) => {
      const pct = (c.amount / outTotal) * 100;
      listHtml += \`
        <div class="cat-item">
          <div class="cat-dot" style="background:\${colors[i]}"></div>
          <div class="cat-name">\${c.name}</div>
          <div class="cat-amount">\${rupiah(c.amount)}</div>
          <div class="cat-pct">\${pct.toFixed(1)}%</div>
        </div>
      \`;
    });
  } else {
     listHtml = '<div style="color:var(--text-muted); font-size:13px; text-align:center;">'+dict[currentLang].noExp+'</div>';
  }
  document.getElementById("cat-list").innerHTML = listHtml;
}

// LOGIKA RENDER TRANSAKSI + PAGINATION (5 PER HALAMAN)
function renderTransactions(transactions) {
  const tbodyDesk = document.getElementById("tx-tbody-desktop");
  const tbodyMob = document.getElementById("tx-tbody-mobile");
  const paginationContainer = document.getElementById("pagination-controls");

  let filtered = transactions;
  if(currentTxFilter !== 'all') {
    filtered = filtered.filter(t => t.type === currentTxFilter);
  }
  if(currentSearch !== '') {
    filtered = filtered.filter(t => t.desc.toLowerCase().includes(currentSearch));
  }

  if(!filtered || filtered.length === 0) {
    const emptyMsg = '<div style="text-align:center; padding: 20px; color:var(--text-muted); font-size:13px;">'+dict[currentLang].noTx+'</div>';
    tbodyDesk.innerHTML = \`<tr><td colspan="4">\${emptyMsg}</td></tr>\`;
    tbodyMob.innerHTML = emptyMsg;
    paginationContainer.innerHTML = '';
    return;
  }

  // Hitung jumlah halaman
  const totalPages = Math.ceil(filtered.length / itemsPerPage);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  if (currentPage === 0) currentPage = 1;

  // Batasi data per halaman (5 item)
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedItems = filtered.slice(startIndex, startIndex + itemsPerPage);

  let deskHtml = '';
  let mobHtml = '';

  paginatedItems.forEach(tx => {
    const dateStr = formatDateStr(tx.date);
    const isIncome = tx.type === 'in';
    const sign = isIncome ? '+' : '-';

    const badgeCls = isIncome ? 'in' : 'out';
    const badgeTxt = isIncome ? dict[currentLang].bdgIn : dict[currentLang].bdgOut;
    const amtCls = isIncome ? 'amt-in' : 'amt-out';

    deskHtml += \`
      <tr>
        <td style="font-weight:500;">\${tx.desc}</td>
        <td><span class="badge \${badgeCls}">\${badgeTxt}</span></td>
        <td style="color:var(--text-muted);">\${dateStr}</td>
        <td style="text-align:right" class="\${amtCls}">\${sign}\${rupiah(tx.amount)}</td>
      </tr>
    \`;

    const iconCls = isIncome ? 'in' : 'out';
    const svgIcon = isIncome 
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>';

    mobHtml += \`
      <div class="tx-item">
        <div class="tx-icon-wrap \${iconCls}">\${svgIcon}</div>
        <div class="tx-name">\${tx.desc}</div>
        <div class="tx-date">\${dateStr}</div>
        <div class="tx-amt \${amtCls}">\${sign}\${rupiah(tx.amount)}</div>
      </div>
    \`;
  });

  tbodyDesk.innerHTML = deskHtml;
  tbodyMob.innerHTML = mobHtml;

  // Tampilkan Tombol Halaman (Jika lebih dari 1 halaman)
  if (totalPages > 1) {
     let html = '<div class="pagination">';
     for(let i = 1; i <= totalPages; i++) {
        html += \`<button class="page-btn \${i === currentPage ? 'active' : ''}" onclick="changePage(\${i})">\${i}</button>\`;
     }
     html += '</div>';
     paginationContainer.innerHTML = html;
  } else {
     paginationContainer.innerHTML = '';
  }
}

// Fungsi pindah halaman
function changePage(page) {
   currentPage = page;
   renderTransactions(currentTxListForPagination);
}

// FUNGSI POLLING BACKGROUND (AUTO-UPDATE 15 DETIK)
async function pollData() {
  const token = sessionTokenFallback();
  if (!token || document.getElementById("app").style.display === "none") return;

  try {
    const res = await fetch("/api/expenses?token=" + encodeURIComponent(token));
    if (!res.ok) return;
    const data = await res.json();
    
    if (lastData && JSON.stringify(data.all) !== JSON.stringify(lastData.all)) {
      lastData = data;
      renderDashboard(data);
    }
  } catch (err) {}
}

async function loadData(tokenOverride, isLogin, remember) {
  const token = tokenOverride || sessionTokenFallback();
  if (!token) {
    updateLang();
    return;
  }

  try {
    const res = await fetch("/api/expenses?token=" + encodeURIComponent(token));
    if (!res.ok) {
      sessionStorage.removeItem("dashboard_token");
      localStorage.removeItem("dashboard_token");
      document.getElementById("loginScreen").style.display = "flex";
      document.getElementById("app").style.display = "none";
      if (isLogin) document.getElementById("loginError").style.display = "block";
      updateLang();
      return;
    }

    if (isLogin) {
      if(remember) localStorage.setItem("dashboard_token", token);
      else sessionStorage.setItem("dashboard_token", token);
    }

    const data = await res.json();
    lastData = data;

    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    
    initCustomDateDropdowns();
    syncPeriod('bulanan');
    updateLang();
    
    if (!pollTimer) {
      pollTimer = setInterval(pollData, 15000);
    }

  } catch (err) {
    console.error(err);
  }
}

// Init
loadData();
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("ok");
    }

    if (url.pathname === "/api/expenses") {
      return handleApiExpenses(request, env);
    }

    if (url.pathname === "/dashboard" || url.pathname === "/") {
      return new Response(dashboardHtml(), {
        headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};