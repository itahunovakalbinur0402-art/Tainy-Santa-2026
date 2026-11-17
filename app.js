const app = document.getElementById("app");
const pathParts = location.pathname.split("/").filter(Boolean);
const joinId = pathParts[0] === "join" ? pathParts[1] : null;
const participantToken = pathParts[0] === "p" ? pathParts[1] : null;
let adminData = null;

function esc(s="") { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(n) { return new Intl.NumberFormat("ru-RU").format(n) + " ₸"; }
function setMessage(id, message, type="notice") {
  const el = document.getElementById(id);
  if (el) { el.className = `notice ${type}`; el.textContent = message; el.hidden = false; }
}
async function api(url, options={}) {
  const response = await fetch(url, { headers: { "Content-Type":"application/json", ...(options.headers||{}) }, ...options });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос.");
  return data;
}
function landing() {
  app.innerHTML = `
    <section class="hero">
      <div>
        <div class="eyebrow">✦ Обмен подарками · 25 декабря 2026</div>
        <h1>Немного <em>волшебства</em><br>в каждом подарке</h1>
        <p class="lead">Соберите участников, поделитесь пожеланиями и позвольте жеребьёвке найти каждому своего Тайного Санту.</p>
        <div class="actions">
          <button class="btn" id="create">Создать игру</button>
          <button class="btn secondary" id="login">Войти организатору</button>
        </div>
      </div>
      <div class="hero-art"><span class="snow s1">✧</span><span class="snow s2">❄</span><span class="snow s3">✦</span><div class="gift">🎁</div></div>
    </section>
    <section class="card">
      <div class="eyebrow">Как это работает</div>
      <div class="stats">
        <div class="stat"><strong>01</strong><span>Организатор создаёт игру</span></div>
        <div class="stat"><strong>02</strong><span>Участники входят по ссылке и пишут вишлист</span></div>
        <div class="stat"><strong>03</strong><span>Жеребьёвка назначает каждому получателя</span></div>
      </div>
      <p class="sub" style="margin:0">Бюджет по умолчанию: 5 000–10 000 ₸. Вишлист видит только назначенный Тайный Санта.</p>
    </section>`;
  document.getElementById("create").onclick = registerForm;
  document.getElementById("login").onclick = loginForm;
}
function registerForm() {
  app.innerHTML = `<section class="card narrow">
    <div class="eyebrow">Новая игра</div><h2>Создать аккаунт организатора</h2>
    <p class="sub">После регистрации откроется панель управления «Тайный Санта 2026».</p>
    <form id="reg">
      <div class="field"><label>ВАШЕ ИМЯ</label><input name="name" required minlength="2" placeholder="Как к вам обращаться"></div>
      <div class="field"><label>ЭЛЕКТРОННАЯ ПОЧТА</label><input name="email" type="email" required placeholder="name@example.com"></div>
      <div class="field"><label>ПАРОЛЬ (НЕ МЕНЕЕ 10 СИМВОЛОВ)</label><input name="password" type="password" required minlength="10" autocomplete="new-password"></div>
      <div id="msg" class="notice" hidden></div><button class="btn" type="submit">Создать игру</button>
      <button class="text-btn" type="button" id="back">Назад</button>
    </form></section>`;
  document.getElementById("back").onclick = landing;
  document.getElementById("reg").onsubmit = async e => {
    e.preventDefault(); const form = Object.fromEntries(new FormData(e.target));
    try { await api("/api/register",{method:"POST",body:JSON.stringify(form)}); await renderAdmin(); }
    catch(err){setMessage("msg",err.message,"error");}
  };
}
function loginForm() {
  app.innerHTML = `<section class="card narrow"><div class="eyebrow">С возвращением</div><h2>Вход организатора</h2>
    <form id="log"><div class="field"><label>ПОЧТА</label><input name="email" type="email" required></div>
    <div class="field"><label>ПАРОЛЬ</label><input name="password" type="password" required></div>
    <div id="msg" class="notice" hidden></div><button class="btn" type="submit">Войти</button>
    <button class="text-btn" type="button" id="back">Назад</button></form></section>`;
  document.getElementById("back").onclick = landing;
  document.getElementById("log").onsubmit = async e => {
    e.preventDefault(); const form=Object.fromEntries(new FormData(e.target));
    try { await api("/api/login",{method:"POST",body:JSON.stringify(form)}); await renderAdmin(); }
    catch(err){setMessage("msg",err.message,"error");}
  };
}
async function renderAdmin() {
  try { adminData = await api("/api/admin/event"); }
  catch { landing(); return; }
  const {event,participants,pairs,inviteUrl}=adminData;
  app.innerHTML = `<section class="wide">
    <div class="toolbar"><div><div class="eyebrow">Панель организатора</div><h2>${esc(event.title)}</h2><div class="pills"><span class="pill">25 декабря 2026</span><span class="pill">${event.drawn?"Жеребьёвка проведена":"Регистрация открыта"}</span></div></div><button class="btn secondary" id="logout">Выйти</button></div>
    <div class="stats"><div class="stat"><strong>${participants.length}</strong><span>Участников</span></div><div class="stat"><strong>${money(event.budget_min)}–${money(event.budget_max)}</strong><span>Бюджет подарка</span></div><div class="stat"><strong>${event.drawn?"Готово":"Ожидает"}</strong><span>Жеребьёвка</span></div></div>
    <div class="card">
      <div class="section-title" style="margin-top:0">Пригласить участников</div>
      <p class="sub">Отправьте эту ссылку. Каждый участник самостоятельно зарегистрируется и заполнит свой вишлист.</p>
      <div class="linkbox"><input id="invite" readonly value="${esc(inviteUrl)}"><button class="btn" id="copy">Копировать</button></div>
      <div id="copymsg" class="notice success" hidden>Ссылка скопирована.</div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="section-title" style="margin-top:0">Настройки игры</div>
      <form id="settings" class="form-grid">
        <div class="field"><label>МИНИМАЛЬНЫЙ БЮДЖЕТ (₸)</label><input name="budgetMin" type="number" min="0" value="${event.budget_min}" ${event.drawn?"disabled":""}></div>
        <div class="field"><label>МАКСИМАЛЬНЫЙ БЮДЖЕТ (₸)</label><input name="budgetMax" type="number" min="0" value="${event.budget_max}" ${event.drawn?"disabled":""}></div>
        <div class="field"><label>ДАТА ОБМЕНА</label><input name="exchangeDate" type="date" value="${event.exchange_date}" ${event.drawn?"disabled":""}></div>
        <div class="field"><label>РАСКРЫТИЕ ИМЁН</label><select name="revealAfterExchange" ${event.drawn?"disabled":""}><option value="true" ${event.reveal_after_exchange?"selected":""}>После вручения подарков</option><option value="false" ${!event.reveal_after_exchange?"selected":""}>Не раскрывать автоматически</option></select></div>
        ${event.drawn?"":'<div class="field full"><button class="btn secondary" type="submit">Сохранить настройки</button></div>'}
      </form><div id="settingsmsg" class="notice" hidden></div>
    </div>
    <div class="card" style="margin-top:18px">
      <div class="toolbar"><div><div class="section-title" style="margin:0">Участники</div><p class="sub" style="margin:5px 0 0">Их вишлисты не отображаются в этом списке.</p></div></div>
      <div class="participant-list">${participants.length?participants.map(p=>`<div class="person"><div><b>${esc(p.name)}</b><small>В игре</small></div></div>`).join(""):'<div class="empty">Пока никто не присоединился. Отправьте приглашение участникам.</div>'}</div>
      <div class="actions"><button class="btn gold" id="draw" ${event.drawn||participants.length<3?"disabled":""}>Провести жеребьёвку</button></div>
      <div id="drawmsg" class="notice" hidden></div>
    </div>
    ${event.drawn?`<div class="card" style="margin-top:18px"><div class="section-title" style="margin-top:0">Результаты жеребьёвки · только организатор</div>${pairs.map(p=>`<div class="pair-row"><b>${esc(p.giver)}</b><span>→</span><span>${esc(p.receiver)}</span></div>`).join("")}</div>`:""}
  </section>`;
  document.getElementById("logout").onclick=async()=>{await api("/api/logout",{method:"POST"});landing();};
  document.getElementById("copy").onclick=async()=>{try{await navigator.clipboard.writeText(inviteUrl);document.getElementById("copymsg").hidden=false;}catch{document.getElementById("invite").select();}};
  const settings=document.getElementById("settings");
  if(settings) settings.onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(settings));f.revealAfterExchange=f.revealAfterExchange==="true";try{await api("/api/admin/event",{method:"PATCH",body:JSON.stringify(f)});setMessage("settingsmsg","Настройки сохранены.","success");await renderAdmin();}catch(err){setMessage("settingsmsg",err.message,"error");}};
  const draw=document.getElementById("draw");
  if(draw) draw.onclick=async()=>{if(!confirm("Провести жеребьёвку? После этого участники не смогут менять вишлисты."))return;try{await api("/api/admin/draw",{method:"POST",body:"{}"});await renderAdmin();}catch(err){setMessage("drawmsg",err.message,"error");}};
}
async function renderJoin() {
  let event;
  try { event=await api(`/api/join/${encodeURIComponent(joinId)}`); }
  catch(err){app.innerHTML=`<section class="card narrow"><h2>Приглашение недоступно</h2><p class="sub">${esc(err.message)}</p></section>`;return;}
  app.innerHTML=`<section class="card narrow"><div class="eyebrow">Вас пригласили</div><h2>${esc(event.title)}</h2><p class="sub">Присоединяйтесь к игре и оставьте подсказки своему Тайному Санте.</p>
    <div class="notice">Бюджет: ${money(event.budget_min)}–${money(event.budget_max)} · Обмен подарками: ${new Date(event.exchange_date+"T12:00:00").toLocaleDateString("ru-RU",{day:"numeric",month:"long",year:"numeric"})}</div>
    <form id="joinform"><div class="field"><label>ВАШЕ ИМЯ</label><input name="name" required minlength="2" maxlength="80" placeholder="Имя и фамилия"></div><div class="field"><label>ПОЧТА (НЕОБЯЗАТЕЛЬНО)</label><input name="email" type="email" placeholder="Для связи, если понадобится"></div><div id="msg" class="notice" hidden></div><button class="btn" type="submit" ${event.drawn?"disabled":""}>Присоединиться</button></form></section>`;
  document.getElementById("joinform").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));try{const result=await api(`/api/join/${joinId}`,{method:"POST",body:JSON.stringify(f)});history.pushState({}, "", result.participantUrl);location.reload();}catch(err){setMessage("msg",err.message,"error");}};
}
async function renderParticipant() {
  let data;
  try { data=await api(`/api/participant/${encodeURIComponent(participantToken)}`); }
  catch(err){app.innerHTML=`<section class="card narrow"><h2>Ссылка недействительна</h2><p class="sub">${esc(err.message)}</p></section>`;return;}
  const p=data.participant, e=data.event, a=data.assignment;
  app.innerHTML=`<section class="card narrow"><div class="eyebrow">Личный кабинет участника</div><h2>Привет, ${esc(p.name)}!</h2><p class="sub">${esc(e.title)} · ${money(e.budgetMin)}–${money(e.budgetMax)}</p>
    <div class="section-title">Мой вишлист</div><p class="sub">Напишите, что вам было бы приятно получить. Его увидит только назначенный вам Тайный Санта.</p>
    <form id="wish"><div class="field"><textarea name="wishlist" maxlength="3000" placeholder="Например: книги, уютные вещи, чай…">${esc(p.wishlist)}</textarea></div><div id="msg" class="notice" hidden></div><button class="btn" type="submit" ${e.drawn?"disabled":""}>Сохранить вишлист</button></form>
    ${e.drawn?`<div class="notice success">Жеребьёвка проведена! Ваш получатель: <b>${esc(a?.name||"Назначение не найдено")}</b>${a?.wishlist?`<br><br><b>Вишлист:</b><br>${esc(a.wishlist).replace(/\n/g,"<br>")}`:"<br><br>Получатель пока не добавил пожелания."}</div>${data.revealedBy?`<div class="notice">После обмена подарками ваш Тайный Санта: <b>${esc(data.revealedBy)}</b>.</div>`:""}`:'<div class="notice">Когда организатор проведёт жеребьёвку, здесь появится имя человека, которому вы готовите подарок.</div>'}
    <p class="sub" style="font-size:12px;margin:18px 0 0">Сохраните эту личную ссылку — по ней вы сможете вернуться к своему вишлисту.</p></section>`;
  document.getElementById("wish").onsubmit=async ev=>{ev.preventDefault();try{await api(`/api/participant/${participantToken}/wishlist`,{method:"PATCH",body:JSON.stringify({wishlist:new FormData(ev.target).get("wishlist")})});setMessage("msg","Вишлист сохранён!","success");}catch(err){setMessage("msg",err.message,"error");}};
}
async function start() {
  if(joinId) return renderJoin();
  if(participantToken) return renderParticipant();
  try { const me=await api("/api/me"); if(me.loggedIn) return renderAdmin(); }
  catch {}
  landing();
}
start();
