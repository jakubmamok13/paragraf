// Database migrations. Append-only: never edit a migration that has shipped.
//
// Ids of everything that travels between devices are UUIDs (TEXT), so a
// content package from the laptop and a progress package from the phone merge
// by id without collisions. Each such row has updated_at for "newer wins".

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

  -- Deleted rows, so a package can remove them on the other device.
  CREATE TABLE tombstone (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL,
    PRIMARY KEY (table_name, id));

  ---------- subjects and exams ----------
  CREATE TABLE subject (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',            -- active | maintenance | archived
    target_retention REAL,                            -- NULL = global setting
    daily_new_limit INTEGER,                          -- NULL = planner decides
    color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE exam (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'egzamin',             -- egzamin | kolokwium | zaliczenie
    format TEXT NOT NULL,                             -- ustny | test | opisowy | kazusy | mieszany
    date TEXT,                                        -- YYYY-MM-DD, NULL = not known yet
    note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX exam_by_subject ON exam (subject_id);

  ---------- sources ----------
  CREATE TABLE legal_act (id TEXT PRIMARY KEY, abbrev TEXT NOT NULL, title TEXT NOT NULL,
    journal_ref TEXT, state_as_of TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE source_document (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                               -- act | note | textbook | syllabus | exam_list
    title TEXT NOT NULL, file_name TEXT, file_hash TEXT, lecture_date TEXT, legal_act_id TEXT,
    version INTEGER NOT NULL DEFAULT 1, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE source_chunk (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL, heading_path TEXT, page_from INTEGER, page_to INTEGER,
    text TEXT NOT NULL, text_hash TEXT NOT NULL, processed_at TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX chunk_by_doc ON source_chunk (document_id, ord);
  CREATE INDEX chunk_by_hash ON source_chunk (text_hash);

  ---------- knowledge map ----------
  CREATE TABLE section (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    parent_id TEXT, title TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'manual',            -- syllabus | act | textbook | note | manual
    updated_at TEXT NOT NULL);
  CREATE TABLE topic (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    section_id TEXT, name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',             -- draft | active
    exam_weight REAL NOT NULL DEFAULT 0, exam_weight_override REAL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX topic_by_subject ON topic (subject_id);
  CREATE TABLE topic_field (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    field_type TEXT NOT NULL,                         -- definition | premise | element | effect | exception
                                                      -- | deadline | case_law | doctrine | ratio
    ord INTEGER NOT NULL DEFAULT 0, content_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',            -- active | conflicted | superseded
    updated_at TEXT NOT NULL);
  CREATE TABLE provision_ref (id TEXT PRIMARY KEY, act_id TEXT, article TEXT NOT NULL, paragraph TEXT, point TEXT,
    raw TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE topic_field_provision (topic_field_id TEXT NOT NULL REFERENCES topic_field(id) ON DELETE CASCADE,
    provision_ref_id TEXT NOT NULL REFERENCES provision_ref(id) ON DELETE CASCADE,
    PRIMARY KEY (topic_field_id, provision_ref_id));
  CREATE TABLE topic_relation (id TEXT PRIMARY KEY, from_topic TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    to_topic TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                               -- is_a | distinguish | exception_to | applies_mutatis
    updated_at TEXT NOT NULL);
  CREATE TABLE citation (id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,                         -- topic_field | material
    owner_id TEXT NOT NULL, chunk_id TEXT NOT NULL REFERENCES source_chunk(id) ON DELETE CASCADE,
    quote TEXT NOT NULL, char_start INTEGER, char_end INTEGER, verified INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL);
  CREATE INDEX citation_by_owner ON citation (owner_type, owner_id);
  CREATE TABLE source_conflict (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    field_type TEXT NOT NULL,
    kind TEXT NOT NULL,                               -- provision_number | content | doctrine | outdated
    candidates_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution_json TEXT,
    resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

  ---------- learning materials ----------
  CREATE TABLE material (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                               -- qa | cloze | list | provision | distinction | why
                                                      -- | case | oral | table
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',           -- pending | active | rejected | suspended | needs_review
    too_easy INTEGER NOT NULL DEFAULT 0, generation_run_id TEXT, prompt_version TEXT,
    edited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX material_by_topic ON material (topic_id);
  CREATE INDEX material_by_status ON material (status);
  CREATE TABLE material_field (material_id TEXT NOT NULL REFERENCES material(id) ON DELETE CASCADE,
    topic_field_id TEXT NOT NULL REFERENCES topic_field(id) ON DELETE CASCADE,
    PRIMARY KEY (material_id, topic_field_id));

  ---------- spaced repetition (state lives on the phone) ----------
  CREATE TABLE review_item (id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES material(id) ON DELETE CASCADE,
    sub_key TEXT NOT NULL DEFAULT '',                 -- cloze gap / list item; '' = whole material
    due TEXT NOT NULL, stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0,
    elapsed_days REAL NOT NULL DEFAULT 0, scheduled_days REAL NOT NULL DEFAULT 0, learning_steps INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
    last_review TEXT, buried_until TEXT, suspended INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    UNIQUE (material_id, sub_key));
  CREATE INDEX review_by_due ON review_item (due);
  CREATE TABLE review_log (id TEXT PRIMARY KEY, review_item_id TEXT NOT NULL REFERENCES review_item(id) ON DELETE CASCADE,
    ts TEXT NOT NULL, rating INTEGER NOT NULL, confidence INTEGER, duration_ms INTEGER,
    mode TEXT NOT NULL,                               -- daily | after_lecture | subject | distinguish | case | exam | feynman
    counted_in_fsrs INTEGER NOT NULL DEFAULT 1, answer_text TEXT, ai_suggested_rating INTEGER);
  CREATE INDEX log_by_item ON review_log (review_item_id, ts);

  ---------- law changes ----------
  CREATE TABLE amendment (id TEXT PRIMARY KEY, act_id TEXT NOT NULL REFERENCES legal_act(id) ON DELETE CASCADE,
    effective_date TEXT NOT NULL, provisions_json TEXT NOT NULL DEFAULT '[]', note TEXT, updated_at TEXT NOT NULL);

  ---------- local AI calls (time and cache, no money involved) ----------
  CREATE TABLE ai_call (id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL,
    input_hash TEXT NOT NULL, output_json TEXT, duration_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER,
    status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
  CREATE INDEX ai_call_cache ON ai_call (prompt_id, prompt_version, model, input_hash);
  `,
  // v2: undo of the last answer needs the card state from before it.
  `
  ALTER TABLE review_log ADD COLUMN prev_state_json TEXT;
  `,
  // v3: processing pipeline.
  `
  ALTER TABLE topic ADD COLUMN emphasis INTEGER NOT NULL DEFAULT 0;       -- times the lecturer stressed it
  ALTER TABLE topic ADD COLUMN on_exam_list INTEGER NOT NULL DEFAULT 0;   -- 0 no, 1 syllabus, 2 exam list
  ALTER TABLE subject ADD COLUMN learn_article_numbers INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE suggestion (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    topic_id TEXT, chunk_id TEXT,
    kind TEXT NOT NULL,                               -- gap | rejected_field | rejected_material
    text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE job (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                               -- extract | generate
    document_id TEXT, topic_ids_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued',            -- queued | running | paused | done | error
    done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE topic_generation (topic_id TEXT PRIMARY KEY REFERENCES topic(id) ON DELETE CASCADE,
    fields_hash TEXT NOT NULL, generated_at TEXT NOT NULL);
  `,
];
