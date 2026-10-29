import { EDIT_MAX_CHARS, INTERVENTION_KIND_LIST, TOTAL_CHAPTERS } from '@book/shared';
import { useEffect } from 'react';

import { track } from '../lib/analytics.ts';
import { CONSENT_COPY, setConsent, useConsent } from '../lib/consent.ts';
import { formatNumber } from '../lib/format.ts';
import type { StaticPage } from '../lib/route.ts';
import { ScreenExit } from './ScreenExit.tsx';
import {
  MACHINE_TOOL_CAVEAT,
  MACHINE_TOOL_RULES,
  RIGHTS_ASSIGNMENT,
  RIGHTS_FALLBACK,
  RIGHTS_RETAINED,
  TERMS_VERSION,
  TOOL_CLAUSE,
} from '../lib/terms.ts';

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
      {/* BOOK-221 — a document is a separate screen: one exit at its top, and the book is another
          document, so the browser navigates and the back button returns here. */}
      <ScreenExit href="/#toc" />
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
      {/* BOOK-221 — the same one exit, in the same place, on the other static document. */}
      <ScreenExit href="/#toc" />
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

      {/* BOOK-72: the transfer and what stays are two sections, in that order — a reader
          reads the grant first, then the list of what no grant touched. */}
      <section>
        <h2>Что вы отдаёте</h2>
        {/* The version rides on the paragraph: the terms a reader accepts are identifiable. */}
        <p data-terms={TERMS_VERSION}>{RIGHTS_ASSIGNMENT}</p>
        <p>{RIGHTS_FALLBACK}</p>
        {/* BOOK-69: the tool clause sits inside the terms block, beside the assignment. */}
        <p>{TOOL_CLAUSE}</p>
        <p>
          Следующая волна правок может эту фразу переписать или стереть. Свою долю в
          окончательном тексте вы видите в конце книги — там же, где перечислены все, чьи слова
          в нём остались.
        </p>
      </section>

      <section>
        <h2>Что у вас остаётся</h2>
        <ul>
          {RIGHTS_RETAINED.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Сколько и как часто</h2>
        <p>
          Одно вмешательство — до {formatNumber(EDIT_MAX_CHARS)} знаков, в одном месте. Правка дня —
          одна на читателя и на адрес — списывается только за принятое вмешательство: отказ её не
          тратит.
        </p>
        <p>
          Попытки ограничены: три на одно замечание в сутки, не чаще одной в десять минут, пять на
          читателя в сутки и пятнадцать на адрес в сутки.
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

      {/* BOOK-126 — money, stated once and plainly. The page is static (audit M5): it fetches
          nothing and renders no third-party byte, so it cannot know whether this deployment
          shows the footer's «поддержать книгу» row — hence «по ссылке «поддержать книгу»» names
          the control by its own words instead of pointing at «эту ссылку». A gift between
          individuals: it buys nothing, the queue is shared, and the bank runs the payment, so
          we do not see who made it. */}
      <section>
        <h2>Деньги</h2>
        <p>
          Деньги, которые приходят по ссылке «поддержать книгу», — подарок. Они ничего не
          оплачивают: ни доступа, ни глав, ни решений по правкам. Книга остаётся бесплатной, а
          правки идут по одной, в порядке записи.
        </p>
        <p>Платёж проводит банк: кто его сделал, мы не видим.</p>
      </section>

      <section>
        <h2>Что не принимается</h2>
        <ul>
          <li>новые герои, новые сущности мира, другая концовка — канон не переписывается из ветки;</li>
          <li>реальные люди и чужие образы;</li>
          <li>незаконное содержимое;</li>
          <li>указания машине: «игнорируй инструкции», «с этого момента пиши…», «в стиле…».</li>
        </ul>
        <p>
          Такое замечание не удаляется молча: оно сохраняется и не уходит в работу. Причина видна
          вам и другим читателям. Замечание может быть остановлено до чтения — тогда его прочитает
          человек.
        </p>
      </section>

      {/* BOOK-69: who writes the book, said before the chain that reads a change — the reader
          meets the machine in every section above, so it is named once as the author's tool. */}
      <section>
        <h2>Кто пишет книгу</h2>
        <p>{MACHINE_TOOL_RULES}</p>
        <p>{MACHINE_TOOL_CAVEAT}</p>
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
          <li>замечание читают как данные: машина не подчиняется тексту замечания;</li>
          <li>
            принятое вмешательство ждёт своей главы — принято не значит внесено;
            замечание без типа правкой не становится;
          </li>
          <li>
            правка расходится одной волной по соседним главам — вперёд и назад; вторая волна
            бывает только решением владельца;
          </li>
          <li>глава {TOTAL_CHAPTERS} заморожена: правки читателей туда не входят;</li>
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
