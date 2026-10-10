# Mio kunnskapsbase – chat

Intern chat-assistent som svarer på spørsmål fra administrasjonen **utelukkende** basert på artiklene i Mios Salesforce Knowledge-base.

- **Prototype:** Next.js på Vercel · **filbasert indeks** (`data/index/index.json`, ingen database) · Claude Opus 5.5 + Haiku 5.5 via Anthropic API · **ingen embeddings** (kun én nøkkel)
- **Produksjon (mål):** Samme kode på Azure · **Postgres + pgvector** (Azure Database for PostgreSQL) · Claude via Microsoft Foundry *eller* Azure OpenAI · Azure OpenAI-embeddings (EU-region) · Entra ID

Alt som skal byttes mellom prototype og produksjon er miljøvariabler, ikke kode. `STORE=file` → `STORE=postgres` er det eneste bytte som også krever et nytt kjøreskript (`kb:ingest` i stedet for `kb:index`).

---

## Arkitektur

```
PDF-utskrifter / Salesforce-eksport / REST ──▶ data/raw ──normalize──▶ data/canonical/articles.jsonl
                                                                               │
                                        STORE=file:  kb:index ──▶ data/index/index.json (lastes i minnet)
                                        STORE=postgres: kb:ingest ──▶ Postgres: articles, chunks(embedding, tsv)
                                                                               ▲
Bruker ──▶ Chat UI ──▶ POST /api/chat ──▶ gate 1 ──▶ retrieval (hybrid) ──▶ gate 2 ──▶ gate 3 (Haiku) ──▶ gate 4 (Opus) ──▶ stream
                                              │                                                                      │
                                              └──────────────────────── query_log ◀──────────────────────────────────┘
```

### Lagring: fil nå, Postgres ved live

`src/lib/store/` er det eneste stedet som vet hvor dataene ligger. `STORE` i `.env` velger backend:

| | `STORE=file` (prototype) | `STORE=postgres` (live) |
|---|---|---|
| Kunnskapsbase | `data/index/index.json` – chunks + embeddings, bygget av `npm run kb:index`, lastet i minnet ved oppstart | `articles` + `chunks` i Postgres/pgvector, fylt av `npm run kb:ingest` |
| Vektorsøk | cosine i minnet | pgvector HNSW |
| Nøkkelordsøk | innebygd BM25 | `tsvector('norwegian')` |
| `query_log` | stdout (Vercel-loggen) + `data/logs/query_log.jsonl` lokalt | tabell `query_log` |
| Svar-cache | i minnet per instans (nullstilles ved cold start) | tabell `answer_cache` |
| Passer til | de ~11–200 første dokumentene | hele kunnskapsbasen (4 000 artikler ≈ 250 MB vektorer – for mye for en JSON-fil) |

**Ved live:** sett `STORE=postgres` og `DATABASE_URL`, kjør `npm run db:migrate && npm run kb:ingest`. Ingen kodeendring. Merk at med `STORE=file` må `data/canonical/` og `data/index/` ligge i repoet (appen trenger dem ved kjøretid), så repoet må være privat – det er Mios interne innhold.

### Kanonisk artikkelformat

`src/lib/schema.ts` definerer kontrakten mellom innhenting og app. Salesforce-feltnavn finnes **kun** i `src/lib/salesforce/field-mapping.ts`. Når den ekte eksporten kommer: oppdater mappingen (spesielt `bodyFields`), kjør `kb:normalize` og se at `data/canonical/articles.jsonl` ser riktig ut.

Mios kvalitetsdokumenter har en fast struktur, og den kanoniske formen speiler den:

| Felt | Innhold |
|---|---|
| `id` | `KnowledgeArticleId` (`ka0…`, stabil på tvers av versjoner) |
| `articleNumber` | Dokumentnr. (`000001939`) |
| `title`, `version`, `lastPublished` | Tittel, Versjon, Publisert |
| `summary` | Første avsnitt under «Formål» |
| `bodyMd` | Metadatalinje (Dokumenttype · Dokumentansvarlig · Selskap · Publisert · Neste revidering), deretter `## Formål`, `## Omfang/virkeområde`, `## Definisjoner`, `## Aktivitet/beskrivelse`, `## Hjemmel`, `## Ansvar`, `## Relaterte dokumenter` – med underoverskrifter, punktlister, nummererte lister og tabeller bevart som Markdown |
| `categories` | `Dokumenttype/Rutiner`, `Selskap/Mio BPA`, `Dokumentansvarlig/HMS`, … (+ eventuelle Salesforce-datakategorier) |
| `sourceUrl` | `${SF_INSTANCE_URL}/lightning/r/Knowledge__kav/${Id}/view` |
| `metadata` | Rå metadata fra kilden (Neste revidering osv.) |

Kun rader med `PublishStatus = Online` tas med. Metadatalinjen og kategoriene gjør at modellen kan svare på «hvem er ansvarlig for …» og «gjelder dette Mio BPA?», og at klassifisereren (gate 3) kjenner omfanget.

### Fra PDF-utskrifter (det vi har i dag)

Utskriftene fra Salesforce (`Kvalitetsdokument_Utskrift?id=ka0…`) konverteres direkte til kanonisk format av `scripts/pdf_to_canonical.py`, som leser layouten (fontstørrelse/fet for overskrifter, tegnede kulepunkter, tabeller, lenker):

```bash
pip install pymupdf
python3 scripts/pdf_to_canonical.py data/pdf/*.pdf -o data/raw/kvalitetsdokumenter.json
npm run kb:build                  # (STORE=postgres: npm run kb:normalize && npm run kb:ingest)
```

De 11 første dokumentene ligger i `data/pdf/` og er ferdig konvertert i `data/raw/kvalitetsdokumenter.json` (begge er gitignorert – internt Mio-innhold). Bilder i dokumentene (skjermbilder, ikoner) tas ikke med.

### Retrieval

Artikler deles i ~600-token-biter (med tittel + kategorier som prefiks). `EMBEDDING_PROVIDER` velger søkemetode:

| | `none` (prototype) | `openai` / `azure-openai` |
|---|---|---|
| Nøkler | kun `ANTHROPIC_API_KEY` | + OpenAI/Azure OpenAI |
| Søk | BM25-nøkkelordsøk gir kandidater, så leser **Haiku 5.5 katalogen** (tittel, sammendrag, kategorier for alle artikler – cachet systemprompt) og velger inntil 4 artikler | hybrid: vektor (cosine) + nøkkelord, reciprocal rank fusion |
| Gate 3 | ruteren gir scope-vurderingen i samme kall – ingen ekstra Haiku-kall | eget Haiku-kall |
| Pris | ett Haiku-kall per spørsmål (katalogen er cachet, ~10 % pris) – også for spørsmål som er helt utenfor tema | embedding-kall + Haiku kun ved treff |
| Passer til | opp til noen hundre artikler (over `ROUTER_CATALOGUE_MAX=300` ser ruteren bare nøkkelordkandidatene) | hele kunnskapsbasen |

Ved live (4 000 artikler, `STORE=postgres`) byttes til `azure-openai`-embeddings – pgvector krever vektorer. De `ANSWER_TOP_ARTICLES` beste **hele** artiklene sendes til modellen i begge moduser.

### Blockers (gates) – billigst først

| Gate | Hva | Kostnad |
|---|---|---|
| 0 | Innlogging (Entra ID) + rate limiting | **Hoppet over i prototypen** |
| 1 | Min/maks lengde, normalisering, eksakt-gjentak-cache (`answer_cache`) | Gratis |
| 2 | Ingen artikkel funnet (ruter valgte ingen / beste cosine-score < `RETRIEVAL_MIN_SCORE`) → avvis | Ruter-kall / ett embedding-kall |
| 3 | Haiku 5.5-klassifisering: `in_scope` / `out_of_scope` / `clarify`, med kategoritreet som scope-definisjon (inkludert i ruter-kallet når embeddings er av) | ~300 cachede tokens |
| 4 | Streng, cachet systemprompt («svar kun fra vedlagte artikler, oppgi kilder»), `ANSWER_MAX_TOKENS`, kun siste `HISTORY_MAX_MESSAGES` meldinger | Det eneste dyre kallet |

Alle avgjørelser logges i `query_log` med spørsmål, gate, beste score, artikkel-ID-er og tokenbruk. Bruk den til å justere `RETRIEVAL_MIN_SCORE` og til å finne hull i kunnskapsbasen (`WHERE gate = 'gate2_no_match'`).

---

## Kom i gang

```bash
npm install
cp .env.example .env.local        # fyll inn ANTHROPIC_API_KEY (STORE=file og EMBEDDING_PROVIDER=none er standard)

npm run kb:build                  # data/raw/*.json → data/canonical/articles.jsonl → data/index/index.json
npm run dev                       # http://localhost:3000
```

`data/raw/kvalitetsdokumenter.json` (de 11 konverterte dokumentene) ligger allerede klar, og `data/index/index.json` er ferdig bygget for `EMBEDDING_PROVIDER=none`, så det eneste som mangler er nøkkelen. Eksempeldata i Salesforce-CSV-form: `npm run kb:normalize -- data/sample && npm run kb:index`.

Vil du ha vektorsøk i prototypen: sett `EMBEDDING_PROVIDER=openai` + `OPENAI_API_KEY` og kjør `kb:index` på nytt (uendrede artikler gjenbrukes ved senere kjøringer). `EMBEDDING_PROVIDER=fake` gir deterministiske hash-vektorer for lokal testing uten nøkler (sett da `RETRIEVAL_MIN_SCORE=0.2`).

### Ekte Salesforce-eksport

1. Eksporter publiserte artikler, f.eks. med Data Loader / Workbench:
   ```sql
   SELECT Id, KnowledgeArticleId, ArticleNumber, Title, UrlName, Summary, Language, PublishStatus,
          VersionNumber, LastPublishedDate, Answer__c, Details__c        -- bytt til Mios faktiske rich-text-felt
   FROM Knowledge__kav
   WHERE PublishStatus = 'Online' AND Language = 'no' AND IsLatestVersion = true
   ```
   og eventuelt `SELECT ParentId, DataCategoryGroupName, DataCategoryName FROM Knowledge__DataCategorySelection`.
2. Legg CSV/JSON-filene i `data/raw/` (filnavnet for kategorier må inneholde «DataCategory»).
3. Oppdater `src/lib/salesforce/field-mapping.ts` hvis feltnavnene avviker.
4. `npm run kb:build` (fil) eller `npm run kb:normalize && npm run kb:ingest` (Postgres) – begge er idempotente (uendrede artikler hoppes over, fjernede slettes).

**API-drevet (senere):** `npm run kb:fetch-salesforce` henter det samme via REST med `SF_INSTANCE_URL` + `SF_ACCESS_TOKEN`. I Azure blir dette en timer-trigget Function med `WHERE LastPublishedDate > :sist` for inkrementell synk.

### Postgres-hosting (fra `STORE=postgres`)

**Hostet prototype (Vercel):** Supabase eller Neon – begge har pgvector, EU-regioner og gratisnivå som holder til 4 000 artikler (~120 MB vektorer + indeks; 500 MB-grensen er nær, men ikke overskredet). Opprett prosjektet i **Frankfurt (eu-central-1)** slik at innholdet blir i EU også under prototypen. Aktiver `vector`-extension (Supabase: Database → Extensions; `db:migrate` gjør det også). Bruk den **poolede** tilkoblingsstrengen i `DATABASE_URL` på Vercel (Supabase Supavisor port 6543 i transaction mode / Neon `-pooler`-host) – serverless-funksjoner åpner og lukker tilkoblinger hele tiden. Lokal `kb:ingest` kan bruke direkte tilkobling. Neon vinner bare hvis du vil ha Vercel Marketplace-integrasjonen (automatisk `DATABASE_URL`, database-branch per preview).

**Produksjon (Azure):** **Azure Database for PostgreSQL Flexible Server** i Norway East (eller Sweden Central hvis Mios øvrige ressurser står der).
- Legg `vector` til i serverparameteren `azure.extensions` *før* `db:migrate`, ellers nektes `CREATE EXTENSION`.
- Størrelse: Burstable **B2s** (2 vCPU / 4 GB) med 32 GB lagring er rikelig; ca. €30–40/mnd. General Purpose først ved flere kunnskapsbaser eller mange brukere. Zone-redundant HA er unødvendig for en intern KB; automatisk backup (7–35 dager) holder.
- Nettverk: privat tilgang (server i VNet, App Service/Container App VNet-integrert) så databasen ikke har offentlig endepunkt. Offentlig tilgang med brannmurregler fungerer for første deploy.
- Autentisering: **Entra ID** med managed identity i stedet for passord – ingen `DATABASE_URL`-hemmelighet å rotere. Krever en liten endring i `src/lib/db.ts` (hent token via `@azure/identity` og send som passord). Inntil da: passord i Key Vault.
- Skalering: slå på innebygd **PgBouncer** (port 6432) hvis App Service kjører flere instanser.
- Alternativ: Azure AI Search hvis Mios team allerede bruker det (semantisk reranker, managed indexers) – koster mer (Basic ≈ €70/mnd + Postgres for `query_log`) og `src/lib/retrieval.ts` må skrives om. Anbefaler pgvector med mindre de insisterer.

### Deploy til Vercel

1. `npm run kb:build` lokalt og commit `data/canonical/` + `data/index/` (privat repo).
2. Sett miljøvariablene fra `.env.example` i Vercel (`STORE=file`, nøkler, modeller).
3. `vercel deploy`. `next.config.ts` sørger for at `data/index/` følger med serverless-funksjonen.

Ny versjon av kunnskapsbasen = kjør `kb:build` på nytt og deploy.

---

## Modellvalg

Prototypen kjører **Claude Opus 5.5** (`ANSWER_MODEL`) med `ANSWER_EFFORT=low` og adaptiv tenkning skjult. Opus 5.5 kan ikke skru av tenkning, så hvert svar har en latens- og tokenbunn.

**Anbefaling for produksjon:** `ANSWER_MODEL=claude-sonnet-5-5` som standard, med eskalering til Opus når klassifisereren eller svaret indikerer et komplekst spørsmål (f.eks. mange artikler med jevn score, eller svaret inneholder «finner jeg ikke»). Haiku 5.5 beholdes som klassifiserer. Dette er kun konfig – ingen kodeendring utover eskaleringslogikken i `src/lib/answer.ts`.

## Leverandørbytte

`LLM_PROVIDER` velger klient i `src/lib/llm/`:

| Verdi | Klient | Merknad |
|---|---|---|
| `anthropic` | `@anthropic-ai/sdk` | Prototype |
| `foundry` | `@anthropic-ai/foundry-sdk` (`AnthropicFoundry`) | Samme Messages API. Foundry støtter **ikke** Batches, Files API, Skills eller server-side web-verktøy – vi bruker ingen av dem. |
| `azure-openai` | `openai` (`AzureOpenAI`, Responses API) | Fallback med garantert EU-inferens |

`EMBEDDING_PROVIDER`: `none` (prototype, kun Anthropic) → `azure-openai` ved live. Har man brukt `openai` i prototypen, er Azure OpenAI-deployment av **samme modell** vektor-kompatibel, så indeksen kan gjenbrukes uten re-embedding. `EMBEDDING_DIMENSIONS` må aldri endres etter ingest.

## ⚠️ EU-dataresidens – må avklares med Mio

Per oktober 2026 tilbyr Claude på Microsoft Foundry kun *Global Standard* og *US Data Zone* – **ingen EU-datasone**. Anthropic er fortsatt databehandler, og flagget innhold kan rutes utenfor Azure-grensen. Anthropics direkte API har heller ikke EU-inferens. EU-residens for Claude finnes i dag bare på AWS Bedrock og Google Vertex.

Mio må velge ett av:
1. Godta Global Standard på Foundry under Microsofts/Anthropics DPA og standard overføringsmekanismer (vanlig for interne KB-er uten persondata).
2. Vente på EU-datasonen (Anthropic oppgir «kommer 2026», uten dato).
3. Kjøre produksjon på **Azure OpenAI** i Sweden Central / Norway East (`LLM_PROVIDER=azure-openai`) – garantert EU-inferens, samme app.

Kilder: [InfoQ](https://www.infoq.com/news/2026/07/claude-foundry-ga-europe/), [Claude in Microsoft Foundry](https://platform.claude.com/docs/build-with-claude/claude-in-microsoft-foundry).

## Migrering til Azure

| Prototype | Produksjon |
|---|---|
| Vercel | Azure App Service / Container Apps (samme Next.js-build) |
| `STORE=file` (index.json i minnet) | `STORE=postgres` → Azure Database for PostgreSQL Flexible Server (Norway East) med `vector`-extension – `db/schema.sql` |
| Anthropic API | Foundry (`LLM_PROVIDER=foundry`) eller Azure OpenAI |
| Ingen embeddings (Haiku-ruter) | Azure OpenAI-embeddings i EU-region (`EMBEDDING_PROVIDER=azure-openai`) – pgvector krever vektorer |
| Fil-eksport fra Salesforce | Azure Function (timer) → Salesforce REST → ingest |
| Ingen innlogging | Entra ID (gate 0) + rate limiting; `user_id` i `query_log` er klar |

Hvis Mios team foretrekker **Azure AI Search** fremfor pgvector, er `src/lib/retrieval.ts` den eneste modulen som byttes.

## Struktur

```
db/schema.sql                      Postgres-skjema (STORE=postgres): pgvector, tsvector, query_log, answer_cache
data/sample/                       Salesforce-formet eksempeleksport (CSV)
data/pdf/ · data/raw/              Mios PDF-utskrifter og konvertert JSON (gitignorert)
data/canonical/ · data/index/      normalisert jsonl og ferdig indeks med embeddings (committes, privat repo)
scripts/                           normalize · index (fil) · migrate + ingest (Postgres) · fetch-salesforce · pdf_to_canonical.py
src/lib/store/                     file-store (prototype) · pg-store (live) bak ett grensesnitt
src/lib/schema.ts                  kanonisk Article (zod)
src/lib/salesforce/                field-mapping · normalize (HTML → Markdown, kategorier)
src/lib/chunk.ts                   chunking
src/lib/embeddings/                none / OpenAI / Azure OpenAI / fake
src/lib/llm/                       Anthropic / Foundry / Azure OpenAI bak ett grensesnitt
src/lib/retrieval.ts               hybrid søk + RRF, eller BM25 + Haiku-ruter når embeddings er av
src/lib/gates.ts                   gate 1–3
src/lib/prompts.ts                 gate 4 (systemprompt + artikkelkontekst)
src/lib/answer.ts                  orkestrering + logging
src/app/api/chat/route.ts          NDJSON-streaming
src/app/components/Chat.tsx        chat-UI
```
