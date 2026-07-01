// scripts/send-email.mjs
//
// Envoie un email listant uniquement les nouveautés collectées lors de la
// dernière exécution (data/new-entries.json), via l'API Resend.
//
// Alternative sans Resend : voir la note en bas de fichier pour utiliser
// nodemailer + un compte Gmail (mot de passe d'application).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_ENTRIES_PATH = path.join(__dirname, "..", "data", "new-entries.json");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const PAGE_URL = process.env.PAGE_URL || "";

if (!RESEND_API_KEY || !TO_EMAIL) {
  console.log("RESEND_API_KEY ou TO_EMAIL manquant : email non envoyé.");
  process.exit(0);
}

let newEntries = [];
try {
  newEntries = JSON.parse(fs.readFileSync(NEW_ENTRIES_PATH, "utf-8"));
} catch {
  newEntries = [];
}

if (newEntries.length === 0) {
  console.log("Aucune nouveauté cette semaine, pas d'email envoyé.");
  process.exit(0);
}

const itemsHtml = newEntries
  .map(
    (e) => `
    <li style="margin-bottom:16px;">
      <strong>${e.title}</strong> <span style="color:#888;">(${e.source || "source inconnue"})</span><br/>
      <span>${e.summary || ""}</span><br/>
      <a href="${e.url}">${e.url}</a>
    </li>`
  )
  .join("\n");

const html = `
  <div style="font-family:sans-serif;max-width:600px;">
    <h2>🔌 Veille bornes de recharge — ${newEntries.length} nouveauté(s)</h2>
    <ul style="padding-left:20px;">${itemsHtml}</ul>
    ${PAGE_URL ? `<p>Voir l'historique complet : <a href="${PAGE_URL}">${PAGE_URL}</a></p>` : ""}
  </div>
`;

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: `Veille recharge VE — ${newEntries.length} nouveauté(s)`,
    html,
  }),
});

if (!res.ok) {
  console.error("Erreur envoi email :", await res.text());
  process.exit(1);
}

console.log("Email envoyé avec succès.");

// ---------------------------------------------------------------------
// Alternative sans Resend (compte Gmail + nodemailer) :
//
// npm install nodemailer
//
// import nodemailer from "nodemailer";
// const transporter = nodemailer.createTransport({
//   service: "gmail",
//   auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
// });
// await transporter.sendMail({
//   from: process.env.GMAIL_USER,
//   to: TO_EMAIL,
//   subject: `Veille recharge VE — ${newEntries.length} nouveauté(s)`,
//   html,
// });
//
// (nécessite un "mot de passe d'application" Google, pas ton mot de passe normal)
// ---------------------------------------------------------------------
