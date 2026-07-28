# WINE AI State Ownership and Anti-Spaghetti Rules

## 1. Назначение документа

Этот документ устанавливает обязательные архитектурные правила для проекта WINE AI.

Главная цель — не допустить превращения проекта в spaghetti code по мере добавления:

* голосовых провайдеров;
* PTT и VAD;
* barge-in;
* Visual Orchestrator;
* профилей персонажей;
* knowledge retrieval;
* playback;
* reconnect;
* session recovery;
* новых интерфейсов и устройств.

Правила распространяются на все новые функции, исправления ошибок и рефакторинги.

---

## 2. Основной принцип

Для каждого типа изменяемого состояния должны существовать:

1. Один источник истины.
2. Один явный владелец.
3. Ограниченный список читателей.
4. Ограниченный список компонентов, имеющих право изменять состояние.
5. Документированные переходы.
6. Детерминированные тесты.

Несколько независимых компонентов не должны управлять одним состоянием.

---

## 3. Архитектурные слои

### 3.1 Client UI

Отвечает за:

* отображение состояния;
* кнопки и пользовательские действия;
* визуальное представление listening, thinking, speaking и error;
* передачу пользовательских команд контроллерам.

Не должен:

* самостоятельно определять server turn lifecycle;
* управлять provider session;
* принимать решения о generation cancellation;
* менять WebSocket internals;
* напрямую управлять server-side visual lifecycle.

---

### 3.2 Audio Capture Layer

Отвечает за:

* доступ к микрофону;
* MediaStream;
* AudioContext;
* AudioWorklet или другой аудиопроцессор;
* формирование аудиофреймов;
* начало и остановку захвата аудио.

Не должен:

* создавать server turn;
* управлять generation;
* отменять provider response;
* управлять playback;
* определять бизнес-логику PTT/VAD.

---

### 3.3 Client Transport Layer

Отвечает за:

* WebSocket connection;
* reconnect;
* отправку и получение сообщений;
* binary audio transport;
* connection identifiers;
* сериализацию и десериализацию protocol events.

Не должен:

* определять turn lifecycle;
* самостоятельно отменять provider session;
* управлять UI-состоянием напрямую;
* содержать provider-specific business logic.

---

### 3.4 Realtime Session Orchestrator

Является владельцем:

* активной realtime-сессии;
* active turn;
* generation lifecycle;
* переходов между input, processing, output, cancelled и completed;
* правил barge-in;
* определения stale events;
* связи между client interaction, turn и generation.

Только этот слой должен принимать решения:

* какой turn активен;
* какую generation нужно отменить;
* можно ли принять новый audio frame;
* завершён ли пользовательский input;
* является ли callback устаревшим.

---

### 3.5 Provider Manager

Отвечает за:

* создание provider session;
* закрытие provider session;
* rotation;
* provider instance identity;
* provider readiness;
* восстановление после provider failure.

Не должен:

* управлять UI;
* управлять visual events;
* определять active turn независимо от Session Orchestrator;
* содержать общую бизнес-логику, одинаковую для нескольких провайдеров.

---

### 3.6 Provider Adapters

Gemini, Grok, OpenAI и другие адаптеры отвечают только за перевод общего внутреннего контракта WINE AI в API конкретного провайдера.

Они могут:

* открыть provider-specific session;
* отправить provider-specific audio;
* передать provider events в общий orchestration layer;
* выполнить provider-specific cancel или close.

Они не должны:

* самостоятельно создавать внутренний WINE AI turn;
* менять UI;
* управлять Visual Orchestrator;
* дублировать общую session logic;
* вводить собственную независимую state machine без необходимости.

Общая логика не должна копироваться между адаптерами.

---

### 3.7 Playback Controller

Является владельцем:

* очереди воспроизведения;
* активного audio output;
* остановки воспроизведения;
* playback identifiers;
* очистки устаревших аудиобуферов.

Не должен:

* определять active turn;
* управлять provider session;
* создавать generation;
* самостоятельно запускать новый input turn.

---

### 3.8 Visual Orchestrator

Отвечает за:

* события показа вина;
* ароматов;
* гастропар;
* региона;
* CTA;
* других визуальных элементов.

Visual Orchestrator реагирует на подтверждённые server events.

Он не должен:

* управлять voice lifecycle;
* отменять active turn;
* закрывать provider session;
* определять generation ownership;
* менять audio capture state.

Voice lifecycle не должен зависеть от visual lifecycle.

---

### 3.9 Knowledge Layer

Отвечает за:

* поиск фактов;
* KOS;
* retrieval;
* embeddings;
* формирование grounded context;
* commerce data.

Не должен:

* вмешиваться в WebSocket lifecycle;
* управлять микрофоном;
* менять active turn;
* управлять provider connection;
* изменять playback state.

---

## 4. Таблица владельцев состояния

| Состояние                    | Владелец                      | Кто может читать                                 | Кто может изменять            |
| ---------------------------- | ----------------------------- | ------------------------------------------------ | ----------------------------- |
| UI interaction               | Client UI Controller          | UI, Audio Controller                             | Client UI Controller          |
| Microphone capture           | Audio Capture Layer           | Client Transport, UI                             | Audio Capture Layer           |
| WebSocket connection         | Client Transport              | UI, Audio Layer                                  | Client Transport              |
| Active session               | Realtime Session Orchestrator | Transport, Provider Manager                      | Realtime Session Orchestrator |
| Active turn                  | Realtime Session Orchestrator | Provider adapters, Playback, Visual Orchestrator | Realtime Session Orchestrator |
| Active generation            | Realtime Session Orchestrator | Provider Manager, Playback, Visual Orchestrator  | Realtime Session Orchestrator |
| Provider session             | Provider Manager              | Session Orchestrator, provider adapter           | Provider Manager              |
| Provider-specific connection | Provider adapter              | Provider Manager                                 | Provider adapter              |
| Playback                     | Playback Controller           | UI, Session Orchestrator                         | Playback Controller           |
| Visual state                 | Visual Orchestrator           | Client UI                                        | Visual Orchestrator           |
| Knowledge request            | Knowledge Layer               | Session Orchestrator                             | Knowledge Layer               |

Если фактическая реализация отличается от этой таблицы, изменение должно быть явно обосновано и документировано.

---

## 5. Запрещённые архитектурные признаки

Следующие признаки считаются архитектурными нарушениями.

### 5.1 Несколько источников истины

Запрещено хранить один и тот же смысл одновременно в нескольких несогласованных полях, например:

* `isTurnActive`;
* `currentTurn`;
* `generation.status`;
* `providerIsListening`;
* `shouldAcceptAudio`;

если между ними нет одного владельца и чёткой модели синхронизации.

---

### 5.2 Boolean-флаги вместо state machine

Запрещено лечить lifecycle-проблемы добавлением комбинаций:

* `isReady`;
* `isEnding`;
* `wasCancelled`;
* `shouldIgnoreNext`;
* `pendingReset`;
* `skipNextFrame`;
* `isFirstTurn`;
* `hasStartedOnce`.

Новый boolean допустим только если:

* он представляет самостоятельный факт;
* имеет одного владельца;
* его lifecycle полностью определён;
* его нельзя выразить существующим состоянием;
* он покрыт тестами.

Добавление нескольких флагов для исправления одного race condition требует отдельного архитектурного обоснования.

---

### 5.3 Таймеры как синхронизация

Запрещено использовать произвольные задержки как основной способ синхронизации:

```javascript
setTimeout(startInput, 300);
```

или:

```javascript
await sleep(500);
```

Таймер допустим только для:

* настоящего timeout;
* backoff;
* user-visible delay;
* protocol-defined debounce.

У таймера должны быть:

* причина;
* владелец;
* отмена;
* terminal condition;
* тест.

---

### 5.4 Дублирование lifecycle

Запрещено создавать отдельные независимые lifecycle для:

* PTT;
* VAD;
* barge-in;
* stop;
* reconnect;
* Gemini;
* Grok;
* OpenAI.

Разные режимы должны использовать общий session/turn contract и отличаться только в местах, где поведение действительно различается.

---

### 5.5 Смешивание слоёв

Запрещены функции, которые одновременно:

* читают UI;
* запускают микрофон;
* открывают WebSocket;
* создают server turn;
* отменяют provider response;
* управляют playback;
* показывают visuals.

Такая функция должна быть разделена по владельцам ответственности.

---

### 5.6 Stale callbacks без проверки ownership

Любой асинхронный callback, относящийся к:

* session;
* provider instance;
* turn;
* generation;
* playback;

должен проверять, относится ли событие к текущему владельцу.

Старое событие не должно менять состояние новой сессии или generation.

---

### 5.7 Копирование между provider adapters

Если одинаковая логика появляется в двух или более adapters, нужно проверить, не должна ли она находиться в:

* Provider Manager;
* Session Orchestrator;
* общем protocol layer;
* общей utility-функции.

Provider adapters должны оставаться тонкими.

---

## 6. Правила изменения архитектуры

Перед существенным изменением инженер или агент обязан ответить:

1. Какое состояние изменяется?
2. Какой слой является его владельцем?
3. Кто сейчас меняет это состояние?
4. Не существует ли второго источника истины?
5. Какие события вызывают переход?
6. Какие переходы разрешены?
7. Что происходит со stale callbacks?
8. Как отменяется незавершённая операция?
9. Как обрабатывается reconnect?
10. Какими тестами защищён lifecycle?

---

## 7. Требования к bugfix

Исправление ошибки должно:

* устранять root cause, а не только симптом;
* не создавать параллельный code path;
* не добавлять произвольные delays;
* не увеличивать число владельцев состояния;
* не дублировать lifecycle;
* удалять ставший ненужным workaround;
* включать regression test;
* сохранять или улучшать наблюдаемость.

Если root cause не доказана, speculative production fix запрещён.

Вместо него должна быть добавлена минимальная telemetry в точке первого подтверждённого расхождения.

---

## 8. Требования к новым функциям

Новая функция должна органично входить в существующую архитектуру.

Перед реализацией необходимо определить:

* слой;
* контракт;
* владельца состояния;
* входные события;
* выходные события;
* ошибки;
* timeout;
* cancellation;
* observability;
* тесты.

Новая возможность не должна напрямую связывать ранее независимые слои без явного контракта.

---

## 9. Architecture Sanity Check

После значимого feature, bugfix или рефакторинга нужно проверить:

* увеличилось ли число mutable-состояний;
* добавились ли новые boolean-флаги;
* появился ли новый источник истины;
* дублируется ли существующая логика;
* смешались ли обязанности слоёв;
* появился ли второй путь выполнения;
* управляют ли два компонента одним lifecycle;
* завязана ли корректность на порядок async callbacks;
* можно ли объяснить flow последовательно;
* можно ли протестировать flow детерминированно.

---

## 10. Требования к отчёту агента

После архитектурно значимого изменения агент должен сообщить:

1. Root cause.
2. Затронутые архитектурные слои.
3. Владельца изменённого состояния.
4. Количество добавленных mutable-состояний.
5. Количество добавленных boolean-флагов.
6. Удалённые workaround и дублирование.
7. Изменения state transitions.
8. Добавленные regression tests.
9. Почему решение не создаёт spaghetti code.
10. Остаточные архитектурные риски.

---

## 11. Минимальный fix и рефакторинг

Исправление бага и большой рефакторинг не должны скрываться в одном непрозрачном изменении.

Если найден архитектурный долг, необходимо разделить:

### Минимальный fix

* устраняет доказанную причину;
* минимально меняет production behavior;
* включает regression test.

### Отдельный refactoring proposal

* описывает проблему структуры;
* показывает целевую архитектуру;
* содержит этапы миграции;
* описывает риски;
* не смешивается с обязательным bugfix без необходимости.

---

## 12. Главный критерий

После каждого изменения должно быть возможно ясно ответить:

> Как один пользовательский input проходит через UI, audio capture, transport, session orchestrator, provider, playback и visual layer?

Если этот flow нельзя объяснить как одну последовательную цепочку с понятными владельцами, архитектура требует пересмотра.
