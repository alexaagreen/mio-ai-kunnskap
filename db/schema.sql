-- Mio KB schema. Runs on Neon (prototype) and Azure Database for PostgreSQL Flexible Server (production) unchanged.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per published Salesforce Knowledge article (canonical form, see src/lib/schema.ts).
CREATE TABLE IF NOT EXISTS articles (
  id               text PRIMARY KEY,             -- Salesforce KnowledgeArticleId (stable across versions)
  article_number   text,
  title            text NOT NULL,
  summary          text,
  body_md          text NOT NULL,
  categories       text[] NOT NULL DEFAULT '{}', -- "Group/Category" paths
  language         text NOT NULL DEFAULT 'no',
  version          integer,
  last_published   timestamptz,
  source_url       text,
  content_hash     text NOT NULL,                -- sha256 of title+summary+body; skip re-embedding when unchanged
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Articles are split into ~600-token chunks for embedding; the whole article is still passed to the model.
CREATE TABLE IF NOT EXISTS chunks (
  id           bigserial PRIMARY KEY,
  article_id   text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,                   -- text that was embedded (title + categories + chunk body)
  embedding    vector(1536) NOT NULL,           -- must match EMBEDDING_DIMENSIONS
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('norwegian', content)) STORED,
  UNIQUE (article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_gin ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_article_idx ON chunks (article_id);

-- Every question, with the gate decision, so thresholds can be tuned and KB gaps found.
CREATE TABLE IF NOT EXISTS query_log (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  session_id      text,
  user_id         text,                          -- filled when Entra login is added
  question        text NOT NULL,
  gate            text NOT NULL,                 -- answered | cached | gate1_too_short | gate1_too_long | gate2_no_match | gate3_out_of_scope | gate3_clarify | error
  best_score      real,
  article_ids     text[] NOT NULL DEFAULT '{}',
  answer          text,
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  cache_read_tokens integer,
  latency_ms      integer
);

-- Exact-repeat cache for single-turn questions (gate 1b).
CREATE TABLE IF NOT EXISTS answer_cache (
  question_hash   text PRIMARY KEY,
  question        text NOT NULL,
  answer          text NOT NULL,
  article_ids     text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  hits            integer NOT NULL DEFAULT 0
);
