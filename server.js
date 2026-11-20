require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const PgSession = require("connect-pg-simple")(session);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL не задан. Добавьте строку подключения Neon в переменные окружения.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

let schemaPromise;

function initDb() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS organizers (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        organizer_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'Тайный Санта 2026',
        budget_min INTEGER NOT NULL DEFAULT 5000,
        budget_max INTEGER NOT NULL DEFAULT 10000,
        exchange_date DATE NOT NULL DEFAULT DATE '2026-12-25',
        reveal_after_exchange BOOLEAN NOT NULL DEFAULT TRUE,
        drawn BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS participants (
        id BIGSERIAL PRIMARY KEY,
        event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        access_token TEXT NOT NULL UNIQUE,
        wishlist TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(event_id, name)
      );
      CREATE TABLE IF NOT EXISTS assignments (
        id BIGSERIAL PRIMARY KEY,
        event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        giver_id BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        receiver_id BIGINT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        UNIQUE(event_id, giver_id),
        UNIQUE(event_id, receiver_id),
        CHECK(giver_id <> receiver_id)
      );
    `);
  }
  return schemaPromise;
}

app.use(async (req, res, next) => {
  try {
    await initDb();
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось подключиться к базе данных. Проверьте настройки DATABASE_URL." });
  }
});

const query = (sql, params = []) => pool.query(sql, params);
const cleanText = (value, max = 1000) => String(value || "").trim().slice(0, max);
const makeToken = () => crypto.randomBytes(24).toString("hex");

function organizerOnly(req, res, next) {
  if (!req.session.organizerId) {
    return res.status(401).json({ error: "Сначала войдите в аккаунт организатора." });
  }
  next();
}

async function getEvent(organizerId) {
  const r = await query(
    `SELECT id, organizer_id, title, budget_min, budget_max,
            TO_CHAR(exchange_date, 'YYYY-MM-DD') AS exchange_date,
            reveal_after_exchange, drawn, created_at
     FROM events
     WHERE organizer_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [organizerId]
  );
  return r.rows[0];
}

app.get("/api/health", async (req, res) => {
  res.json({ ok: true, app: "Тайный Санта 2026" });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.organizerId) return res.json({ loggedIn: false });
  const o = await query("SELECT id, name, email FROM organizers WHERE id = $1", [req.session.organizerId]);
  if (!o.rows[0]) {
    req.session.destroy(() => {});
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, organizer: o.rows[0], event: await getEvent(req.session.organizerId) });
});

app.post("/api/register", async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 160).toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    return res.status(400).json({ error: "Укажите имя, корректную почту и пароль не короче 10 символов." });
  }

  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const o = await client.query(
      "INSERT INTO organizers(name, email, password_hash) VALUES($1, $2, $3) RETURNING id",
      [name, email, hash]
    );
    const e = await client.query(
      "INSERT INTO events(organizer_id) VALUES($1) RETURNING id",
      [o.rows[0].id]
    );
    await client.query("COMMIT");
    req.session.organizerId = Number(o.rows[0].id);
    res.json({ ok: true, eventId: Number(e.rows[0].id) });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") {
      return res.status(409).json({ error: "Аккаунт с такой почтой уже существует." });
    }
    throw e;
  } finally {
    client.release();
  }
});

app.post("/api/login", async (req, res) => {
  const email = cleanText(req.body.email, 160).toLowerCase();
  const r = await query("SELECT * FROM organizers WHERE email = $1", [email]);

  if (!r.rows[0] || !(await bcrypt.compare(String(req.body.password || ""), r.rows[0].password_hash))) {
    return res.status(401).json({ error: "Неверная почта или пароль." });
  }

  req.session.organizerId = Number(r.rows[0].id);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/event", organizerOnly, async (req, res) => {
  const event = await getEvent(req.session.organizerId);
  if (!event) return res.status(404).json({ error: "Событие не найдено." });

  const p = await query(
    "SELECT id, name, email, created_at FROM participants WHERE event_id = $1 ORDER BY created_at",
    [event.id]
  );

  const pairs = event.drawn
    ? (await query(
        `SELECT g.name AS giver, r.name AS receiver
         FROM assignments a
         JOIN participants g ON g.id = a.giver_id
         JOIN participants r ON r.id = a.receiver_id
         WHERE a.event_id = $1
         ORDER BY g.name`,
        [event.id]
      )).rows
    : [];

  res.json({
    event,
    participants: p.rows,
    pairs,
    inviteUrl: (process.env.BASE_URL || "") + "/join/" + event.id
  });
});

app.patch("/api/admin/event", organizerOnly, async (req, res) => {
  const event = await getEvent(req.session.organizerId);
  if (!event) return res.status(404).json({ error: "Событие не найдено." });
  if (event.drawn) return res.status(409).json({ error: "После жеребьёвки настройки события заблокированы." });

  const min = Number(req.body.budgetMin);
  const max = Number(req.body.budgetMax);
  const date = cleanText(req.body.exchangeDate, 10);
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + "T00:00:00Z") : null;
  const validDate = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;

  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || !validDate) {
    return res.status(400).json({ error: "Проверьте бюджет и дату." });
  }

  await query(
    `UPDATE events
     SET budget_min = $1, budget_max = $2, exchange_date = $3, reveal_after_exchange = $4
     WHERE id = $5`,
    [min, max, date, req.body.revealAfterExchange !== false, event.id]
  );

  res.json({ ok: true });
});

app.get("/api/join/:eventId", async (req, res) => {
  const r = await query(
    `SELECT id, title, budget_min, budget_max,
            TO_CHAR(exchange_date, 'YYYY-MM-DD') AS exchange_date,
            drawn
     FROM events
     WHERE id = $1`,
    [Number(req.params.eventId)]
  );

  if (!r.rows[0]) return res.status(404).json({ error: "Приглашение не найдено." });
  res.json(r.rows[0]);
});

app.post("/api/join/:eventId", async (req, res) => {
  const r = await query("SELECT * FROM events WHERE id = $1", [Number(req.params.eventId)]);
  const event = r.rows[0];

  if (!event) return res.status(404).json({ error: "Приглашение не найдено." });
  if (event.drawn) return res.status(409).json({ error: "Регистрация закрыта: жеребьёвка уже проведена." });

  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 160).toLowerCase() || null;
  if (name.length < 2) return res.status(400).json({ error: "Введите имя (не менее двух символов)." });

  try {
    const token = makeToken();
    await query(
      "INSERT INTO participants(event_id, name, email, access_token) VALUES($1, $2, $3, $4)",
      [event.id, name, email, token]
    );
    res.json({ ok: true, participantUrl: (process.env.BASE_URL || "") + "/p/" + token });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Участник с таким именем уже записан." });
    throw e;
  }
});

app.get("/api/participant/:token", async (req, res) => {
  const r = await query("SELECT * FROM participants WHERE access_token = $1", [req.params.token]);
  const p = r.rows[0];
  if (!p) return res.status(404).json({ error: "Ссылка участника недействительна." });

  const er = await query(
    `SELECT title, budget_min, budget_max,
            TO_CHAR(exchange_date, 'YYYY-MM-DD') AS exchange_date,
            drawn, reveal_after_exchange
     FROM events
     WHERE id = $1`,
    [p.event_id]
  );
  const event = er.rows[0];

  const ar = event.drawn
    ? await query(
        `SELECT p.id, p.name, p.wishlist
         FROM assignments a
         JOIN participants p ON p.id = a.receiver_id
         WHERE a.event_id = $1 AND a.giver_id = $2`,
        [p.event_id, p.id]
      )
    : { rows: [] };

  const today = new Date().toISOString().slice(0, 10);
  const revealNow = !!event.drawn && !!event.reveal_after_exchange && today >= event.exchange_date;

  const revealedBy = revealNow
    ? (await query(
        `SELECT g.name
         FROM assignments a
         JOIN participants g ON g.id = a.giver_id
         WHERE a.event_id = $1 AND a.receiver_id = $2`,
        [p.event_id, p.id]
      )).rows[0]
    : null;

  res.json({
    participant: { name: p.name, wishlist: p.wishlist },
    event: {
      title: event.title,
      budgetMin: event.budget_min,
      budgetMax: event.budget_max,
      exchangeDate: event.exchange_date,
      drawn: !!event.drawn
    },
    assignment: ar.rows[0] ? { name: ar.rows[0].name, wishlist: ar.rows[0].wishlist } : null,
    revealedBy: revealedBy ? revealedBy.name : null
  });
});

app.patch("/api/participant/:token/wishlist", async (req, res) => {
  const r = await query("SELECT * FROM participants WHERE access_token = $1", [req.params.token]);
  const p = r.rows[0];
  if (!p) return res.status(404).json({ error: "Ссылка участника недействительна." });

  const e = (await query("SELECT drawn FROM events WHERE id = $1", [p.event_id])).rows[0];
  if (e.drawn) return res.status(409).json({ error: "Изменять вишлист после жеребьёвки нельзя." });

  await query("UPDATE participants SET wishlist = $1 WHERE id = $2", [cleanText(req.body.wishlist, 3000), p.id]);
  res.json({ ok: true });
});

app.post("/api/admin/draw", organizerOnly, async (req, res) => {
  const event = await getEvent(req.session.organizerId);
  if (!event) return res.status(404).json({ error: "Событие не найдено." });
  if (event.drawn) return res.status(409).json({ error: "Жеребьёвка уже проведена." });

  const participants = (await query(
    "SELECT id FROM participants WHERE event_id = $1 ORDER BY id",
    [event.id]
  )).rows;

  if (participants.length < 3) {
    return res.status(400).json({ error: "Для жеребьёвки добавьте минимум трёх участников." });
  }

  let receivers;
  let attempts = 0;

  do {
    receivers = [...participants];
    for (let i = receivers.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [receivers[i], receivers[j]] = [receivers[j], receivers[i]];
    }
    attempts++;
  } while (receivers.some((r, i) => String(r.id) === String(participants[i].id)) && attempts < 10000);

  if (receivers.some((r, i) => String(r.id) === String(participants[i].id))) {
    return res.status(500).json({ error: "Не удалось выполнить жеребьёвку. Попробуйте ещё раз." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < participants.length; i++) {
      await client.query(
        "INSERT INTO assignments(event_id, giver_id, receiver_id) VALUES($1, $2, $3)",
        [event.id, participants[i].id, receivers[i].id]
      );
    }
    await client.query("UPDATE events SET drawn = TRUE WHERE id = $1", [event.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

app.listen(port, () => console.log("Тайный Санта 2026 запущен на порту " + port));
});

app.get("/join/:eventId", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/p/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(Тайный Санта 2026 запущен на порту ${port}));
}

module.exports = app;
