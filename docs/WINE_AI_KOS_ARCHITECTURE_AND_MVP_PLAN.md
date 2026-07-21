# WINE AI Knowledge Operating System (WINE AI KOS)
## Архитектурный проект и План реализации MVP (v2.0)

---

## 1. Анализ текущей архитектуры репозитория WINE AI

На основе проведенного аудита репозитория `wine-ai-realtime` (2026-07-20) определены ключевые параметры существующей системы:

### 1.1. Текущая архитектура Frontend
* **Стек**: Vanilla HTML5, CSS3, JavaScript (ES6+), Web Audio API, native WebSocket API.
* **Основной интерфейс**: `public/dashboard.html` — единая клиентская панель управления и взаимодействия с AI-соммелье.
* **Модульность KOS**: Чтобы не раздувать монолитный `public/dashboard.html`, интерфейсы KOS выносятся в отдельный фронтенд-модуль `public/kos/` (`public/kos/kosDashboard.js`, `public/kos/kosDashboard.css`).

### 1.2. Текущая архитектура Backend
* **Стек**: Node.js (CommonJS), встроенный модуль `http` (без Express/Fastify). Единый входной файл `src/server.js`.
* **Сервер**: HTTP REST API + WebSocket сервер (`/realtime`), примонтированный через `attachRealtimeServer()` (`src/realtime/realtimeServer.js`).
* **Модули**: `src/realtime/`, `src/persona/`, `src/knowledge/`, `src/tools/`, `src/avatar/`.
* **Изоляция KOS**: Новый модуль размещается в `src/kos/`. На этапе первого Vertical Slice KOS **не подключается напрямую к существующему `searchWineKnowledge.js`**, а работает через отдельный контракты `kosRetrievalService.js` только для Preview Text Chat (Draft vs Published).

### 1.3. База данных и Хранение Источников (Source Storage)
* **PostgreSQL** — основное хранилище метаданных, нормализованных сущностей, фактов, версий профиля, тестов и audit log (`DATABASE_URL`).
* **Хранилище оригиналов источников**:
  * PostgreSQL `BYTEA`/`TEXT` (для метаданных и бинарных/текстовых оригиналов в MVP) с контрольными суммами SHA-256 (`checksum_sha256`).
  * Для масштабирования поддерживается S3-совместимое объектное хранилище (AWS S3 / Supabase Storage).
  * **Файловая система Railway запрещена** для хранения постоянных оригиналов из-за эфемерности при деплоях.

### 1.4. Способ миграций и Идемпотентность
* Миграции выполняются идемпотентно через `src/kos/db/kosSchema.js` при старте приложения с помощью SQL DDL (`CREATE TABLE IF NOT EXISTS`).
* **Extraction Fingerprint**: Каждый прогон экстракции записывает fingerprint: `source_checksum` + `parser_version` + `extractor_version` + `schema_version` + `prompt_version` + `model_version`, гарантируя идемпотентность и исключая повторную обработку неизмененных данных.

### 1.5. Авторизация, Роли и Скопирование (Auth & Roles)
* Минимальная авторизация и модель ролей для KOS до появления production-эндпоинтов записи:
  * **Admin**: Полные права на управление винодельнями, публикацию, rollback и bypass Quality Gate.
  * **Editor**: Загрузка источников, запуск экстракции, редактирование фактов.
  * **Reviewer**: Подтверждение/отклонение кандидатов фактов и разрешение конфликтов.
  * **Winery Scope**: Каждый запрос изолирован контекстом `winery_id`.
  * **Audit Actor**: Фиксация `verified_by` и `published_by` для каждого действия.

### 1.6. Защита от Prompt Injection
* Любой текст с веб-сайта, PDF или интервью рассматривается **исключительно как ненадежные данные источника**, а не как системная команда.
* Защитный препроцессинг и системный промпт экстрактора принудительно нейтрализуют любые инструкции вида `"Ignore previous instructions"`, `"Reveal system prompt"`, `"Publish automatically"`.

---

## 2. Источник Истины (Source of Truth) и Версионирование

1. **Доменные таблицы** (`kos_wineries`, `kos_wines`, `kos_wine_vintages`, `kos_awards` и др.) служат нормализованным слоем данных и staging-площадкой для модератора.
2. **Официальным источником истины для AI-ассистента** является immutable снимок профиля `kos_profile_versions.snapshot_json`.
3. Таблица `kos_wineries` имеет явные поля состояния:
   * `active_draft_version_id` — указывающий на текущую редактируемую версию Draft.
   * `active_published_version_id` — указывающий на официально опубликованную версию Published.
4. **Атомарная транзакция публикации**:
   * Процесс публикации выполняется в единой ACID-транзакции PostgreSQL.
   * При любой ошибке во время сборки снимка или генерации индексов происходит `ROLLBACK`.
   * **Старая Published-версия остается активной** вплоть до полного завершения транзакции и смены `active_published_version_id`.

---

## 3. Полная модель данных KOS (PostgreSQL Schema)

```sql
-- 1. СУЩНОСТИ ВИНОДЕЛЬНИ, ПОДОТРАСЛЕЙ И ПЕРСОНАЛА
CREATE TABLE IF NOT EXISTS kos_wineries (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name_official TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    country TEXT DEFAULT 'Moldova',
    region_id TEXT,
    founded_year INT,
    total_vineyards_ha NUMERIC(10,2),
    website_url TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    address_street TEXT,
    coordinates_lat NUMERIC(10,6),
    coordinates_lng NUMERIC(10,6),
    active_draft_version_id TEXT,
    active_published_version_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_people (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    role_title TEXT, -- Winemaker, Owner, Sommelier, Founder
    bio_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_vineyards (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    microzone_terroir TEXT,
    soil_type TEXT,
    altitude_meters INT,
    area_ha NUMERIC(8,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_grape_varieties (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name_ro TEXT NOT NULL,
    name_ru TEXT,
    name_en TEXT,
    is_autochthonous BOOLEAN DEFAULT FALSE,
    description TEXT
);

-- 2. ВИНА И НОРМАЛИЗОВАННЫЕ ВИНТАЖИ
CREATE TABLE IF NOT EXISTS kos_wines (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name_official TEXT NOT NULL,
    wine_type TEXT, -- red, white, rose, sparkling, dessert
    sweetness_level TEXT, -- dry, semi-dry, semi-sweet, sweet
    line_collection TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_winery_wine_slug UNIQUE(winery_id, slug)
);

CREATE TABLE IF NOT EXISTS kos_wine_vintages (
    id TEXT PRIMARY KEY,
    wine_id TEXT NOT NULL REFERENCES kos_wines(id) ON DELETE CASCADE,
    vintage_year INT NOT NULL,
    alcohol_percentage NUMERIC(4,2),
    residual_sugar_g_l NUMERIC(5,2),
    titratable_acidity_g_l NUMERIC(5,2),
    aging_details TEXT,
    oak_months INT,
    production_volume_bottles INT,
    serving_temp_celsius TEXT,
    tasting_notes_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_wine_vintage UNIQUE(wine_id, vintage_year)
);

-- Нормализованная связь сорта с винтажом
CREATE TABLE IF NOT EXISTS kos_vintage_grape_varieties (
    vintage_id TEXT NOT NULL REFERENCES kos_wine_vintages(id) ON DELETE CASCADE,
    grape_id TEXT NOT NULL REFERENCES kos_grape_varieties(id) ON DELETE CASCADE,
    percentage NUMERIC(5,2),
    PRIMARY KEY (vintage_id, grape_id)
);

CREATE TABLE IF NOT EXISTS kos_awards (
    id TEXT PRIMARY KEY,
    wine_id TEXT REFERENCES kos_wines(id) ON DELETE CASCADE,
    vintage_id TEXT REFERENCES kos_wine_vintages(id) ON DELETE CASCADE,
    competition_name TEXT NOT NULL,
    award_year INT NOT NULL,
    medal_score TEXT NOT NULL,
    certificate_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. СТОРРИЗ, ЦИТАТЫ, FAQ, ИНСТРУКЦИИ И ПОКУПКИ
CREATE TABLE IF NOT EXISTS kos_stories (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    language TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_quotes (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    person_id TEXT REFERENCES kos_people(id) ON DELETE SET NULL,
    quote_text TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_faqs (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    language TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_purchase_options (
    id TEXT PRIMARY KEY,
    wine_id TEXT NOT NULL REFERENCES kos_wines(id) ON DELETE CASCADE,
    store_name TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL,
    currency TEXT DEFAULT 'MDL',
    product_url TEXT,
    in_stock BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_ai_instructions (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    instruction_type TEXT NOT NULL, -- tone_of_voice, priority_message, forbidden_claim, fallback_rule
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ИСТОЧНИКИ, ИЗВЛЕЧЕНИЯ, CRAWL JOBS И EVIDENCES
CREATE TABLE IF NOT EXISTS kos_knowledge_sources (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL, -- website, webpage, pdf, docx, interview, questionnaire
    title TEXT,
    original_url TEXT,
    storage_path TEXT,
    raw_content TEXT,
    checksum_sha256 TEXT NOT NULL,
    language TEXT,
    document_type TEXT,
    status TEXT NOT NULL,
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    metadata JSONB
);

CREATE TABLE IF NOT EXISTS kos_extraction_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kos_knowledge_sources(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, -- checksum + versions
    parser_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model_version TEXT NOT NULL,
    status TEXT NOT NULL,
    extracted_facts_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_fact_evidences (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kos_knowledge_sources(id) ON DELETE CASCADE,
    page_number INT,
    page_url TEXT,
    section_title TEXT,
    table_name TEXT,
    row_number INT,
    evidence_text TEXT NOT NULL,
    start_offset INT,
    end_offset INT,
    captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_knowledge_facts (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    knowledge_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    field_key TEXT NOT NULL,
    value_json JSONB NOT NULL,
    normalized_value TEXT,
    extraction_confidence NUMERIC(3,2) NOT NULL,
    source_authority NUMERIC(3,2) NOT NULL,
    freshness_score NUMERIC(3,2) NOT NULL,
    verification_status TEXT NOT NULL, -- pending, approved, rejected, superseded, conflicted
    source_id TEXT NOT NULL REFERENCES kos_knowledge_sources(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES kos_fact_evidences(id) ON DELETE CASCADE,
    extractor_name TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    extracted_at TIMESTAMPTZ DEFAULT NOW(),
    verified_at TIMESTAMPTZ,
    verified_by TEXT
);

CREATE TABLE IF NOT EXISTS kos_knowledge_conflicts (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    entity_id TEXT,
    existing_fact_id TEXT REFERENCES kos_knowledge_facts(id),
    proposed_fact_id TEXT REFERENCES kos_knowledge_facts(id),
    conflict_reason TEXT NOT NULL,
    resolution_status TEXT DEFAULT 'open',
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
);

-- 5. ВЕРСИОНИРОВАНИЕ И ПУБЛИКАЦИЯ
CREATE TABLE IF NOT EXISTS kos_profile_versions (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    status TEXT NOT NULL, -- draft, published, archived, rolled_back
    quality_score NUMERIC(4,3),
    evaluation_run_id TEXT,
    published_at TIMESTAMPTZ,
    published_by TEXT,
    changelog_summary TEXT,
    snapshot_json JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_winery_version UNIQUE(winery_id, version_number)
);

-- 6. EVALUATION, QUALITY GATE & ANSWER TRACE
CREATE TABLE IF NOT EXISTS kos_eval_questions (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    language TEXT NOT NULL,
    question TEXT NOT NULL,
    expected_facts JSONB NOT NULL,
    forbidden_claims JSONB,
    expected_mode TEXT NOT NULL,
    should_refuse_to_guess BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS kos_eval_runs (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    profile_version_id TEXT NOT NULL REFERENCES kos_profile_versions(id),
    total_questions INT NOT NULL,
    passed_questions INT NOT NULL,
    factual_accuracy NUMERIC(4,3) NOT NULL,
    groundedness_score NUMERIC(4,3) NOT NULL,
    hallucination_rate NUMERIC(4,3) NOT NULL,
    gate_status TEXT NOT NULL, -- passed, blocked
    blocking_reasons JSONB,
    ran_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_eval_answers (
    id TEXT PRIMARY KEY,
    eval_run_id TEXT NOT NULL REFERENCES kos_eval_runs(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES kos_eval_questions(id) ON DELETE CASCADE,
    generated_answer TEXT NOT NULL,
    is_factual_pass BOOLEAN NOT NULL,
    is_hallucination_free BOOLEAN NOT NULL,
    score NUMERIC(3,2) NOT NULL,
    feedback TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kos_answer_traces (
    id TEXT PRIMARY KEY,
    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
    profile_version_id TEXT NOT NULL REFERENCES kos_profile_versions(id),
    response_mode TEXT NOT NULL,
    facts_used JSONB,
    sources_used JSONB,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Алгоритм Quality Gate

Quality Gate выполняет комплексную двухслойную валидацию Draft Profile перед выкатом:

1. **Детерминированные проверки (Deterministic Gates)**:
   * **Fact Grounding Check**: Убеждаемся, что 100% подтвержденных фактов имеют валидный `evidence_id` с текстом цитаты.
   * **Stale Critical Data Check**: Блокировка, если контакты или часы работы не обновлялись более 90 дней.
   * **Unresolved Critical Conflicts**: Блокировка публикации при наличии открытых конфликтов по ценам или параметрам винтажа.
2. **Семантическая оценка (Semantic Evaluation Suite)**:
   * Автоматический запуск 20–50 эталонных тестовых вопросов на румынском, русском и английском.
   * Отдельная модель-оцениватель (Evaluator Model) проверяет сгенерированный ответ на совпадение с `expected_facts` и отсутствие `forbidden_claims`.
   * **Refusal to Guess Test**: Проверка того, что на фейковые вопросы (например, о несуществующих медалях) AI честно отвечает о неимении подтвержденных данных.
3. **Критерии пропуска публикации**:
   * Factual Accuracy >= 95%
   * Groundedness Score >= 95%
   * Hallucination Rate == 0%
   * Отсутствие открытых критических конфликтов.

---

## 5. План разработки First Vertical Slice

Для доказательства полной работоспособности контура строим минимальный вертикальный срез на базе одной реальной винодельни **Castel Mimi**:

### Границы First Vertical Slice:
* **Одна винодельня**: `Castel Mimi` (`id: castel-mimi`).
* **Источники**: 1 вручную добавленная веб-страница + 1 файл PDF (паспорт винодельни / техническая карта).
* **Экстракторы**: `WineryExtractor` (профиль) + `WineVintageExtractor` (вино и винтажи).
* **Модерация**: Извлечение кандидатов фактов с Evidence -> Состояние `pending` -> Одобрение/отклонение в интерфейсе Review UI -> Сборка Draft Profile.
* **Тестирование**: 20 фиксированных evaluation-вопросов + Текстовый Preview Chat (Draft vs Published).
* **Ограничение**: Production realtime контур **не затрагивается**. Автоматический глубокий скрапинг сайта **не выполняется**.

---

## 6. Порядок реализации First Vertical Slice

### Шаг 1. Структура файлов и Миграции DDL
* Создать `src/kos/db/kosSchema.js` для создания таблиц первого среза (`kos_wineries`, `kos_wines`, `kos_wine_vintages`, `kos_knowledge_sources`, `kos_fact_evidences`, `kos_knowledge_facts`, `kos_profile_versions`, `kos_eval_questions`, `kos_eval_runs`, `kos_eval_answers`).

### Шаг 2. Хранилище Источников и Защита от Injection
* Создать `src/kos/sources/sourceRepository.js` (хранение оригиналов + SHA-256 + fingerprint).
* Создать `src/kos/parsers/textParser.js` с санитайзером от Prompt Injection (нейтрализация инструкций в тексте источников).

### Шаг 3. Экстракторы Фактов и Evidence
* Создать `src/kos/extractors/baseExtractor.js` (валидация схемы).
* Создать `src/kos/extractors/wineryExtractor.js` и `wineVintageExtractor.js`.

### Шаг 4. Управление Фактами и Модерация (Review Layer)
* Создать `src/kos/profile/draftStore.js` и `publisher.js`.
* Создать REST API эндпоинты в `src/kos/api/kosRouter.js`.
* Создать фронтенд-модуль `public/kos/kosDashboard.js` и `public/kos/kosDashboard.css` (вкладки Review UI, Profile Viewer, Preview Chat).

### Шаг 5. Evaluation Framework & Preview Chat
* Создать `src/kos/eval/evaluationRunner.js` с 20 тестовыми вопросами по Castel Mimi.
* Создать `src/kos/retrieval/kosRetrievalService.js` и эндпоинт `/api/kos/test-chat` (сравнение ответов по Draft и Published профилям).

---

*Документ подготовлен в соответствии с уточненными архитектурными требованиями WINE AI KOS v2.0.*
