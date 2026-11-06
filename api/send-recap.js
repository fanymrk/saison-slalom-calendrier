// Fonction serveur Vercel : e-mails de récap et de confirmation des inscriptions (réservée à l'administrateur).
// Variables d'environnement à créer dans Vercel : SUPABASE_SECRET_KEY, SMTP_USER, SMTP_PASS
// (facultatives : SUPABASE_URL, SMTP_HOST, SMTP_PORT)
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const LVL = { N1: "N1", N2: "N2", N3: "N3", R: "Régional", C: "Championnat", O: "Open" };
const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const when = (c) => (c.start_date === c.end_date ? fmt(c.start_date) : `du ${fmt(c.start_date)} au ${fmt(c.end_date)}`);
const full = (p) => `${p.first_name} ${p.last_name}`.trim();

// Petit modèle : intro + blocs (titre, lignes) + conclusion -> texte brut et HTML
function mail(intro, blocks, outro) {
  const text = [intro, ...blocks.map((b) => `\n${b.h} (${b.items.length})\n` + (b.items.length ? b.items.map((i) => "- " + i).join("\n") : "- Personne")), outro ? `\n${outro}` : ""].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;color:#07123F;line-height:1.5"><p>${esc(intro)}</p>`
    + blocks.map((b) => `<h3 style="margin:18px 0 6px;color:#1262D6">${esc(b.h)} (${b.items.length})</h3>` + (b.items.length ? "<ul>" + b.items.map((i) => `<li>${esc(i)}</li>`).join("") + "</ul>" : "<p>Personne</p>")).join("")
    + (outro ? `<p>${esc(outro)}</p>` : "") + `<p style="color:#4A5B8A;font-size:13px">CK Lagny</p></div>`;
  return { text, html };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const key = (process.env.SUPABASE_SECRET_KEY || "").trim();
    if (!key) throw new Error("La variable SUPABASE_SECRET_KEY est introuvable dans Vercel.");
    const admin = createClient((process.env.SUPABASE_URL || "https://ahowyusieltusuvfnktw.supabase.co").trim(), key, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Seul un administrateur actif peut envoyer
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u || !u.user) return res.status(401).json({ error: "Non connecté" });
    const { data: me } = await admin.from("profiles").select("role, active").eq("id", u.user.id).single();
    if (!me || me.role !== "admin" || !me.active) return res.status(403).json({ error: "Réservé à l'administrateur" });

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const id = Number(b.competition_id);
    if (!id) throw new Error("Compétition manquante.");

    // 2. Données
    const get = async (q) => { const r = await q; if (r.error) throw r.error; return r.data; };
    const comp = await get(admin.from("competitions").select("*").eq("id", id).single());
    const club = await get(admin.from("competition_club").select("*").eq("competition_id", id).single());
    if (!club || club.registration !== "closed") throw new Error("Passe d'abord les inscriptions sur « Fermées » pour envoyer le récap.");
    const [resp, comps, judges, profiles, exc, contacts, logs] = await Promise.all([
      get(admin.from("responses").select("*").eq("competition_id", id)),
      get(admin.from("companions").select("*").eq("competition_id", id)),
      get(admin.from("judges").select("*").eq("competition_id", id)),
      get(admin.from("profiles").select("*")),
      get(admin.from("exceptions").select("*").eq("competition_id", id)),
      get(admin.from("member_contacts").select("*")),
      get(admin.from("recap_log").select("sent_at").eq("competition_id", id).order("sent_at", { ascending: false }).limit(1)),
    ]);
    const P = Object.fromEntries(profiles.map((p) => [p.id, p])), E = Object.fromEntries(contacts.map((c) => [c.member_id, c.email]));
    const boats = (r) => (r.boats && r.boats.length ? " – " + r.boats.join(" + ") : "");
    const label = (r) => `${full(P[r.member_id] || { first_name: "Un membre", last_name: "" })}${boats(r)}`;
    const yes = resp.filter((r) => r.status === "yes"), maybe = resp.filter((r) => r.status === "maybe"), no = resp.filter((r) => r.status === "no");
    const answered = new Set(resp.map((r) => r.member_id)), excSet = new Set(exc.map((e) => e.member_id));
    const eligible = (p) => excSet.has(p.id) || (comp.categories || []).some((c) => ((p.boat_levels || {})[c] || []).includes(comp.level));
    const silent = profiles.filter((p) => p.active && ["member", "admin"].includes(p.role) && !answered.has(p.id) && eligible(p));
    const acc = comps.filter((c) => c.status === "yes"), coaches = profiles.filter((p) => p.role === "coach" && p.active);
    const coachName = coaches.length ? coaches[0].first_name : "l'entraîneur";
    const head = `${comp.name} – ${when(comp)} à ${comp.place}`;

    // 3. Qui reçoit quoi
    const adminMail = E[u.user.id];
    const recapTo = [...new Set([adminMail, ...coaches.map((c) => E[c.id])].filter(Boolean))];
    const coachTo = [...new Set(coaches.map((c) => E[c.id]).filter(Boolean))];
    const participants = yes.filter((r) => E[r.member_id]);
    const missing = [];
    if (!adminMail) missing.push(`${full(P[u.user.id] || {first_name:"Toi",last_name:""})} (toi, pour recevoir le récap)`);
    coaches.filter((c) => !E[c.id]).forEach((c) => missing.push(`${full(c)} (entraîneur)`));
    yes.filter((r) => !E[r.member_id]).forEach((r) => missing.push(full(P[r.member_id] || { first_name: "Un membre", last_name: "" })));
    const last = logs && logs[0] ? logs[0].sent_at : null;
    const smtpOk = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

    if (b.dry_run) return res.status(200).json({ ok: true, competition: comp.name, recap_to: recapTo, coach_to: coachTo, to_register: yes.length, participants: participants.map((r) => full(P[r.member_id])), missing, last_sent: last, smtp_ok: smtpOk });

    if (!smtpOk) throw new Error("Les variables SMTP_USER et SMTP_PASS sont introuvables dans Vercel (nom exact, puis redéployer).");
    if (last && !b.force) throw new Error("Un envoi a déjà eu lieu pour cette compétition.");

    // 4. Les trois e-mails
    const out = [];
    const recap = mail(`Récap des inscriptions pour ${head}.`, [
      { h: "Compétiteurs (Je viens)", items: yes.map(label) },
      { h: "Je ne sais pas encore", items: maybe.map(label) },
      { h: "Ne viennent pas", items: no.map(label) },
      { h: "Sans réponse (éligibles)", items: silent.map(full) },
      { h: "Accompagnateurs", items: acc.map((r) => full(P[r.member_id] || { first_name: "Un membre", last_name: "" })) },
      { h: "Juges", items: judges.map(full) },
    ]);
    recapTo.forEach((to) => out.push({ to, kind: "recap", subject: `Récap inscriptions – ${comp.name}`, ...recap }));
    const todo = mail(`Bonjour ${coachName}, voici les personnes à inscrire pour ${head} (niveau ${LVL[comp.level] || comp.level}).`,
      [{ h: "Personnes à inscrire", items: yes.map(label) }],
      "Merci de me confirmer, en répondant à ce mail, que cette liste est correcte et que tu t'occupes des inscriptions.");
    coachTo.forEach((to) => out.push({ to, kind: "coach", subject: `À inscrire – ${comp.name} (${yes.length} personne${yes.length > 1 ? "s" : ""})`, ...todo }));
    participants.forEach((r) => {
      const p = P[r.member_id];
      const m = mail(`Bonjour ${p.first_name}, ton inscription${r.boats && r.boats.length ? " en " + r.boats.join(" + ") : ""} à ${head} a bien été prise en compte. Elle sera effectuée prochainement par ${coachName}.`, [], "Tu n'as rien d'autre à faire. À bientôt sur l'eau !");
      out.push({ to: E[r.member_id], kind: "participant", subject: `Ton inscription – ${comp.name}`, ...m });
    });

    // 5. Envoi (3 à la fois)
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port: +(process.env.SMTP_PORT || 465), secure: String(process.env.SMTP_PORT || 465) === "465", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, pool: true, maxConnections: 3 });
    const from = `"CK Lagny" <${process.env.SMTP_USER}>`;
    let sent = 0; const failed = [];
    for (let i = 0; i < out.length; i += 3) {
      await Promise.all(out.slice(i, i + 3).map((m) => t.sendMail({ from, replyTo: from, to: m.to, subject: m.subject, text: m.text, html: m.html })
        .then(() => { sent++; }).catch((e) => failed.push({ to: m.to, error: e.message }))));
    }
    if (sent) await admin.from("recap_log").insert({ competition_id: id, sent_by: u.user.id, counts: { recap: recapTo.length, coach: coachTo.length, participants: participants.length, failed: failed.length } });
    return res.status(200).json({ ok: true, sent, failed, missing });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Erreur" });
  }
};
