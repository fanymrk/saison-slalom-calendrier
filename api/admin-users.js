// Fonction serveur Vercel : gestion des comptes membres (réservée à l'administrateur).
// Variable d'environnement à créer dans Vercel : SUPABASE_SECRET_KEY (SUPABASE_URL est facultative)
const { createClient } = require("@supabase/supabase-js");

const ID_DOM = "ck-lagny.example"; // doit être identique à ID_DOM dans index.html
const slug = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const url = (process.env.SUPABASE_URL || "https://ahowyusieltusuvfnktw.supabase.co").trim();
    const key = (process.env.SUPABASE_SECRET_KEY || "").trim();
    if (!key) throw new Error("La variable SUPABASE_SECRET_KEY est introuvable dans Vercel (nom exact, puis redéployer).");
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Qui appelle ? (le jeton vient de la session du navigateur)
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u || !u.user) return res.status(401).json({ error: "Non connecté" });

    // 2. Est-ce un administrateur actif ? (vérifié dans la base, pas dans le navigateur)
    const { data: p } = await admin.from("profiles").select("role, active").eq("id", u.user.id).single();
    if (!p || p.role !== "admin" || !p.active) return res.status(403).json({ error: "Réservé à l'administrateur" });

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const ok = (extra) => res.status(200).json({ ok: true, ...(extra || {}) });
    const need = (c) => { if (!c || String(c).length < 6) throw new Error("Le code doit faire au moins 6 caractères."); };

    if (b.action === "create") {
      const first = String(b.first_name || "").trim(), last = String(b.last_name || "").trim();
      if (!first || !last) throw new Error("Prénom et nom obligatoires.");
      need(b.code);
      const { data, error } = await admin.auth.admin.createUser({
        email: `${slug(first)}.${slug(last)}@${ID_DOM}`,
        password: String(b.code),
        email_confirm: true,
        user_metadata: { first_name: first, last_name: last },
      });
      if (error) throw new Error(/already|registered|exists/i.test(error.message) ? "Ce prénom et ce nom existent déjà." : error.message);
      return ok({ id: data.user.id });
    }

    if (!b.id) throw new Error("Membre manquant.");

    if (b.action === "reset_code") {
      need(b.code);
      const { error } = await admin.auth.admin.updateUserById(b.id, { password: String(b.code) });
      if (error) throw error;
      return ok();
    }
    if (b.action === "set_active") {
      if (b.id === u.user.id) throw new Error("Tu ne peux pas désactiver ton propre compte.");
      const { error } = await admin.auth.admin.updateUserById(b.id, { ban_duration: b.active ? "none" : "876000h" });
      if (error) throw error;
      const { error: e2 } = await admin.from("profiles").update({ active: !!b.active }).eq("id", b.id);
      if (e2) throw e2;
      return ok();
    }
    if (b.action === "delete") {
      if (b.id === u.user.id) throw new Error("Tu ne peux pas supprimer ton propre compte.");
      const { error } = await admin.auth.admin.deleteUser(b.id);
      if (error) throw error;
      return ok();
    }
    throw new Error("Action inconnue.");
  } catch (e) {
    return res.status(400).json({ error: e.message || "Erreur" });
  }
};
