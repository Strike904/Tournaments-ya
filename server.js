// ============================================================================
// YA Tournament Anti-Cheat Dashboard Server — v2 (Team Tokens + Admin Login)
// ----------------------------------------------------------------------------
// - المنظّم يسجّل دخول بكلمة مرور واحدة (ADMIN_PASSWORD) ويدير الفرق من اللوحة.
// - كل فريق ياخذ "رمز فريق" (Token) عشوائي من المنظّم — ما يختاره الفريق نفسه.
// - عميل الأداة (C#) يرسل التوكن مع كل تقرير؛ السيرفر يتحقق منه ويحدد اسم الفريق
//   من سجلّه الداخلي (مو من أي نص يرسله العميل) — هذا يمنع انتحال فريق ثاني.
// - كل طلبات اللوحة والفرق تتطلب جلسة إدارة صالحة (Authorization: Bearer <token>).
// - التخزين في الذاكرة فقط (يُمسح عند إعادة تشغيل السيرفر) — مناسب لبطولة قصيرة.
// ============================================================================

const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== إعداد المنظّم: غيّر كلمة المرور هذي قبل النشر الفعلي! =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const OFFLINE_AFTER_MS = 60 * 1000; // يُعتبر الفريق "غير متصل" لو ما أرسل شي آخر 60 ثانية

// ===== تخزين في الذاكرة =====
const adminSessions = new Map(); // sessionToken -> expiresAtMs
const teams = new Map();         // teamToken -> { teamName, createdAtUtc }
const devices = new Map();       // `${teamToken}:${deviceLabel}` -> { ...latest heartbeat }
const alerts = [];               // آخر 1000 تنبيه بكل التفاصيل
const MAX_ALERTS = 1000;

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ===== Middleware: يتطلب جلسة إدارة صالحة =====
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expiresAt = token && adminSessions.get(token);
  if (!token || !expiresAt || expiresAt < Date.now()) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ===== تسجيل دخول المنظّم =====
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  const sessionToken = randomToken(24);
  adminSessions.set(sessionToken, Date.now() + SESSION_TTL_MS);
  res.json({ sessionToken });
});

// ===== إدارة الفرق (تتطلب جلسة إدارة) =====
app.get("/api/admin/teams", requireAdmin, (req, res) => {
  const list = Array.from(teams.entries()).map(([token, t]) => ({
    token,
    teamName: t.teamName,
    createdAtUtc: t.createdAtUtc
  }));
  res.json({ teams: list });
});

app.post("/api/admin/teams", requireAdmin, (req, res) => {
  const { teamName } = req.body || {};
  if (!teamName || typeof teamName !== "string" || !teamName.trim()) {
    return res.status(400).json({ error: "teamName is required" });
  }
  const token = randomToken(9); // رمز أقصر وأسهل يكتبه اللاعب بالأداة
  teams.set(token, { teamName: teamName.trim(), createdAtUtc: new Date().toISOString() });
  res.json({ token, teamName: teamName.trim() });
});

app.delete("/api/admin/teams/:token", requireAdmin, (req, res) => {
  const { token } = req.params;
  teams.delete(token);
  // نظّف أجهزة هذا الفريق من لوحة "متصل الآن"
  for (const key of Array.from(devices.keys())) {
    if (key.startsWith(token + ":")) devices.delete(key);
  }
  res.json({ ok: true });
});

// ===== استقبال التقارير من عميل الأداة (يتطلب رمز فريق صالح، مو جلسة إدارة) =====
app.post("/api/report", (req, res) => {
  const body = req.body || {};
  const { type, token, machineName } = body;

  const team = teams.get(token);
  if (!team) {
    return res.status(401).json({ error: "رمز الفريق غير صحيح أو غير مسجّل" });
  }

  // اسم الجهاز/اللاعب يُستخدم فقط كتسمية فرعية داخل الفريق — الهوية الحقيقية من التوكن
  const deviceLabel = (body.playerName && String(body.playerName).trim()) || machineName || "جهاز غير مسمّى";
  const deviceKey = `${token}:${deviceLabel}`;
  const now = new Date().toISOString();

  if (type === "heartbeat") {
    devices.set(deviceKey, {
      teamName: team.teamName,
      teamToken: token,
      deviceLabel,
      machineName: machineName || "",
      likelyCheatCount: body.likelyCheatCount ?? 0,
      highestScore: body.highestScore ?? 0,
      lastSeenUtc: now
    });
    return res.json({ ok: true, teamName: team.teamName });
  }

  if (type === "alert") {
    const alert = {
      teamName: team.teamName,
      teamToken: token,
      deviceLabel,
      machineName: machineName || "",
      processName: body.processName || "",
      pid: body.pid || 0,
      score: body.score || 0,
      reasons: Array.isArray(body.reasons) ? body.reasons : [],
      timestampUtc: now
    };
    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;

    const existing = devices.get(deviceKey) || { teamName: team.teamName, teamToken: token, deviceLabel, machineName: machineName || "" };
    devices.set(deviceKey, {
      ...existing,
      highestScore: Math.max(existing.highestScore || 0, alert.score),
      lastSeenUtc: now
    });

    console.log(`⚠ ALERT: [${team.teamName}] ${deviceLabel} (${machineName}) — ${alert.processName} score=${alert.score}`);
    return res.json({ ok: true, teamName: team.teamName });
  }

  return res.status(400).json({ error: "unknown report type" });
});

// ===== بيانات اللوحة (تتطلب جلسة إدارة) =====
app.get("/api/dashboard", requireAdmin, (req, res) => {
  const now = Date.now();
  const deviceList = Array.from(devices.values()).map(d => ({
    ...d,
    isOnline: (now - new Date(d.lastSeenUtc).getTime()) < OFFLINE_AFTER_MS
  })).sort((a, b) => (b.highestScore || 0) - (a.highestScore || 0));

  res.json({
    devices: deviceList,
    alerts: alerts.slice(0, 200),
    teamsCount: teams.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YA Tournament Dashboard running on http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === "change-me-now") {
    console.log("⚠ تنبيه: تستخدم كلمة مرور المنظّم الافتراضية — غيّرها عبر متغيّر البيئة ADMIN_PASSWORD قبل النشر الفعلي.");
  }
});
