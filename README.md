# Mio kunnskapsbase – chat

Intern chat-assistent som svarer på spørsmål fra administrasjonen **utelukkende** basert på artiklene i Mios Salesforce Knowledge-base.

- **Prototype:** Next.js på Vercel · Postgres + pgvector (Neon) · Claude Opus 5.5 via Anthropic API · OpenAI-embeddings
- **Produksjon (mål):** Samme kode på Azure · Azure Database for PostgreSQL (pgvector) · Claude via Microsoft Foundry *eller* Azure OpenAI · Azure OpenAI-embeddings (EU-region) · Entra ID

Alt som skal byttes mellom prototype og produksjon er miljøvariabler, ikke kode.

---

## Arkitektur

```
Salesforce Knowledge ──export/REST──▶ data/raw ──normalize──▶ data/canonical/articles.jsonl
                                                                      │
                                                                   ingest  (chunk → embed → upsert)
                                                                      ▼
                                                       Postgres: articles, chunks(embedding, tsv)
                                                                      ▲
Bruker ──▶ Chat UI ──▶ POST /api/chat ──▶ gate 1 ──▶ retrieval (hybrid) ──▶ gate 2 ──▶ gate 3 (Haiku) ──▶ gate 4 (Opus) ──▶ stream
                                              │                                                                      │
                                              └──────────────────────── query_log ◀──────────────────────────────────┘
```

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
npm run kb:normalize && npm run kb:ingest
```

De 11 første dokumentene ligger i `data/pdf/` og er ferdig konvertert i `data/raw/kvalitetsdokumenter.json` (begge er gitignorert – internt Mio-innhold). Bilder i dokumentene (skjermbilder, ikoner) tas ikke med.

### Retrieval

Artikler deles i ~600-token-biter (med tittel + kategorier som prefiks) og embeddes med `text-embedding-3-large` (1536 dimensjoner). Søk er hybrid: pgvector cosine + Postgres fulltekst (`norwegian`), slått sammen med reciprocal rank fusion og gruppert per artikkel. De `ANSWER_TOP_ARTICLES` beste **hele** artiklene sendes til modellen.

### Blockers (gates) – billigst først

| Gate | Hva | Kostnad |
|---|---|---|
| 0 | Innlogging (Entra ID) + rate limiting | **Hoppet over i prototypen** |
| 1 | Min/maks lengde, normalisering, eksakt-gjentak-cache (`answer_cache`) | Gratis |
| 2 | Beste cosine-score < `RETRIEVAL_MIN_SCORE` → avvis uten LLM-kall | Ett embedding-kall |
| 3 | Haiku 5.5-klassifisering: `in_scope` / `out_of_scope` / `clarify`, med kategoritreet som scope-definisjon | ~300 cachede tokens |
| 4 | Streng, cachet systemprompt («svar kun fra vedlagte artikler, oppgi kilder»), `ANSWER_MAX_TOKENS`, kun siste `HISTORY_MAX_MESSAGES` meldinger | Det eneste dyre kallet |

Alle avgjørelser logges i `query_log` med spørsmål, gate, beste score, artikkel-ID-er og tokenbruk. Bruk den til å justere `RETRIEVAL_MIN_SCORE` og til å finne hull i kunnskapsbasen (`WHERE gate = 'gate2_no_match'`).

---

## Kom i gang

```bash
npm install
cp .env.example .env.local        # fyll inn DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY
npm run db:migrate                # oppretter pgvector-extension og tabeller

# Prøv med de innebygde eksempelartiklene:
npm run kb:normalize -- data/sample
npm run kb:ingest

npm run dev                       # http://localhost:3000
```

Uten API-nøkler kan hele pipelinen likevel kjøres lokalt med `EMBEDDING_PROVIDER=fake` (deterministiske hash-embeddings). Sett da `RETRIEVAL_MIN_SCORE=0` – de falske vektorene gir lave scorer. Gate 3 og 4 krever ekte nøkkel.

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
4. `npm run kb:normalize && npm run kb:ingest` – ingest er idempotent (uendrede artikler hoppes over, fjernede slettes).

**API-drevet (senere):** `npm run kb:fetch-salesforce` henter det samme via REST med `SF_INSTANCE_URL` + `SF_ACCESS_TOKEN`. I Azure blir dette en timer-trigget Function med `WHERE LastPublishedDate > :sist` for inkrementell synk.

### Postgres-hosting

**Prototype (Vercel):** Supabase eller Neon – begge har pgvector, EU-regioner og gratisnivå som holder til 4 000 artikler (~120 MB vektorer + indeks; 500 MB-grensen er nær, men ikke overskredet). Opprett prosjektet i **Frankfurt (eu-central-1)** slik at innholdet blir i EU også under prototypen. Aktiver `vector`-extension (Supabase: Database → Extensions; `db:migrate` gjør det også). Bruk den **poolede** tilkoblingsstrengen i `DATABASE_URL` på Vercel (Supabase Supavisor port 6543 i transaction mode / Neon `-pooler`-host) – serverless-funksjoner åpner og lukker tilkoblinger hele tiden. Lokal `kb:ingest` kan bruke direkte tilkobling. Neon vinner bare hvis du vil ha Vercel Marketplace-integrasjonen (automatisk `DATABASE_URL`, database-branch per preview).

**Produksjon (Azure):** **Azure Database for PostgreSQL Flexible Server** i Norway East (eller Sweden Central hvis Mios øvrige ressurser står der).
- Legg `vector` til i serverparameteren `azure.extensions` *før* `db:migrate`, ellers nektes `CREATE EXTENSION`.
- Størrelse: Burstable **B2s** (2 vCPU / 4 GB) med 32 GB lagring er rikelig; ca. €30–40/mnd. General Purpose først ved flere kunnskapsbaser eller mange brukere. Zone-redundant HA er unødvendig for en intern KB; automatisk backup (7–35 dager) holder.
- Nettverk: privat tilgang (server i VNet, App Service/Container App VNet-integrert) så databasen ikke har offentlig endepunkt. Offentlig tilgang med brannmurregler fungerer for første deploy.
- Autentisering: **Entra ID** med managed identity i stedet for passord – ingen `DATABASE_URL`-hemmelighet å rotere. Krever en liten endring i `src/lib/db.ts` (hent token via `@azure/identity` og send som passord). Inntil da: passord i Key Vault.
- Skalering: slå på innebygd **PgBouncer** (port 6432) hvis App Service kjører flere instanser.
- Alternativ: Azure AI Search hvis Mios team allerede bruker det (semantisk reranker, managed indexers) – koster mer (Basic ≈ €70/mnd + Postgres for `query_log`) og `src/lib/retrieval.ts` må skrives om. Anbefaler pgvector med mindre de insisterer.

### Deploy til Vercel

1. Opprett Supabase/Neon-database i Frankfurt (se over), kjør `npm run db:migrate` mot den.
2. Sett miljøvariablene fra `.env.example` i Vercel.
3. Kjør `kb:normalize` + `kb:ingest` lokalt mot databasen (embeddings genereres én gang).
4. `vercel deploy`.

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

`EMBEDDING_PROVIDER=openai` → `azure-openai` bytter til Azure OpenAI-deployment av **samme modell**, så indeksen bygget i prototypen kan gjenbrukes uten re-embedding. `EMBEDDING_DIMENSIONS` må aldri endres etter ingest.

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
| Supabase/Neon (Frankfurt) | Azure Database for PostgreSQL Flexible Server (Norway East) med `vector`-extension – samme `db/schema.sql` |
| Anthropic API | Foundry (`LLM_PROVIDER=foundry`) eller Azure OpenAI |
| OpenAI-embeddings | Azure OpenAI-embeddings i EU-region, samme modell |
| Fil-eksport fra Salesforce | Azure Function (timer) → Salesforce REST → ingest |
| Ingen innlogging | Entra ID (gate 0) + rate limiting; `user_id` i `query_log` er klar |

Hvis Mios team foretrekker **Azure AI Search** fremfor pgvector, er `src/lib/retrieval.ts` den eneste modulen som byttes.

## Struktur

```
db/schema.sql                      tabeller + indekser (pgvector, tsvector, query_log, answer_cache)
data/sample/                       Salesforce-formet eksempeleksport (CSV)
data/pdf/ · data/raw/              Mios PDF-utskrifter og konvertert JSON (gitignorert)
scripts/                           migrate · normalize · ingest · fetch-salesforce · pdf_to_canonical.py
src/lib/schema.ts                  kanonisk Article (zod)
src/lib/salesforce/                field-mapping · normalize (HTML → Markdown, kategorier)
src/lib/chunk.ts                   chunking
src/lib/embeddings/                OpenAI / Azure OpenAI / fake
src/lib/llm/                       Anthropic / Foundry / Azure OpenAI bak ett grensesnitt
src/lib/retrieval.ts               hybrid søk + RRF
src/lib/gates.ts                   gate 1–3
src/lib/prompts.ts                 gate 4 (systemprompt + artikkelkontekst)
src/lib/answer.ts                  orkestrering + logging
src/app/api/chat/route.ts          NDJSON-streaming
src/app/components/Chat.tsx        chat-UI
```
