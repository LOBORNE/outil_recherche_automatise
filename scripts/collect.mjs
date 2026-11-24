// scripts/collect.mjs
//
// Interroge l'API Mistral (avec l'outil de recherche web) pour trouver les
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

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
if (!MISTRAL_API_KEY) {
  console.error("MISTRAL_API_KEY manquant.");
  process.exit(1);
}

// Si tu veux changer le modèle utilisé, vérifie le nom exact sur
// https://docs.mistral.ai/getting-started/models/
const MODEL = "mistral-large-2512";

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
    console.log("JSON invalide, tentative de récupération partielle...");
    const lastCompleteObject = cleaned.lastIndexOf("},");
    if (lastCompleteObject === -1) throw err;
    const salvaged = cleaned.slice(0, lastCompleteObject + 1) + "]";
    return JSON.parse(salvaged);
  }
}

// ---------- Appel à l'API Mistral ----------

const today = new Date().toISOString().slice(0, 10);

const systemPrompt = `Tu es un assistant de veille technologique francophone, spécialisé dans les infrastructures de recharge pour véhicules électriques et les technologies de charge associées.`;

// Thèmes de la veille. Ils sont tous traités dans UNE seule requête : la
// recherche web Mistral a un quota propre, vite épuisé avec un appel par thème.
const THEMES = [
  {
    category: "borne",
    focus:
      "les bornes de recharge : nouveaux déploiements, nouveaux modèles de bornes, réseaux de recharge, opérateurs de recharge",
  },
  {
    category: "technologie",
    focus:
      "les nouvelles technologies de recharge : charge ultra-rapide, charge par induction, batteries, nouveaux standards et connecteurs",
  },
  {
    category: "entreprise",
    focus:
      "les entreprises du secteur de la recharge : levées de fonds, partenariats, lancements de produits, résultats financiers",
  },
  {
    category: "reglementation",
    focus:
      "la réglementation liée à la recharge de véhicules électriques : normes, subventions, obligations légales, décisions publiques",
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CATEGORIES = THEMES.map((t) => t.category);
const MAX_PER_CATEGORY = 4;

function buildPrompt() {
  const themesList = THEMES.map((t) => `- "${t.category}" : ${t.focus}`).join("\n");
  return `Recherche sur le web les actualités des 7 à 10 derniers jours (nous sommes le ${today}) sur les thèmes suivants (identifiant de catégorie entre guillemets) :
${themesList}

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ou après, sans balises markdown. Chaque élément doit avoir exactement ces champs :
[
  {
    "category": "un des identifiants : ${CATEGORIES.join(", ")}",
    "title": "titre court et clair",
    "summary": "résumé factuel en 2-3 phrases, en français",
    "url": "URL directe et réelle de la source (trouvée via la recherche web)",
    "source": "nom du site ou média"
  }
]

Consignes :
- N'invente jamais d'URL : n'inclus que des sources réellement trouvées par la recherche web.
- Privilégie la diversité des sujets et des sources plutôt que plusieurs articles sur le même événement.
- Maximum ${MAX_PER_CATEGORY} éléments par catégorie.
- Si tu ne trouves rien de pertinent pour une catégorie, n'en mets pas ; si rien du tout, réponds [].`;
}

// Attente avant nouvelle tentative après un 429 : 60 s, puis 120 s, puis 180 s.
const RETRY_BASE_MS = 60_000;
const MAX_RETRIES = 3;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Collecte récursivement toutes les URL présentes dans les sorties de l'API
// (chunks "tool_reference", résultats d'exécution de web_search...), quel que
// soit l'endroit exact où Mistral les place.
function collectUrls(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) collectUrls(child, out);
  } else if (node && typeof node === "object") {
    if (typeof node.url === "string") out.push(node.url);
    for (const value of Object.values(node)) collectUrls(value, out);
  }
  return out;
}

// Extrait d'une réponse /v1/conversations le texte final et les sources
// renvoyées par l'outil web_search.
function parseConversation(data) {
  const texts = [];
  for (const entry of data.outputs || []) {
    if (entry.type !== "message.output") continue;
    const content = entry.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    for (const chunk of content || []) {
      if (chunk.type === "text" && chunk.text) texts.push(chunk.text);
    }
  }
  return { text: texts.join(""), references: collectUrls(data.outputs || [], []) };
}

// Vérifie qu'une URL mène à une vraie page. 401/403/429 = page existante mais
// protégée contre les robots : on l'accepte. 404, erreur DNS, timeout : rejet.
async function urlExists(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; veille-recharge/1.0)" },
    });
    res.body?.cancel().catch(() => {});
    return res.status < 400 || [401, 403, 429].includes(res.status);
  } catch {
    return false;
  }
}

async function fetchNews(attempt = 1) {
  const response = await fetch("https://api.mistral.ai/v1/conversations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: systemPrompt,
      inputs: buildPrompt(),
      tools: [{ type: "web_search" }],
      completion_args: { temperature: 0.3 },
      store: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    // En cas de 429, on attend de plus en plus longtemps puis on réessaie.
    if (response.status === 429 && attempt <= MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * attempt;
      console.log(
        `  erreur 429 reçu (${errText.slice(0, 120)}), nouvelle tentative dans ${waitMs / 1000}s (essai ${attempt + 1})`
      );
      await sleep(waitMs);
      return fetchNews(attempt + 1);
    }
    throw new Error(`Erreur API Mistral (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const { text, references } = parseConversation(data);

  let items;
  try {
    items = extractJsonArray(text);
  } catch (err) {
    console.error("JSON illisible. Extrait :");
    console.error(text.slice(-1000));
    return [];
  }

  // Garde-fou contre les URL inventées : un article est retenu si son site
  // figure parmi les sources de la recherche web, ou sinon si son URL mène
  // réellement à une page.
  const referenceHosts = new Set(references.map(hostOf).filter(Boolean));
  console.log(`${items.length} article(s) proposé(s), ${referenceHosts.size} site(s) source renvoyé(s) par la recherche`);
  const verified = [];
  const perCategory = {};
  for (const it of items) {
    if (!it || !it.url) continue;
    if (!CATEGORIES.includes(it.category)) {
      console.log(`  écarté (catégorie inconnue "${it.category}") : ${it.url}`);
      continue;
    }
    if ((perCategory[it.category] || 0) >= MAX_PER_CATEGORY) continue;
    if (referenceHosts.has(hostOf(it.url)) || (await urlExists(it.url))) {
      verified.push(it);
      perCategory[it.category] = (perCategory[it.category] || 0) + 1;
    } else {
      console.log(`  écarté (lien introuvable) : ${it.url}`);
    }
  }
  for (const c of CATEGORIES) console.log(`  → ${perCategory[c] || 0} résultat(s) pour ${c}`);
  return verified;
}

// ---------- Programme principal ----------

async function main() {
  const existing = loadExisting();
  const existingUrls = new Set(existing.map((e) => normalizeUrl(e.url)));

  let candidates = [];
  try {
    console.log(`Recherche des actualités (${CATEGORIES.join(", ")})...`);
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

  const MAX_ENTRIES = 100;

  const updated = [...newEntries, ...existing];
  updated.sort((a, b) => (b.date_found || "").localeCompare(a.date_found || ""));

  const trimmed = updated.slice(0, MAX_ENTRIES);
  const removedCount = updated.length - trimmed.length;

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(trimmed, null, 2));
  fs.writeFileSync(NEW_ENTRIES_PATH, JSON.stringify(newEntries, null, 2));

  console.log(`${newEntries.length} nouvelle(s) entrée(s) ajoutée(s).`);
  if (removedCount > 0) {
    console.log(`${removedCount} ancienne(s) entrée(s) supprimée(s) (limite de ${MAX_ENTRIES} atteinte).`);
  }
  console.log(`Total dans data.json : ${trimmed.length}`);
}

main();
