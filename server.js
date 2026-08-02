// ============================================================================
// YA Tournament Anti-Cheat Dashboard Server
// ----------------------------------------------------------------------------
// يستقبل تقارير من أداة YA Security Scanner (Heartbeat + تنبيهات الاشتباه)
// ويعرضها بلوحة مباشرة (index.html). التخزين في الذاكرة فقط (لا قاعدة بيانات) —
// كافٍ لبطولة قصيرة المدة. للاستخدام الجاد أضف قاعدة بيانات حقيقية (SQLite/Postgres).
//
// شفافية: هذا السيرفر يستقبل فقط ما يرسله عميل الأداة طواعية (اسم اللاعب الذي
// أدخله بنفسه، اسم الجهاز، ودرجة الاشتباه) — لا يوجد أي جمع بيانات آخر.
// ============================================================================

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== تخزين في الذاكرة: playerName -> آخر حالة معروفة =====
const players = new Map();
// ===== سجل كل التنبيهات (آخر 500 فقط لتفادي استهلاك الذاكرة) =====
const alerts = [];
const MAX_ALERTS = 500;

app.post("/api/report", (req, res) => {
  const body = req.body || {};
  const { type, playerName, machineName } = body;

  if (!playerName || typeof playerName !== "string") {
    return res.status(400).json({ error: "playerName is required" });
  }

  const now = new Date().toISOString();

  if (type === "heartbeat") {
    players.set(playerName, {
      playerName,
      machineName: machineName || "",
      likelyCheatCount: body.likelyCheatCount ?? 0,
      highestScore: body.highestScore ?? 0,
      lastSeenUtc: now,
      status: (body.highestScore ?? 0) >= 40 ? "alert" : "ok"
    });
    return res.json({ ok: true });
  }

  if (type === "alert") {
    const alert = {
      playerName,
      machineName: machineName || "",
      processName: body.processName || "",
      pid: body.pid || 0,
      score: body.score || 0,
      reasons: Array.isArray(body.reasons) ? body.reasons : [],
      timestampUtc: now
    };
    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;

    const existing = players.get(playerName) || { playerName, machineName: machineName || "" };
    players.set(playerName, {
      ...existing,
      highestScore: Math.max(existing.highestScore || 0, alert.score),
      lastSeenUtc: now,
      status: "alert"
    });

    console.log(`⚠ ALERT: ${playerName} (${machineName}) — ${alert.processName} score=${alert.score}`);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "unknown report type" });
});

// لوحة البيانات تسحب هذي البيانات كل بضع ثوانٍ (polling بسيط، بدون WebSocket)
app.get("/api/dashboard", (req, res) => {
  res.json({
    players: Array.from(players.values()).sort((a, b) =>
      (b.highestScore || 0) - (a.highestScore || 0)
    ),
    alerts: alerts.slice(0, 100)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YA Tournament Dashboard running on http://localhost:${PORT}`);
});
