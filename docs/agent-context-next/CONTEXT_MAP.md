# CONTEXT_MAP.md

Загружай один основной маршрут. Добавляй второй только при доказанной связи между контурами.

## Realtime lifecycle, PTT, tap-to-start, barge-in

Прочитай `domains/realtime-voice.md`, затем код `src/realtime/realtimeServer.js`, `wsProtocol.js` и относящиеся тесты. Для provider-specific поведения добавь `contracts/provider-adapter.md` и соответствующий adapter.

## Gemini, Grok или новый realtime-провайдер

Прочитай `domains/provider-adapters.md` и `contracts/provider-adapter.md`. Сравни реализацию с mock adapter и тестами. Не меняй общий lifecycle ради особенности одного провайдера без доказанной необходимости.

## Knowledge, embeddings, RAG, KOS

Прочитай `domains/knowledge-retrieval.md` и `contracts/knowledge-search.md`. Используй `src/knowledge/`, `src/kos/`, `src/tools/searchWineKnowledge.js` и тесты как спецификацию. Для схемы добавь `domains/database.md`.

## Database и migration

Прочитай `domains/database.md`, реальную схему и migration-код. Перед production-записью остановись согласно `AUTONOMY.md`.

## Visual, avatar, cards, map, QR

Прочитай `domains/visual-system.md` и `contracts/visual-event.md`. Проверяй producer и renderer одного события вместе. Устаревший `generation_id` должен отбрасываться.

## Frontend и widget

Начни с реального HTML, CSS и JS в `public/`, затем проверь API-маршруты в `src/server.js`. Не загружай provider и knowledge-инструкции, пока UI-задача их не затрагивает.

## Security, auth, secrets, crawler

Прочитай `domains/security.md`, затем конкретные route guards, SSRF/robots policy и тесты. Не выводи значения секретов.

## Production incident или release

Прочитай `INVARIANTS.md`, `VERIFICATION.md` и релевантный incident-файл. Сначала установи причину по логам, коду и воспроизводимому тесту. Deploy и merge требуют отдельного запроса.

## Документация и контекст агента

Прочитай только `AGENTS.next.md`, `PROJECT.md`, этот файл и документ, который меняешь. Ищи дублирование, конфликт владельцев правила и инструкции, которые лучше заменить кодом, тестом, схемой или tool interface.