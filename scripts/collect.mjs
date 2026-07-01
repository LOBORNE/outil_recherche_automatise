// scripts/collect.mjs
//
// Interroge l'API Claude (avec l'outil de recherche web) pour trouver les
// actualités récentes sur les bornes de recharge / technologies de charge /
// entreprises du secteur, dédoublonne par rapport aux données existantes,
// et met à jour data/data.json.
//
// Écrit aussi data/new-entries.json avec uniquement les nouveautés de cette
// exécution (utilisé ensuite par send-email.mjs).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data", "data.json");
const NEW_ENTRIES_PATH = path.join(__dirname, "..", "data", "new-entries.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY manquant.");
  process.exit(1);
}

// Si tu veux changer le modèle utilisé, vérifie le nom exact sur
// https://docs.claude.com/en/docs/about-claude/models
const MODEL = "claude-sonnet-5";

// ---------- Utilitaires ----------

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(url).toLowerCase().trim();
  }
}

// Similarité approximative entre deux titres (mots communs / mots totaux)
// pour attraper les reformulations d'une même actu par des sources différentes.
function titleSimilarity(a, b) {
  const words = (s) =>
    new Set(
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    );
  const wa = words(a || "");
  const wb = words(b || "");
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

function loadExisting() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function extractJsonArray(text) {
  // Enlève d'éventuelles balises markdown ```json ... ```
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();

  // Si jamais il y a du texte autour, on isole le premier tableau JSON trouvé.
  const start = cleaned.indexOf("[");
  let end = cleaned.lastIndexOf("]");
  if (start === -1) throw new Error("Aucun tableau JSON trouvé dans la réponse.");

  if (end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  } else {
    cleaned = cleaned.slice(start);
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Réponse probablement tronquée (max_tokens atteint) : on essaie de
    // récupérer les éléments complets en coupant au dernier "}," valide.
    console.warn("JSON invalide, tentative de récupération partielle...");
    const lastCompleteObject = cleaned.lastIndexOf("},");
    if (lastCompleteObject === -1) throw err;
    const salvaged = cleaned.slice(0, lastCompleteObject + 1) + "]";
    return JSON.parse(salvaged);
  }
}

// ---------- Appel à l'API Claude ----------

const today = new Date().toISOString().slice(0, 10);

const systemPrompt = `Tu es un assistant de veille technologique francophone, spécialisé dans les infrastructures de recharge pour véhicules électriques et les technologies de charge associées.`;

const userPrompt = `Recherche sur le web les actualités des 7 à 10 derniers jours (nous sommes le ${today}) concernant :
- Les bornes de recharge (nouveaux déploiements, nouveaux modèles, réseaux de recharge, opérateurs)
- Les nouvelles technologies de recharge (charge ultra-rapide, charge par induction, batteries, nouveaux standards/connecteurs)
- Les entreprises du secteur (levées de fonds, partenariats, lancements, résultats financiers)
- La réglementation liée (normes, subventions, obligations légales)

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ou après, sans balises markdown. Chaque élément doit avoir exactement ces champs :
[
  {
    "title": "titre court et clair",
    "summary": "résumé factuel en 2-3 phrases, en français",
    "url": "URL directe et réelle de la source (trouvée via la recherche web)",
    "source": "nom du site ou média",
    "category": "borne" | "technologie" | "entreprise" | "reglementation"
  }
]

Consignes :
- N'invente jamais d'URL : n'inclus que des sources réellement trouvées par la recherche web.
- Privilégie la diversité des sujets et des sources plutôt que plusieurs articles sur le même événement.
- Maximum 15 éléments.
- Si tu ne trouves rien de pertinent, réponds avec un tableau vide [].`;

async function fetchNews() {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Claude (${response.status}): ${errText}`);
  }

  const data = await response.json();

  if (data.stop_reason === "max_tokens") {
    console.warn(
      "Attention : la réponse a été coupée (max_tokens atteint). Le JSON peut être incomplet."
    );
  }

  const textBlocks = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  try {
    return extractJsonArray(textBlocks);
  } catch (err) {
    console.error("Impossible de parser le JSON renvoyé. Extrait de la réponse :");
    console.error(textBlocks.slice(-1500));
    throw err;
  }
}

// ---------- Programme principal ----------

async function main() {
  const existing = loadExisting();
  const existingUrls = new Set(existing.map((e) => normalizeUrl(e.url)));

  let candidates = [];
  try {
    candidates = await fetchNews();
  } catch (err) {
    console.error("Échec de la récupération des actualités :", err.message);
    process.exit(1);
  }

  const newEntries = [];

  for (const item of candidates) {
    if (!item.url || !item.title) continue;

    const normUrl = normalizeUrl(item.url);
    if (existingUrls.has(normUrl)) continue;

    const isDuplicateTitle = existing.some(
      (e) => titleSimilarity(e.title, item.title) > 0.6
    );
    if (isDuplicateTitle) continue;

    const isDuplicateInBatch = newEntries.some(
      (e) =>
        normalizeUrl(e.url) === normUrl ||
        titleSimilarity(e.title, item.title) > 0.6
    );
    if (isDuplicateInBatch) continue;

    newEntries.push({
      id: crypto.createHash("sha256").update(normUrl).digest("hex").slice(0, 12),
      title: item.title,
      summary: item.summary || "",
      url: item.url,
      source: item.source || "",
      category: item.category || "",
      date_found: today,
    });
  }

  const updated = [...newEntries, ...existing];

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(updated, null, 2));
  fs.writeFileSync(NEW_ENTRIES_PATH, JSON.stringify(newEntries, null, 2));

  console.log(`${newEntries.length} nouvelle(s) entrée(s) ajoutée(s).`);
  console.log(`Total dans data.json : ${updated.length}`);
}

main();
