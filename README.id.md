# 🚀 Recaptan | Pencatat Keuangan & Dashboard Serverless
Recaptan — Aplikasi pencatat pengeluaran pribadi yang sederhana dan estetis untuk memantau pengeluaran harian, mingguan, bulanan, dan tahunan.

*Baca dokumen ini dalam bahasa lain: [English](README.md).*

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-f38020?logo=cloudflare)
![Tech](https://img.shields.io/badge/Tech-Vanilla%20JS%20%7C%20HTML%20%7C%20CSS-yellow)

Finflow adalah aplikasi manajemen arus kas (pemasukan & pengeluaran) berbasis **Serverless** yang terintegrasi penuh dengan **Telegram Bot API**. Proyek ini dirancang untuk mencatat transaksi harian dengan cepat via chat, dan memvisualisasikannya secara *real-time* melalui Dashboard web interaktif tanpa perlu melakukan *refresh* halaman secara manual.

---

## 🔗 Live Demo
- **URL Dashboard:** [Masukkan Link Cloudflare Worker Anda di sini, cth: https://finflow.namakamu.workers.dev]
- **Access Code:** `12345` *(Masukkan kode akses demo Anda di sini)*

---

## 📸 Tampilan Aplikasi

*(Tambahkan screenshot atau GIF proyek Anda di sini)*

| Dashboard Desktop | Dashboard Mobile | Telegram Bot |
| :---: | :---: | :---: |
| <img src="[LINK_GAMBAR_DESKTOP]" width="250"/> | <img src="[LINK_GAMBAR_MOBILE]" width="150"/> | <img src="[LINK_GAMBAR_TELEGRAM]" width="150"/> |

> **💡 Pro Tip:** Masukkan file berformat `.gif` yang menunjukkan saat Anda mengetik data di Telegram, grafik di Dashboard otomatis bergerak (update).

---

## ✨ Fitur Utama

- ⚡ **Real-time Background Polling:** Dashboard secara otomatis menyinkronkan data dari server setiap 15 detik tanpa me-*reload* halaman (Single Page Application).
- 🤖 **Natural Language Parsing:** Cukup ketik `makan 20k` atau `gaji 5jt` di Telegram, bot akan memproses angka dan memisahkan deskripsinya secara otomatis.
- 📊 **Smart Auto-Categorization:** Sistem secara cerdas mengambil kata pertama dari input pengguna untuk dijadikan kategori pengeluaran pada grafik *Donut Chart*.
- 📱 **Mobile-First & Dynamic Viewport:** Menggunakan `100dvh` untuk memastikan tampilan UI sempurna di browser *mobile* (seperti Safari iOS) tanpa terpotong *address bar*.
- 🌓 **Dark/Light Mode & i18n:** Dukungan tema gelap/terang dan lokalisasi multi-bahasa (ID/EN) yang disimpan di `localStorage`.
- 🗂️ **Data Pagination:** Menampilkan riwayat transaksi secara rapi menggunakan sistem paginasi (5 item per halaman) langsung di sisi klien.

---

## 🛠️ Tech Stack & Arsitektur

Proyek ini dibangun **tanpa framework berat** (No React/Vue) untuk membuktikan penguasaan fundamental JavaScript dan optimalisasi performa di sisi klien (*client-side*).

*   **Backend / Serverless:** Cloudflare Workers (Edge Computing)
*   **Database:** Cloudflare KV (Key-Value NoSQL Storage)
*   **Frontend:** Vanilla JavaScript, HTML5, CSS3
*   **Integrasi Pihak Ke-3:** Telegram Bot API (Webhook)
*   **Visualisasi Data:** Chart.js

---

## ⚙️ Cara Kerja Sistem

1. Pengguna mengirimkan chat ke Telegram Bot (Contoh: `Bensin 50rb`).
2. Telegram API mengirimkan *Webhook* ke Cloudflare Workers.
3. Cloudflare Workers mem-*parsing* teks menggunakan Regex, menentukan apakah itu `in` (Pemasukan) atau `out` (Pengeluaran), lalu menyimpannya ke dalam **Cloudflare KV**.
4. Di sisi *Frontend*, Dashboard web melakukan *polling* ringan setiap 15 detik ke *endpoint* API Worker. Jika *hash* data berubah, DOM dan Chart.js akan dirender ulang secara instan.

---

## 🚀 Instalasi & Deployment Lokal

Jika Anda ingin menjalankan proyek ini secara mandiri:

1. Clone repositori ini.
2. Buat Bot baru via `BotFather` di Telegram dan dapatkan `BOT_TOKEN`.
3. Buat *Worker* baru di akun Cloudflare Anda, tambahkan KV Namespace dengan *binding* `EXPENSES_KV`.
4. Tambahkan `BOT_TOKEN`, `TARGET_CHAT_ID`, dan `DASHBOARD_SECRET` di *Environment Variables* Cloudflare.
5. Tempel kode `worker.js` ke dalam editor Cloudflare Workers dan lakukan *Deploy*.
6. Set Webhook Telegram ke URL Cloudflare Worker Anda.
