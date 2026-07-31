# CLAUDE.md

Сначала прочитай корневой `AGENTS.md` и следуй его карте контекста.

Не загружай весь каталог `docs/agent-context/` заранее. Открывай только документы, относящиеся к текущей задаче.

Прочитай `docs/agent-context/WORKFLOW_EFFICIENCY.md`.
Для каждой задачи:
- сначала дай короткий план и ожидаемый список файлов;
- читай только относящиеся к задаче файлы;
- запускай узкие тесты во время работы;
- остановись после запрошенного этапа;
- не выполняй production write, deploy, merge, prune или destructive migration без отдельного разрешения.

Для работы с персонажем WineMD, Rive, PSD, анимациями или подключением `.riv` используй `.claude/skills/winemd-rive/SKILL.md`.

Перед изменением realtime, session, turn, generation, provider, capture, playback, visual или knowledge lifecycle обязательно прочитай `docs/architecture/STATE_OWNERSHIP.md` и определи владельцев состояния до изменения кода.
