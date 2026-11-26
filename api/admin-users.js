// Fonction serveur Vercel : gestion des comptes membres (réservée à l'administrateur).
// Variable d'environnement à créer dans Vercel : SUPABASE_SECRET_KEY (SUPABASE_URL est facultative)
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

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
    const { data: p } = await admin.from("profiles").select("role, active, guardian_id").eq("id", u.user.id).single();
    if (!p || !p.active) return res.status(403).json({ error: "Compte inactif ou introuvable" });

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const ok = (extra) => res.status(200).json({ ok: true, ...(extra || {}) });
    const need = (c) => { if (!c || String(c).length < 6) throw new Error("Le code doit faire au moins 6 caractères."); };

    // Profils rattachés : ouvert à tout adhérent (pour ses propres profils)
    if (b.action === "add_dependent") {
      if (p.guardian_id) throw new Error("Un profil rattaché ne peut pas en rattacher d'autres.");
      if (!["member", "admin"].includes(p.role)) throw new Error("Réservé aux adhérents.");
      const first = String(b.first_name || "").trim(), last = String(b.last_name || "").trim();
      if (!first || !last) throw new Error("Prénom et nom obligatoires.");
      const { data: kids } = await admin.from("profiles").select("id").eq("guardian_id", u.user.id);
      if ((kids || []).length >= 6) throw new Error("Nombre maximum de profils rattachés atteint (6).");
      // compte technique : il ne se connecte jamais (mot de passe aléatoire, connexion bloquée)
      const { data, error } = await admin.auth.admin.createUser({
        email: `dep-${crypto.randomUUID()}@${ID_DOM}`,
        password: crypto.randomBytes(24).toString("hex"),
        email_confirm: true,
        ban_duration: "876000h",
        user_metadata: { first_name: first, last_name: last },
      });
      if (error) throw error;
      const { error: e2 } = await admin.from("profiles").update({ guardian_id: u.user.id }).eq("id", data.user.id);
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); throw e2; }
      return ok({ id: data.user.id });
    }
    if (b.action === "remove_dependent") {
      const { data: t } = await admin.from("profiles").select("guardian_id").eq("id", b.id).single();
      if (!t || !t.guardian_id) throw new Error("Profil rattaché introuvable.");
      if (t.guardian_id !== u.user.id && p.role !== "admin") throw new Error("Ce profil n'est pas rattaché à ton compte.");
      const { error } = await admin.auth.admin.deleteUser(b.id);
      if (error) throw error;
      return ok();
    }

    // Tout le reste est réservé à l'administrateur
    if (p.role !== "admin") return res.status(403).json({ error: "Réservé à l'administrateur" });

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
      if (b.role === "coach") {
        const { error: e3 } = await admin.from("profiles").update({ role: "coach" }).eq("id", data.user.id);
        if (e3) throw e3;
      }
      return ok({ id: data.user.id });
    }

    if (!b.id) throw new Error("Membre manquant.");

    if (b.action === "set_role") {
      if (b.id === u.user.id) throw new Error("Tu ne peux pas changer ton propre rôle.");
      if (!["member", "coach"].includes(b.role)) throw new Error("Rôle inconnu.");
      const { data: t } = await admin.from("profiles").select("role").eq("id", b.id).single();
      if (!t) throw new Error("Membre introuvable.");
      if (t.role === "admin") throw new Error("Le rôle d'un administrateur ne se change pas ici.");
      const { error } = await admin.from("profiles").update({ role: b.role }).eq("id", b.id);
      if (error) throw error;
      return ok();
    }
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
      const { data: kids } = await admin.from("profiles").select("id").eq("guardian_id", b.id);
      for (const k of kids || []) await admin.auth.admin.deleteUser(k.id);   // les profils rattachés partent avec leur compte principal
      const { error } = await admin.auth.admin.deleteUser(b.id);
      if (error) throw error;
      return ok();
    }
    throw new Error("Action inconnue.");
  } catch (e) {
    return res.status(400).json({ error: e.message || "Erreur" });
  }
};
