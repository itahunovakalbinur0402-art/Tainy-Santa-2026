require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "santa.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS organizers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_id INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Тайный Санта 2026',
  budget_min INTEGER NOT NULL DEFAULT 5000,
  budget_max INTEGER NOT NULL DEFAULT 10000,
  exchange_date TEXT NOT NULL DEFAULT '2026-12-25',
  reveal_after_exchange INTEGER NOT NULL DEFAULT 1,
  drawn INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  access_token TEXT NOT NULL UNIQUE,
  wishlist TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, name)
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  giver_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE(event_id, giver_id),
  UNIQUE(event_id, receiver_id),
  CHECK(giver_id <> receiver_id)
);
`);

if (process.env.NODE_ENV === "production") {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("Для production задайте SESSION_SECRET длиной не менее 32 символов.");
  }
  app.set("trust proxy", 1);
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: dataDir }),
  secret: process.env.SESSION_SECRET || "local-development-only-change-before-deploying-2026",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const q = {
  organizerByEmail: db.prepare("SELECT * FROM organizers WHERE email = ?"),
  eventByOrganizer: db.prepare("SELECT * FROM events WHERE organizer_id = ? ORDER BY id DESC LIMIT 1"),
  participants: db.prepare("SELECT id, name, email, created_at FROM participants WHERE event_id = ? ORDER BY created_at"),
  participantByToken: db.prepare("SELECT * FROM participants WHERE access_token = ?"),
  assignmentFor: db.prepare(`SELECT p.id, p.name, p.wishlist FROM assignments a JOIN participants p ON p.id=a.receiver_id WHERE a.event_id=? AND a.giver_id=?`),
  countParticipants: db.prepare("SELECT COUNT(*) AS n FROM participants WHERE event_id=?")
};

function organizerOnly(req, res, next) {
  if (!req.session.organizerId) return res.status(401).json({ error: "Сначала войдите в аккаунт организатора." });
  next();
}
function getEvent(organizerId) {
  return q.eventByOrganizer.get(organizerId);
}
function cleanText(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}
function makeToken() { return crypto.randomBytes(24).toString("hex"); }

app.get("/api/me", (req, res) => {
  if (!req.session.organizerId) return res.json({ loggedIn: false });
  const organizer = db.prepare("SELECT id, name, email FROM organizers WHERE id=?").get(req.session.organizerId);
  if (!organizer) { req.session.destroy(() => {}); return res.json({ loggedIn: false }); }
  const event = getEvent(organizer.id);
  res.json({ loggedIn: true, organizer, event });
});

app.post("/api/register", async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || "");
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    return res.status(400).json({ error: "Укажите имя, корректную почту и пароль не короче 10 символов." });
  }
  if (q.organizerByEmail.get(email)) return res.status(409).json({ error: "Аккаунт с такой почтой уже существует." });
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO organizers(name,email,password_hash) VALUES(?,?,?)").run(name, email, hash);
  const eventResult = db.prepare("INSERT INTO events(organizer_id) VALUES(?)").run(result.lastInsertRowid);
  req.session.organizerId = Number(result.lastInsertRowid);
  res.json({ ok: true, eventId: Number(eventResult.lastInsertRowid) });
});

app.post("/api/login", async (req, res) => {
  const email = cleanText(req.body.email, 160).toLowerCase();
  const organizer = q.organizerByEmail.get(email);
  if (!organizer || !(await bcrypt.compare(String(req.body.password || ""), organizer.password_hash))) {
    return res.status(401).json({ error: "Неверная почта или пароль." });
  }
  req.session.organizerId = organizer.id;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/api/admin/event", organizerOnly, (req, res) => {
  const event = getEvent(req.session.organizerId);
  const participants = q.participants.all(event.id);
  const pairs = event.drawn ? db.prepare(`
    SELECT giver.name AS giver, receiver.name AS receiver
    FROM assignments a
    JOIN participants giver ON giver.id=a.giver_id
    JOIN participants receiver ON receiver.id=a.receiver_id
    WHERE a.event_id=? ORDER BY giver.name
  `).all(event.id) : [];
  res.json({ event, participants, pairs, inviteUrl: `${BASE_URL}/join/${event.id}` });
});

app.patch("/api/admin/event", organizerOnly, (req, res) => {
  const event = getEvent(req.session.organizerId);
  if (event.drawn) return res.status(409).json({ error: "После жеребьёвки настройки события заблокированы." });
  const min = Number(req.body.budgetMin), max = Number(req.body.budgetMax);
  const date = cleanText(req.body.exchangeDate, 10);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Проверьте бюджет и дату." });
  }
  db.prepare("UPDATE events SET budget_min=?, budget_max=?, exchange_date=?, reveal_after_exchange=? WHERE id=?")
    .run(min, max, date, req.body.revealAfterExchange === false ? 0 : 1, event.id);
  res.json({ ok: true });
});

app.get("/api/join/:eventId", (req, res) => {
  const event = db.prepare("SELECT id,title,budget_min,budget_max,exchange_date,drawn FROM events WHERE id=?").get(Number(req.params.eventId));
  if (!event) return res.status(404).json({ error: "Приглашение не найдено." });
  res.json(event);
});
app.post("/api/join/:eventId", (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id=?").get(Number(req.params.eventId));
  if (!event) return res.status(404).json({ error: "Приглашение не найдено." });
  if (event.drawn) return res.status(409).json({ error: "Регистрация закрыта: жеребьёвка уже проведена." });
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 160).toLowerCase() || null;
  if (name.length < 2) return res.status(400).json({ error: "Введите имя (не менее двух символов)." });
  try {
    const token = makeToken();
    db.prepare("INSERT INTO participants(event_id,name,email,access_token) VALUES(?,?,?,?)").run(event.id, name, email, token);
    res.json({ ok: true, participantUrl: `${BASE_URL}/p/${token}` });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "Участник с таким именем уже записан." });
    throw e;
  }
});

app.get("/api/participant/:token", (req, res) => {
  const p = q.participantByToken.get(req.params.token);
  if (!p) return res.status(404).json({ error: "Ссылка участника недействительна." });
  const event = db.prepare("SELECT title,budget_min,budget_max,exchange_date,drawn,reveal_after_exchange FROM events WHERE id=?").get(p.event_id);
  const assigned = event.drawn ? q.assignmentFor.get(p.event_id, p.id) : null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const revealNow = !!event.drawn && !!event.reveal_after_exchange && today >= event.exchange_date;
  const revealedBy = revealNow ? db.prepare(`
    SELECT giver.name AS name FROM assignments a
    JOIN participants giver ON giver.id=a.giver_id
    WHERE a.event_id=? AND a.receiver_id=?
  `).get(p.event_id, p.id) : null;
  res.json({
    participant: { name: p.name, wishlist: p.wishlist },
    event: { title: event.title, budgetMin: event.budget_min, budgetMax: event.budget_max, exchangeDate: event.exchange_date, drawn: !!event.drawn },
    assignment: assigned ? { name: assigned.name, wishlist: assigned.wishlist } : null,
    revealedBy: revealedBy ? revealedBy.name : null
  });
});
app.patch("/api/participant/:token/wishlist", (req, res) => {
  const p = q.participantByToken.get(req.params.token);
  if (!p) return res.status(404).json({ error: "Ссылка участника недействительна." });
  const event = db.prepare("SELECT drawn FROM events WHERE id=?").get(p.event_id);
  if (event.drawn) return res.status(409).json({ error: "Изменять вишлист после жеребьёвки нельзя." });
  const wishlist = cleanText(req.body.wishlist, 3000);
  db.prepare("UPDATE participants SET wishlist=? WHERE id=?").run(wishlist, p.id);
  res.json({ ok: true });
});

app.post("/api/admin/draw", organizerOnly, (req, res) => {
  const event = getEvent(req.session.organizerId);
  if (event.drawn) return res.status(409).json({ error: "Жеребьёвка уже проведена." });
  const participants = db.prepare("SELECT id FROM participants WHERE event_id=? ORDER BY id").all(event.id);
  if (participants.length < 3) return res.status(400).json({ error: "Для жеребьёвки добавьте минимум трёх участников." });
  let receivers = [...participants];
  // Randomly shuffle until nobody is assigned to themselves.
  let attempts = 0;
  do {
    receivers = [...participants];
    for (let i = receivers.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [receivers[i], receivers[j]] = [receivers[j], receivers[i]];
    }
    attempts++;
  } while (receivers.some((r, i) => r.id === participants[i].id) && attempts < 10000);
  if (receivers.some((r, i) => r.id === participants[i].id)) {
    return res.status(500).json({ error: "Не удалось выполнить жеребьёвку. Попробуйте ещё раз." });
  }
  const insert = db.prepare("INSERT INTO assignments(event_id,giver_id,receiver_id) VALUES(?,?,?)");
  const tx = db.transaction(() => {
    participants.forEach((p, i) => insert.run(event.id, p.id, receivers[i].id));
    db.prepare("UPDATE events SET drawn=1 WHERE id=?").run(event.id);
  });
  tx();
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, app: "Тайный Санта 2026" }));
app.get("/join/:eventId", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/p/:token", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Тайный Санта 2026: ${BASE_URL}`));
