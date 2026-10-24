# Steam Recommender — сохранение исключений и тегов

Tampermonkey-скрипт для страницы
<https://store.steampowered.com/recommender/>.

## Что делает

На странице интерактивного рекомендера есть:

- левая колонка **Your Relevant Playtime** с кнопками **Exclude / Include**;
- фильтры **Add Tag Filters** и **Add Tag Exclusions**.

Steam хранит и то, и другое только в памяти страницы, поэтому после
перезагрузки выбор сбрасывается.

Скрипт:

- запоминает исключённые игры и выбранные теги в `localStorage` браузера;
- после загрузки страницы сам нажимает те же кнопки **Exclude / Include**;
- сам добавляет сохранённые теги в **Add Tag Filters** и **Add Tag Exclusions**
  через тот же автокомплит, что и пользователь;
- показывает плашку внизу слева: `SteamRec: N excluded · tags M`;
- умеет сбрасывать сохранённые выборы (кнопка `reset`, нажать дважды).

Скрипт **не перехватывает сетевые запросы** и не меняет настройки аккаунта
Steam. Он ищет на странице кнопки с текстом `Exclude` / `Include`
(а также `Исключить` / `Включить`), поднимается от кнопки до строки с игрой и
берёт `appid` из ссылки `/app/<id>` или картинки `/apps/<id>/`.

Это версия под **новый интерфейс Steam** (`#StoreTemplate`), где нет старых
классов `PlaytimeList` / `PlayedGame` / `IgnoreToggle`.

## Установка

1. Установите [Tampermonkey](https://www.tampermonkey.net/).
2. Панель Tampermonkey → **Create a new script**.
3. Вставьте содержимое `steam-recommender-persist.user.js`.
4. **Ctrl+S**.
5. Откройте <https://store.steampowered.com/recommender/> и обновите страницу.

## Использование

- Нажмите **Exclude** у игр, которые не должны влиять на рекомендации.
- Добавьте теги в **Add Tag Filters** и **Add Tag Exclusions**.
- Обновите страницу — выбор должен примениться автоматически.
- Плашка внизу слева показывает количество исключённых игр и тегов.
- **Сброс**: нажмите `reset` на плашке дважды (второй раз — в течение 3 секунд).

После обновления скрипта добавьте теги один раз заново: старые версии их не
сохраняли. Дальше скрипт будет восстанавливать их сам.

## Где хранятся данные

Ключи в `localStorage` сайта `store.steampowered.com`:

```
steamrec.excluded.v2.<account>
steamrec.tags.v1.<account>
```

`<account>` — SteamID из `g_steamID` / ссылки на профиль, либо vanity-имя,
либо `default`, если на странице не нашлось ничего лучше.

`steamrec.excluded.v2` — JSON-объект вида
`{ "12345": true, "67890": false }`, где `true` — игра исключена,
`false` — явно включена.

`steamrec.tags.v1` — JSON-объект вида:

```json
{
  "filters": ["Story Rich"],
  "excludes": ["Roguelike", "Roguelite"]
}
```

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
  buttons: [...document.querySelectorAll('button')].filter((b) =>
    /^(exclude|include|исключить|включить)$/i.test((b.textContent || '').trim())
  ).length,
  appLinks: document.querySelectorAll('a[href*="/app/"]').length,
  appImages: document.querySelectorAll('img[src*="/apps/"]').length,
  steamrec: Object.keys(localStorage).filter((k) => k.startsWith('steamrec')),
});
```

### Плашка пишет `waiting for buttons…`

Скрипт не нашёл ни одной кнопки `Exclude` / `Include`. Возможные причины:

- страница ещё не догрузилась (подождите несколько секунд);
- вы не авторизованы в Steam;
- Steam изменил текст кнопок — тогда нужен отчёт из debug-режима.

### Плашка пишет `buttons found, no appid`

Кнопки есть, но скрипт не смог понять, к какой игре они относятся. В debug-отчёте
будет блок `unmappedSample` — цепочка элементов вокруг первой такой кнопки.
Пришлите этот блок, и я добавлю нужный селектор.

### Плашка есть, но выбор не сохраняется

Откройте страницу с режимом отладки:

```
https://store.steampowered.com/recommender/?snr=1_12_70_&steamrec_debug=1
```

Внизу появится панель с отчётом. Нажмите **copy report** и пришлите отчёт.
В нём видно:

- `saved` — что уже сохранено по играм;
- `buttons` / `mapped` / `unmapped` — сколько кнопок найдено и к скольким
  удалось привязать `appid`;
- `autoClicks` — сколько кнопок скрипт нажал сам;
- `tags.saved` / `tags.current` — какие теги сохранены и какие сейчас в UI;
- `tags.ready` / `tags.applying` — закончилось ли применение тегов;
- `lastError` — текст ошибки, если была.

### Теги не восстанавливаются

Проверьте в debug-отчёте блок `tags`:

- `tags.saved` — список сохранённых тегов;
- `tags.current` — что реально стоит в **Add Tag Filters** / **Add Tag Exclusions**.

Если `tags.saved` заполнен, а `tags.current` пуст или отличается, значит
скрипт не смог добавить тег через автокомплит. Пришлите отчёт — там будет видно,
на каком теге застряло. Обычно причина в том, что Steam изменил placeholder
или структуру автокомплита.

## Ограничения

- Это локальное решение, а не сохранение в аккаунте Steam.
- Скрипт рассчитан на текущую вёрстку страницы (2026). Если Valve поменяет
  текст кнопок, placeholder тегов или структуру строк, может потребоваться
  обновление.
- Скрипт не трогает ползунки популярности/давности и чекбоксы
  Exclude Wishlisted / Only Discounted.
