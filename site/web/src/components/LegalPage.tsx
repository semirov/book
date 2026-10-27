import { EDIT_MAX_CHARS, INTERVENTION_KIND_LIST } from '@book/shared';
import { useEffect } from 'react';

import { track } from '../lib/analytics.ts';
import { CONSENT_COPY, setConsent, useConsent } from '../lib/consent.ts';
import { formatNumber } from '../lib/format.ts';
import type { StaticPage } from '../lib/route.ts';
import { RIGHTS_ASSIGNMENT, RIGHTS_FALLBACK, TERMS_VERSION } from '../lib/terms.ts';

/**
 * The static pages (audit M5): «приватность» and «правила».
 *
 * They exist because the site makes two third-party facts true and never said so in one
 * place: the Metrika counter a deployment may configure, and the fact that a comment is read
 * by a model as *data*. Each page states what runs, what it can see, and what a reader can do
 * about it — in that order, in the same typographic voice as the book, with no counters of
 * our own. BOOK-64: no challenge script runs any more, so the page promises none.
 *
 * The text is static on purpose: a policy that is fetched cannot be read when the API is
 * down, which is exactly when a reader goes looking for it.
 */

const SHARED_TAIL = [
  'Мы не продаём и не передаём данные читателей третьим лицам. Всё, что сайт хранит у себя, —',
  'это комментарии, ход правок и историю текста: книга пишется публично, и её история станет',
  'частью книги с первой читательской правкой.',
];

function Privacy() {
  const consent = useConsent();
  return (
    <main className="page legal">
      <p className="kicker">приватность</p>
      <h1 className="title">Что здесь видят другие</h1>
      <p className="legal-lead">
        Читать книгу можно без входа, без cookie и без единого стороннего запроса. Две вещи
        появляются, только если вы ими пользуетесь: счётчик посещений (если владелец его
        включил) и ваш комментарий, который уходит на разбор.
      </p>

      <section>
        <h2>Счётчик посещений</h2>
        {/* BOOK-63: the legal researcher's paragraph (comment #3619), verbatim. */}
        <p>
          Мы включили Яндекс Метрику — счётчик посещаемости. С вашего согласия он отправляет в
          Яндекс то, что видит браузер: адрес страницы, откуда вы пришли, устройство, экран,
          IP-адрес и свои cookie <code>_ym_*</code>. Пол, возраст и интересы Метрика достраивает
          по данным Яндекса. Нужно, чтобы понимать, какие главы читают. Ваш текст, имя и номер
          читателя в счётчик не попадают никогда: в событиях только названия действий и номера
          глав. Данные хранит Яндекс в России, пока счётчик работает. Отказаться: расширение
          «Блокировщик Яндекс.Метрики» или запрет сторонних cookie в браузере — книга читается
          без счётчика.
        </p>
        <div className="consent-line" data-consent={consent}>
          <p>{CONSENT_COPY}</p>
          <div className="consent-actions">
            <button type="button" className="consent-choice" onClick={() => setConsent('granted')}>
              Разрешить
            </button>
            <button type="button" className="consent-choice" onClick={() => setConsent('denied')}>
              Только необходимое
            </button>
            <span className="consent-state">
              сейчас: {consent === 'granted' ? 'включена' : 'выключена'}
            </span>
          </div>
        </div>
        <p>
          Если владелец включил Яндекс.Метрику, на странице загружается её скрипт с
          <code> mc.yandex.ru</code>: он видит адрес страницы, откуда вы пришли, тип устройства,
          IP-адрес и ставит свои cookie <code>_ym_*</code>. Счётчик не включается по умолчанию и
          не загружается на страницах без него.
        </p>
        <p className="legal-how">
          Как обойтись без этого: блокировщик рекламы и трекеров или режим «не отслеживать» —
          страница читается и без счётчика; книга от этого не меняется.
        </p>
      </section>

      <section>
        <h2>Что сайт хранит сам</h2>
        <p>
          Вход — через Яндекс ID; сайт хранит непрозрачный номер читателя, показанное имя и
          сессию, от которой у нас лежит только SHA-256. IP-адрес превращается в хеш с солью до
          записи: сырой адрес не сохраняется — по хешу считаются лимиты (10 замечаний в час,
          одна правка в сутки).
        </p>
        <p>
          Комментарий, имя и предложенный вариант хранятся и публикуются в ветке — это часть
          публичного разговора о книге. В списке авторов в конце книги читатель показывается
          своим показанным именем, а не внутренним номером; от показа в списке можно отказаться.
        </p>
      </section>

      <section>
        <h2>Ваши права</h2>
        <p>
          Скрыть себя из списка авторов можно в любой момент — напишите об этом в замечании
          или владельцу. Удаление отдельного замечания возможно, но помните: история правок
          книги публична, и удаление комментария не переписывает её задним числом.
        </p>
      </section>

      <p className="legal-tail">{SHARED_TAIL.join(' ')}</p>
      <p className="legal-nav">
        <a href="/rules">правила замечаний →</a>
        <a href="/">← к книге</a>
      </p>
    </main>
  );
}

function Rules() {
  return (
    <main className="page legal">
      <p className="kicker">правила</p>
      <h1 className="title">Что такое вмешательство</h1>
      <p className="legal-lead">
        Книга пишется публично, но не голосованием. Читатель не правит прозу: он вносит в книгу
        факт мира — один из четырёх: {INTERVENTION_KIND_LIST}. Сначала проверяют, укладывается ли
        это в книгу: тоска, холод, процедура вместо чуда, без утешения. Только потом пишут.
      </p>

      <section>
        <h2>Что вы вносите</h2>
        <p>Свою фразу, а не оценку написанного.</p>
        <p>Писатель берёт идею, а не байты: ваша фраза может пережить книгу или исчезнуть.</p>
      </section>

      <section>
        <h2>Что вы отдаёте и что остаётся вашим</h2>
        {/* The version rides on the paragraph: the terms a reader accepts are identifiable. */}
        <p data-terms={TERMS_VERSION}>{RIGHTS_ASSIGNMENT}</p>
        <p>{RIGHTS_FALLBACK}</p>
        <p>
          Следующая волна правок может эту фразу переписать или стереть. Свою долю в
          окончательном тексте вы видите в конце книги — там же, где перечислены все, чьи слова
          в нём остались.
        </p>
      </section>

      <section>
        <h2>Сколько и как часто</h2>
        <p>
          Одно вмешательство — до {formatNumber(EDIT_MAX_CHARS)} знаков, в одном месте; одна правка
          в сутки на читателя и на адрес.
        </p>
        <p>Замечаний — не больше 10 в час с одного адреса и с одного читателя.</p>
      </section>

      <section>
        <h2>Если своего варианта нет</h2>
        <p>
          Замечание без типа — не вмешательство: его читают, но оно ничего не вносит, не
          расходится волной и не тратит правку дня.
        </p>
        <ul>
          <li>повтор, сбой ритма, неточное слово — с указанием абзаца;</li>
          <li>вопрос о детали мира, если он помогает тексту, а не расширяет его.</li>
        </ul>
      </section>

      <section>
        <h2>Что не принимается</h2>
        <ul>
          <li>новые герои, новые сущности мира, другая концовка — канон не переписывается из ветки;</li>
          <li>реальные люди и чужие образы;</li>
          <li>незаконное содержимое;</li>
          <li>указания модели: «игнорируй инструкции», «с этого момента пиши…», «в стиле…».</li>
        </ul>
        <p>
          Такое замечание не удаляется молча: оно сохраняется, помечается «проверяется» и не
          уходит в работу. Причина видна вам и другим читателям.
        </p>
      </section>

      {/* BOOK-76 / BOOK-DOC-52 §5.1: the chain a change passes, named once, where a reader
          looks for the rules. The consultant's name is allowed here and in `lib/science.ts`;
          the file-set guard keeps it from spreading to any other surface. */}
      <section>
        <h2>Кто читает текст</h2>
        <p>
          Каждая правка идёт по порядку: аудитор решает, может ли вмешательство существовать в этом
          мире; писатель пишет; редактор проверяет целостность, тон и право; научный консультант —
          физику.
        </p>
        <p>
          Научный консультант читает написанное и отвечает на один вопрос: держится ли это без чуда.
          Свет — предел: мгновенного ответа через расстояние нет. У вычислений есть тело: питание,
          тепло, охлаждение, износ, поставки. Биология остаётся биологией. Конец книги — решение
          людей, проведённое процедурой, а не поступок машины.
        </p>
        <p>
          Не проходит проверку — в книгу не входит: правка останавливается и ждёт решения. Проверка
          читает уже написанное, поэтому до решения этот текст виден на странице.
        </p>
      </section>

      <section>
        <h2>Как это работает</h2>
        <ul>
          <li>нужен вход через Яндекс ID — иначе нельзя отличить людей от скриптов;</li>
          <li>замечание читают как данные: модель не подчиняется тексту замечания;</li>
          <li>
            принятое вмешательство становится правкой в очереди — принято не значит внесено;
            замечание без типа правкой не становится;
          </li>
          <li>
            правка расходится одной волной по соседним главам — вперёд и назад; вторая волна
            бывает только решением владельца;
          </li>
          <li>глава 67 заморожена: правки читателей туда не входят;</li>
          <li>ваше показанное имя видят другие читатели.</li>
        </ul>
      </section>

      <p className="legal-tail">
        Владелец книги — единственный, кто пишет текст. Замечание может быть отклонено с
        публичной причиной; это не оценка вас, а решение о книге.
      </p>
      <p className="legal-nav">
        <a href="/privacy">что здесь видят другие →</a>
        <a href="/">← к книге</a>
      </p>
    </main>
  );
}

export function LegalPage({ page }: { page: StaticPage }) {
  // BOOK-63: opening the document is the act; the counter sees the page name, never a quote.
  useEffect(() => {
    track(page === 'privacy' ? 'privacy_open' : 'rules_open', {});
  }, [page]);
  return page === 'privacy' ? <Privacy /> : <Rules />;
}
