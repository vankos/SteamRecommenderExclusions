# Steam Recommender — сохранение исключений из «Your Playtime»

Tampermonkey-скрипт для страницы
<https://store.steampowered.com/recommender/>.

## Что делает

На странице интерактивного рекомендера есть левая колонка **Your Playtime**
(«Ваше игровое время»). У каждой игры есть переключатель **Exclude / Include**.
Steam хранит этот выбор только в памяти страницы, поэтому после перезагрузки
он сбрасывается.

Скрипт:

- запоминает выбор в `localStorage` браузера (отдельно для каждого Steam-аккаунта);
- после загрузки страницы сам нажимает те же кнопки **Exclude / Include**,
  которые нажимал пользователь;
- показывает плашку внизу слева: `SteamRec: N excluded`;
- умеет сбрасывать сохранённые выборы (кнопка `reset`, нажать дважды).

Скрипт **не перехватывает сетевые запросы** и не меняет настройки аккаунта
Steam — он просто работает с теми же кнопками на странице.

## Установка

1. Установите [Tampermonkey](https://www.tampermonkey.net/).
2. Панель Tampermonkey → **Create a new script**.
3. Вставьте содержимое `steam-recommender-persist.user.js`.
4. **Ctrl+S**.
5. Откройте <https://store.steampowered.com/recommender/> и обновите страницу.

## Использование

- Нажмите **Exclude** у игр, которые не должны влиять на рекомендации.
- Обновите страницу — выбор должен примениться автоматически.
- Плашка внизу слева показывает количество исключённых игр.
- **Сброс**: нажмите `reset` на плашке дважды (второй раз — в течение 3 секунд).

## Где хранятся данные

Ключ в `localStorage` сайта `store.steampowered.com`:

```
steamrec.excluded.v1.<steamid>
```

Значение — JSON-объект вида `{ "12345": true, "67890": false }`, где `true` —
игра исключена, `false` — явно включена.

Данные локальные: в другом браузере или после очистки данных сайта выбор
нужно сделать заново.

## Если не работает

### Плашки нет

Скрипт не запустился. Проверьте:

- Tampermonkey установлен и включён;
- скрипт включён в панели Tampermonkey;
- страница открыта в том же браузере/профиле, где стоит Tampermonkey;
- в панели Tampermonkey на вкладке рекомендера скрипт отображается как активный.

Быстрая проверка в консоли (F12 → Console):

```js
console.log({
  badge: !!document.getElementById('steamrec-badge'),
  list: document.querySelectorAll('[class*="PlaytimeList"]').length,
  rows: document.querySelectorAll('[class*="PlayedGame"]').length,
  toggles: document.querySelectorAll('[class*="IgnoreToggle"]').length,
  config: !!document.getElementById('application_config'),
  steamrec: Object.keys(localStorage).filter((k) => k.startsWith('steamrec')),
});
```

### Плашка есть, но выбор не сохраняется

Откройте страницу с режимом отладки:

```
https://store.steampowered.com/recommender/?snr=1_12_70_&steamrec_debug=1
```

Внизу появится панель с отчётом. Нажмите **copy report** и пришлите отчёт —
в нём видно `saved`, `autoClicks`, `rows` и `lastError`.

### Плашка пишет `waiting for list…` или `list is empty`

Скрипт не нашёл список игр. Возможные причины:

- страница ещё не догрузилась (подождите несколько секунд);
- вы не авторизованы в Steam;
- Steam изменил вёрстку — тогда нужен отчёт из debug-режима.

## Ограничения

- Это локальное решение, а не сохранение в аккаунте Steam.
- Скрипт рассчитан на текущую вёрстку страницы (2026). Если Valve поменяет
  классы или структуру списка, селекторы могут потребовать обновления.
- Скрипт не трогает ползунки, теги и другие настройки рекомендера.
