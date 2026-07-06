# Veille — Bornes de recharge & mobilité électrique

Veille automatisée hebdomadaire (GitHub Actions) sur :
- les bornes de recharge (déploiements, nouveaux modèles, réseaux)
- les technologies de recharge (charge rapide, induction, batteries, standards)
- les entreprises du secteur (levées de fonds, partenariats, lancements)
- la réglementation

Chaque semaine :
1. Un script interroge l'API Claude (avec recherche web) et récupère les actualités récentes.
2. Les résultats sont dédoublonnés (par URL et par similarité de titre) par rapport à ce qui a déjà été collecté, puis ajoutés à `data/data.json`. Au-delà de 100 entrées, les plus anciennes sont automatiquement supprimées.
3. Une page web (`site/index.html`, filtrable par catégorie et mot-clé) est publiée sur GitHub Pages. Les entrées jamais consultées sur ce navigateur apparaissent dans une section "Nouveautés" séparée (suivi via `localStorage`, propre à chaque navigateur).
4. Un email récapitulatif est envoyé, listant uniquement les nouveautés de la semaine.

## Mise en place

### 1. Placer le projet

Copie ce dossier `veille/` à la racine de ton repo (par ex. dans `projets/`), ou utilise-le comme repo dédié — les deux fonctionnent, il est autonome.

### 2. Secrets GitHub à configurer

Dans **Settings → Secrets and variables → Actions** du repo, ajoute :

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Ta clé API Anthropic (console.anthropic.com) |
| `RESEND_API_KEY` | Clé API Resend pour l'envoi d'email (voir ci-dessous) |
| `TO_EMAIL` | L'adresses email qui doivent recevoir la notification séparé par une virgule |
| `FROM_EMAIL` | Depuis quel mail (pas forcement existant) |
| `PAGE_URL` | L'URL de la page GitHub Pages une fois activée (ex: `https://<user>.github.io/<repo>/`) — optionnel, juste pour le lien dans l'email |

### 3. Créer un compte Resend (envoi d'email)

[resend.com](https://resend.com) propose un niveau gratuit largement suffisant pour un email hebdomadaire.
- Crée un compte, récupère une clé API → `RESEND_API_KEY`.
- **Important** : en mode "sandbox" (sans domaine vérifié), Resend n'autorise l'envoi qu'à l'adresse email associée à ton compte. Pour envoyer à n'importe quelle adresse, il faut vérifier un domaine (gratuit aussi, ça prend quelques minutes via un enregistrement DNS).
- Alternative sans Resend : `scripts/send-email.mjs` contient en commentaire une version avec Gmail + nodemailer si tu préfères.

### 4. Activer GitHub Pages

Après le premier passage du workflow (qui crée la branche `gh-pages`) :
- **Settings → Pages → Source** : sélectionne la branche `gh-pages`, dossier `/ (root)`.
- L'URL sera de la forme `https://<ton-user>.github.io/<repo>/`.

### 5. Tester manuellement

Avant d'attendre le lundi, tu peux déclencher le workflow à la main :
**Actions → Veille bornes de recharge → Run workflow**.

Tu peux aussi tester en local :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node scripts/collect.mjs
# vérifie data/data.json et data/new-entries.json

export RESEND_API_KEY=re_...
export TO_EMAIL=toi@example.com
node scripts/send-email.mjs
```

## Structure

```
veille-recharge/
├── .github/workflows/veille.yml   # cron hebdo + orchestration
├── scripts/
│   ├── collect.mjs                # appel API Claude + dédoublonnage
│   └── send-email.mjs             # email des nouveautés (Resend)
├── data/
│   └── data.json                  # base de données (source de vérité)
├── site/
│   └── index.html                 # page consultable (GitHub Pages)
└── package.json
```
