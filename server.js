const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OFFLINE_AFTER_MS = 60 * 1000;

const adminSessions = new Map();
const teams = new Map();
const devices = new Map();
const alerts = [];
const MAX_ALERTS = 1000;

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expiresAt = token && adminSessions.get(token);
  if (!token || !expiresAt || expiresAt < Date.now()) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  const sessionToken = randomToken(24);
  adminSessions.set(sessionToken, Date.now() + SESSION_TTL_MS);
  res.json({ sessionToken });
});

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
  const token = randomToken(9);
  teams.set(token, { teamName: teamName.trim(), createdAtUtc: new Date().toISOString() });
  res.json({ token, teamName: teamName.trim() });
});

app.delete("/api/admin/teams/:token", requireAdmin, (req, res) => {
  const { token } = req.params;
  teams.delete(token);
  for (const key of Array.from(devices.keys())) {
    if (key.startsWith(token + ":")) devices.delete(key);
  }
  res.json({ ok: true });
});

app.post("/api/report", (req, res) => {
  const body = req.body || {};
  const { type, token, machineName } = body;

  const team = teams.get(token);
  if (!team) {
    return res.status(401).json({ error: "رمز الفريق غير صحيح أو غير مسجّل" });
  }

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

    console.log(`ALERT: [${team.teamName}] ${deviceLabel} (${machineName}) - ${alert.processName} score=${alert.score}`);
    return res.json({ ok: true, teamName: team.teamName });
  }

  return res.status(400).json({ error: "unknown report type" });
});

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
    console.log("WARNING: using default admin password - set ADMIN_PASSWORD env var before real deployment.");
  }
});
