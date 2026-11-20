app.post("/api/admin/draw", organizerOnly, async (req, res) => {
  const event = await getEvent(req.session.organizerId);

  if (!event) {
    return res.status(404).json({ error: "Событие не найдено." });
  }

  if (event.drawn) {
    return res.status(409).json({ error: "Жеребьёвка уже проведена." });
  }

  const participants = (await query(
    "SELECT id FROM participants WHERE event_id = $1 ORDER BY id",
    [event.id]
  )).rows;

  if (participants.length < 3) {
    return res.status(400).json({
      error: "Для жеребьёвки добавьте минимум трёх участников."
    });
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
  } while (
    receivers.some((r, i) =>
      String(r.id) === String(participants[i].id)
    ) && attempts < 10000
  );

  if (receivers.some((r, i) =>
    String(r.id) === String(participants[i].id)
  )) {
    return res.status(500).json({
      error: "Не удалось выполнить жеребьёвку. Попробуйте ещё раз."
    });
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

    await client.query(
      "UPDATE events SET drawn = TRUE WHERE id = $1",
      [event.id]
    );

    await client.query("COMMIT");

    return res.json({ ok: true });

  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

app.get("/join/:eventId", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get("/p/:token", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log("Тайный Санта 2026 запущен на порту " + port)
  );
}

module.exports = app;
