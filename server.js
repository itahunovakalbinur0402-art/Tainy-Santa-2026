require("dotenv").config();
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizers (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
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
      name TEXT NOT NULL, email TEXT,
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
      UNIQUE(event_id, giver_id), UNIQUE(event_id, receiver_id),
      CHECK(giver_id <> receiver_id)
    );
  `);
}
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 7*24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const clean = (v, n=1000) => String(v || "").trim().slice(0,n);
const token = () => crypto.randomBytes(24).toString("hex");
const organizerOnly = (req,res,next) => req.session.organizerId ? next() : res.status(401).json({error:"Сначала войдите в аккаунт организатора."});
async function eventFor(orgId) {
  const r = await pool.query("SELECT * FROM events WHERE organizer_id=$1 ORDER BY id DESC LIMIT 1",[orgId]);
  return r.rows[0];
}
app.get("/api/health", async (req,res) => {
  try { await pool.query("SELECT 1"); res.json({ok:true,app:"Тайный Санта 2026"}); }
  catch(e) { res.status(500).json({ok:false}); }
});
app.get("/api/me", async (req,res) => {
  if (!req.session.organizerId) return res.json({loggedIn:false});
  const o = await pool.query("SELECT id,name,email FROM organizers WHERE id=$1",[req.session.organizerId]);
  if (!o.rows[0]) { req.session.destroy(()=>{}); return res.json({loggedIn:false}); }
  res.json({loggedIn:true,organizer:o.rows[0],event:await eventFor(req.session.organizerId)});
});
app.post("/api/register", async (req,res) => {
  const name=clean(req.body.name,80), email=clean(req.body.email,160).toLowerCase(), password=String(req.body.password||"");
  if(name.length<2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<10)
    return res.status(400).json({error:"Укажите имя, корректную почту и пароль не короче 10 символов."});
  try {
    const hash=await bcrypt.hash(password,12);
    const r=await pool.query("INSERT INTO organizers(name,email,password_hash) VALUES($1,$2,$3) RETURNING id",[name,email,hash]);
    const orgId=r.rows[0].id;
    await pool.query("INSERT INTO events(organizer_id) VALUES($1)",[orgId]);
    req.session.organizerId=orgId;
    res.json({ok:true});
  } catch(e) {
    if(e.code==="23505") return res.status(409).json({error:"Аккаунт с такой почтой уже существует."});
    console.error(e); res.status(500).json({error:"Не удалось создать аккаунт."});
  }
});
app.post("/api/login", async (req,res) => {
  const email=clean(req.body.email,160).toLowerCase();
  const r=await pool.query("SELECT * FROM organizers WHERE email=$1",[email]);
  const o=r.rows[0];
  if(!o || !(await bcrypt.compare(String(req.body.password||""),o.password_hash)))
    return res.status(401).json({error:"Неверная почта или пароль."});
  req.session.organizerId=o.id; res.json({ok:true});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/event",organizerOnly,async(req,res)=>{
  const e=await eventFor(req.session.organizerId);
  const p=await pool.query("SELECT id,name,email,created_at FROM participants WHERE event_id=$1 ORDER BY created_at",[e.id]);
  const pairs=e.drawn ? (await pool.query(`SELECT g.name AS giver,r.name AS receiver FROM assignments a
    JOIN participants g ON g.id=a.giver_id JOIN participants r ON r.id=a.receiver_id
    WHERE a.event_id=$1 ORDER BY g.name`,[e.id])).rows : [];
  res.json({event:e,participants:p.rows,pairs,inviteUrl:`${process.env.BASE_URL || ""}/join/${e.id}`});
});
app.patch("/api/admin/event",organizerOnly,async(req,res)=>{
  const e=await eventFor(req.session.organizerId);
  if(e.drawn) return res.status(409).json({error:"После жеребьёвки настройки события заблокированы."});
  const min=Number(req.body.budgetMin),max=Number(req.body.budgetMax),date=clean(req.body.exchangeDate,10);
  if(!Number.isInteger(min)||!Number.isInteger(max)||min<0||max<min||!/^\\d{4}-\\d{2}-\\d{2}$/.test(date))
    return res.status(400).json({error:"Проверьте бюджет и дату."});
  await pool.query("UPDATE events SET budget_min=$1,budget_max=$2,exchange_date=$3,reveal_after_exchange=$4 WHERE id=$5",
    [min,max,date,req.body.revealAfterExchange!==false,e.id]);
  res.json({ok:true});
});
app.get("/api/join/:eventId",async(req,res)=>{
  const r=await pool.query("SELECT id,title,budget_min,budget_max,exchange_date,drawn FROM events WHERE id=$1",[req.params.eventId]);
  if(!r.rows[0]) return res.status(404).json({error:"Приглашение не найдено."});
  res.json(r.rows[0]);
});
app.post("/api/join/:eventId",async(req,res)=>{
  const r=await pool.query("SELECT * FROM events WHERE id=$1",[req.params.eventId]),e=r.rows[0];
  if(!e) return res.status(404).json({error:"Приглашение не найдено."});
  if(e.drawn) return res.status(409).json({error:"Регистрация закрыта: жеребьёвка уже проведена."});
  const name=clean(req.body.name,80),email=clean(req.body.email,160).toLowerCase()||null;
  if(name.length<2) return res.status(400).json({error:"Введите имя (не менее двух символов)."});
  try {
    const t=token(); await pool.query("INSERT INTO participants(event_id,name,email,access_token) VALUES($1,$2,$3,$4)",[e.id,name,email,t]);
    res.json({ok:true,participantUrl:`${process.env.BASE_URL || ""}/p/${t}`});
  } catch(err) {
    if(err.code==="23505") return res.status(409).json({error:"Участник с таким именем уже записан."});
    throw err;
  }
});
app.get("/api/participant/:token",async(req,res)=>{
  const r=await pool.query("SELECT * FROM participants WHERE access_token=$1",[req.params.token]),p=r.rows[0];
  if(!p) return res.status(404).json({error:"Ссылка участника недействительна."});
  const er=await pool.query("SELECT title,budget_min,budget_max,exchange_date,drawn,reveal_after_exchange FROM events WHERE id=$1",[p.event_id]),e=er.rows[0];
  const ar=e.drawn ? await pool.query(`SELECT p.id,p.name,p.wishlist FROM assignments a JOIN participants p ON p.id=a.receiver_id
    WHERE a.event_id=$1 AND a.giver_id=$2`,[p.event_id,p.id]) : {rows:[]};
  const today=new Date().toISOString().slice(0,10);
  const reveal=!!e.drawn&&e.reveal_after_exchange&&today>=String(e.exchange_date).slice(0,10);
  const rr=reveal ? await pool.query(`SELECT g.name FROM assignments a JOIN participants g ON g.id=a.giver_id
    WHERE a.event_id=$1 AND a.receiver_id=$2`,[p.event_id,p.id]) : {rows:[]};
  res.json({participant:{name:p.name,wishlist:p.wishlist},
    event:{title:e.title,budgetMin:e.budget_min,budgetMax:e.budget_max,exchangeDate:String(e.exchange_date).slice(0,10),drawn:!!e.drawn},
    assignment:ar.rows[0]||null,revealedBy:rr.rows[0]?.name||null});
});
app.patch("/api/participant/:token/wishlist",async(req,res)=>{
  const r=await pool.query("SELECT * FROM participants WHERE access_token=$1",[req.params.token]),p=r.rows[0];
  if(!p) return res.status(404).json({error:"Ссылка участника недействительна."});
  const e=(await pool.query("SELECT drawn FROM events WHERE id=$1",[p.event_id])).rows[0];
  if(e.drawn) return res.status(409).json({error:"Изменять вишлист после жеребьёвки нельзя."});
  await pool.query("UPDATE participants SET wishlist=$1 WHERE id=$2",[clean(req.body.wishlist,3000),p.id]);
  res.json({ok:true});
});
app.post("/api/admin/draw",organizerOnly,async(req,res)=>{
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const er=await client.query("SELECT * FROM events WHERE organizer_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE",[req.session.organizerId]),e=er.rows[0];
    if(e.drawn) { await client.query("ROLLBACK"); return res.status(409).json({error:"Жеребьёвка уже проведена."}); }
    const ps=(await client.query("SELECT id FROM participants WHERE event_id=$1 ORDER BY id",[e.id])).rows;
    if(ps.length<3) { await client.query("ROLLBACK"); return res.status(400).json({error:"Для жеребьёвки добавьте минимум трёх участников."}); }
    let receivers,attempts=0;
    do {
      receivers=[...ps];
      for(let i=receivers.length-1;i>0;i--){const j=crypto.randomInt(i+1);[receivers[i],receivers[j]]=[receivers[j],receivers[i]];}
      attempts++;
    } while(receivers.some((x,i)=>String(x.id)===String(ps[i].id))&&attempts<10000);
    if(receivers.some((x,i)=>String(x.id)===String(ps[i].id))) throw new Error("Не удалось выполнить жеребьёвку.");
    for(let i=0;i<ps.length;i++) await client.query("INSERT INTO assignments(event_id,giver_id,receiver_id) VALUES($1,$2,$3)",[e.id,ps[i].id,receivers[i].id]);
    await client.query("UPDATE events SET drawn=TRUE WHERE id=$1",[e.id]);
    await client.query("COMMIT"); res.json({ok:true});
  } catch(err) { await client.query("ROLLBACK"); console.error(err); res.status(500).json({error:"Не удалось выполнить жеребьёвку."}); }
  finally { client.release(); }
});
app.get("/join/:eventId",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/p/:token",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("*",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
initDb().then(()=>app.listen(PORT,()=>console.log(`Тайный Санта запущен на порту ${PORT}`)))
  .catch(err=>{console.error("Ошибка подключения к PostgreSQL:",err);process.exit(1);});
