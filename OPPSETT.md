# Kjøre Nyhetsagent i skyen (GitHub Actions)

Dette gjør at Nyhetsagent kjører automatisk hos GitHub — ikke på din egen maskin.
Du trenger ikke ha PC-en på.

## Hva er med her

- `agent.js` — selve logikken (RSS, filtrering, e-post), uten Electron/UI
- `package.json`
- `.github/workflows/nyhetsagent.yml` — styrer når og hvordan appen kjører
- `state/` — mappe der "sendte saker"-historikk lagres mellom kjøringer

## Steg 1 — Opprett privat repo på GitHub

1. Gå til [github.com](https://github.com) → **+** → **New repository**
2. Navn: `nyhetsagent`
3. Velg **Private**
4. **Create repository**

## Steg 2 — Last opp filene

Enklest med git fra terminal:

```bash
cd nyhetsagent-actions
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<ditt-brukernavn>/nyhetsagent.git
git push -u origin main
```

(Alternativt: dra og slipp filene inn via **Add file → Upload files** på GitHub-siden — husk at `.github/workflows/nyhetsagent.yml` må ligge nøyaktig i den mappestrukturen, så da må du opprette filen manuelt med **Add file → Create new file** og lime inn stien `.github/workflows/nyhetsagent.yml` som filnavn.)

## Steg 3 — Legg inn secrets

Gå til repoet → **Settings → Secrets and variables → Actions → New repository secret**.

Du trenger to filer du allerede har fra den lokale appen:

| Fil på din maskin | Secret-navn |
|---|---|
| `credentials.json` (Google OAuth-klient, lå i src-mappen til Electron-appen) | `GMAIL_CREDENTIALS` |
| `gmail_token.json` (fra `Documents/Nyhetsagent/`) | `GMAIL_TOKEN` |

Åpne hver fil i en teksteditor, kopiér **hele innholdet** (gyldig JSON, med `{` og `}`), og lim inn som verdien til secreten.

**Viktig:** `gmail_token.json` må inneholde et felt `refresh_token`. Uten det kan ikke agenten fornye tilgangen automatisk. Hvis feltet mangler, må du koble til Gmail på nytt i den lokale Electron-appen først (det er den som genererer `refresh_token`), og deretter kopiere den oppdaterte filen.

Legg i tillegg inn:

| Secret-navn | Verdi |
|---|---|
| `EMAIL_TO` | E-postadressen som skal motta sammendragene |
| `ANTHROPIC_KEY` | Din `sk-ant-...`-nøkkel (valgfritt — for AI-generert oppsummering) |
| `SPOTIFY_CLIENT_ID` | Valgfritt — for trendende låter i ukesoppsummeringen |
| `SPOTIFY_CLIENT_SECRET` | Valgfritt |

## Steg 4 — Test

1. Gå til **Actions**-fanen i repoet
2. Klikk **Nyhetsagent** i venstre meny
3. Klikk **Run workflow** → velg `test` → **Run workflow**
4. Sjekk innboksen din etter ca. 30–60 sekunder

Fungerer testen, kan du prøve `morning`, `evening` og `weekly` på samme måte.

## Automatisk kjøring

Workflow-filen har tre faste tidspunkt (UTC, så norsk klokketid kan avvike ±1 time pga. sommertid):

- Ca. kl. 07–08 norsk tid → morgenoppsummering
- Ca. kl. 22–23 norsk tid → kveldoppsummering
- Fredag ca. kl. 08–09 norsk tid → ukentlig oppsummering

Vil du justere tidspunktene, endre `cron`-linjene i `.github/workflows/nyhetsagent.yml` (bruk f.eks. [crontab.guru](https://crontab.guru) til å bygge uttrykket) — husk å oppdatere `case`-blokken i samme fil så riktig modus matches til riktig tidspunkt.

## Hvorfor er det ikke kontinuerlig oppdatering (5 min-intervall) lenger?

Den lokale Electron-appen kunne sjekke feeder hvert 5. minutt og sende varsler fortløpende. GitHub Actions har en praktisk nedre grense på ca. 5 minutter for `schedule`, men det ville brukt svært mange kjøretimer i måneden på et privat repo (gratis kvote er 2000 min/mnd). Løsningen her kjører derfor bare på faste tidspunkt (morgen/kveld/ukentlig), slik den lokale appen allerede gjorde for sammendragene. Ønsker du hyppigere varsler likevel, kan du sette `cron` tettere, men vær obs på kvoten.

## Sikkerhet

- `credentials.json` og `gmail_token.json` skal **aldri** legges i selve repoet — bare som secrets.
- `state/`-mappen inneholder kun anonym metadata (hashede titler/lenker for å unngå duplikate varsler), ingen hemmeligheter.
