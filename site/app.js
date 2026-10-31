(() => {
  'use strict';

  const config = Object.assign({ dataUrl: 'data/news.json', refreshMinutes: 5 }, window.F1NEWS_CONFIG || {});
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;
  const LANGS = ['uk', 'en'];
  const DEFAULT_LANG = 'uk';
  const LANG_KEY = 'f1news.lang';
  const CACHE_KEY = 'f1news.translations.uk';

  // ---------------------------------------------------------------- page text

  const TEXT = {
    uk: {
      title: 'Новини F1',
      skip: 'Перейти до новин',
      language: 'Мова',
      searchLabel: 'Пошук новин',
      searchPlaceholder: 'Пошук, напр. Ферстаппен',
      loading: 'Завантажуємо новини…',
      loadError: 'Не вдалося завантажити новини. Спробуйте за хвилину.',
      headlines: { one: 'заголовок', few: 'заголовки', many: 'заголовків', other: 'заголовка' },
      feeds: { one: 'джерело', few: 'джерела', many: 'джерел', other: 'джерела' },
      updated: 'оновлено',
      justNow: 'щойно',
      failed: (names) => `Не вдалося оновити: ${names}. Показуємо попередні новини.`,
      latest: 'Останні новини',
      latestNote: (names) => `${names}. Найновіші зверху, час за вашим часовим поясом.`,
      sourceGroup: 'Джерело',
      all: 'Усі',
      today: 'Сьогодні',
      yesterday: 'Вчора',
      firstSeen: 'Вперше з’явилося: ',
      noMatch: 'Нічого не знайдено.',
      sideDated: 'У порядку стрічки.',
      sideUndated: 'Офіційна стрічка у своєму порядку, найновіші зверху. Час публікації в ній не вказано.',
      footer: 'Неофіційний сайт. Заголовки, описи й посилання належать їхнім видавцям. Стрічки перевіряються кожні 30 хвилин.',
      rawData: 'Дані (JSON)',
      original: 'Оригінал: ',
      translation: {
        unsupported: 'Автоматичний переклад працює в Chrome або Edge на комп’ютері, тож тут новини англійською.',
        unavailable: 'Цей браузер не перекладає з англійської на українську, тож новини англійською.',
        button: 'Перекласти новини українською',
        downloadNote: 'Chrome один раз завантажить модель перекладу, далі все працює на вашому пристрої.',
        downloading: (percent) => `Завантажуємо модель перекладу… ${percent}%`,
        translating: (done, total) => `Перекладаємо… ${done} з ${total}`,
        ready: 'Перекладено на вашому пристрої вбудованим перекладачем Chrome. Наведіть курсор на заголовок, щоб побачити оригінал.',
        error: 'Не вдалося перекласти, тож новини англійською.',
      },
    },
    en: {
      title: 'F1 news',
      skip: 'Skip to headlines',
      language: 'Language',
      searchLabel: 'Search headlines',
      searchPlaceholder: 'Search, e.g. Verstappen',
      loading: 'Loading headlines…',
      loadError: 'Couldn’t load the headlines. Try again in a minute.',
      headlines: { one: 'headline', other: 'headlines' },
      feeds: { one: 'feed', other: 'feeds' },
      updated: 'updated',
      justNow: 'just now',
      failed: (names) => `Couldn’t update ${names}. Showing earlier headlines.`,
      latest: 'Latest headlines',
      latestNote: (names) => `From ${names}. Newest first, in your time zone.`,
      sourceGroup: 'Show source',
      all: 'All',
      today: 'Today',
      yesterday: 'Yesterday',
      firstSeen: 'First seen ',
      noMatch: 'No headlines match.',
      sideDated: 'In the order the feed lists them.',
      sideUndated: 'The official feed in its own order, newest first. It doesn’t publish times.',
      footer: 'Unofficial. Headlines, summaries and links belong to their publishers. The feeds are checked every 30 minutes.',
      rawData: 'Raw data',
      original: 'Original: ',
      translation: null,
    },
  };

  // ---------------------------------------------------------------- state

  const $ = (id) => document.getElementById(id);
  const ui = {
    summary: $('summary'),
    warn: $('warn'),
    tstatus: $('tstatus'),
    q: $('q'),
    chips: $('chips'),
    timeline: $('timeline'),
    timelineEmpty: $('timeline-empty'),
    latestNote: $('latest-note'),
    side: $('side'),
    langButtons: [...document.querySelectorAll('.lang [data-lang]')],
  };

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* storage off or full: fine */ }
    },
  };

  const params = new URL(location.href).searchParams;
  const pickLang = (value) => (LANGS.includes(value) ? value : null);
  const state = {
    doc: null,
    lang: pickLang(params.get('lang')) || pickLang(store.get(LANG_KEY)) || DEFAULT_LANG,
    source: params.get('source') || '',
    q: (params.get('q') || '').trim(),
    loadedAt: 0,
  };
  ui.q.value = state.q;

  // Headline translation runs on the device with Chrome's built-in Translator API.
  const translation = {
    status: 'idle', // idle | unsupported | unavailable | download | downloading | translating | ready | error
    progress: 0,
    done: 0,
    total: 0,
    translator: null,
    running: false,
    cache: loadCache(), // English text -> Ukrainian text ('' when it failed)
  };

  let t = TEXT[state.lang];
  let fmt = formatters(state.lang);

  function localeFor(lang) {
    const preferred = (navigator.languages || []).find((l) => l.toLowerCase().split('-')[0] === lang);
    return preferred || (lang === 'uk' ? 'uk-UA' : 'en');
  }

  function formatters(lang) {
    const locale = localeFor(lang);
    return {
      locale,
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      day: new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }),
      num: new Intl.NumberFormat(locale),
      rel: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
      plural: new Intl.PluralRules(locale),
      list: Intl.ListFormat ? new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }) : null,
    };
  }

  // ---------------------------------------------------------------- helpers

  function ago(date, now) {
    const seconds = (date.getTime() - now.getTime()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return t.justNow;
    if (abs < 3600) return fmt.rel.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return fmt.rel.format(Math.round(seconds / 3600), 'hour');
    return fmt.rel.format(Math.round(seconds / 86400), 'day');
  }

  const noun = (forms, n) => forms[fmt.plural.select(n)] || forms.other;
  const joinNames = (names) => (fmt.list ? fmt.list.format(names) : names.join(', '));
  const capitalize = (text) => text.charAt(0).toLocaleUpperCase(fmt.locale) + text.slice(1);
  const stamp = (item) => item.published || item.first_seen;
  const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function dot(sourceKey) {
    const el = node('i', 'dot');
    el.dataset.src = sourceKey;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function timeEl(date, iso, text, prefix, className) {
    const el = node('time', className, text);
    el.dateTime = iso;
    el.title = (prefix || '') + fmt.full.format(date);
    return el;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  // The Ukrainian text when it exists and Ukrainian is on, else the original.
  function shown(text) {
    const translated = state.lang === 'uk' && text ? translation.cache.get(text) : '';
    return translated ? { text: translated, translated: true } : { text, translated: false };
  }

  function markLanguage(el, translated) {
    if (state.lang === 'uk') el.lang = translated ? 'uk' : 'en';
  }

  function headline(item) {
    const href = safeUrl(item.url);
    const { text, translated } = shown(item.title);
    const el = node(href ? 'a' : 'span', 'title', text);
    markLanguage(el, translated);
    if (translated) el.title = t.original + item.title;
    if (href) {
      el.href = href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    return el;
  }

  function summary(item) {
    const { text, translated } = shown(item.summary);
    const el = node('p', 'summary', text);
    markLanguage(el, translated);
    return el;
  }

  function dayLabel(date, now) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (localDay(date) === localDay(now)) return t.today;
    if (localDay(date) === localDay(yesterday)) return t.yesterday;
    return capitalize(fmt.day.format(date));
  }

  function matches(item, sourceName) {
    if (!state.q) return true;
    const q = state.q.toLocaleLowerCase();
    const texts = [item.title, item.summary, item.author, sourceName];
    if (state.lang === 'uk') texts.push(translation.cache.get(item.title), translation.cache.get(item.summary));
    return texts.some((text) => text && String(text).toLocaleLowerCase().includes(q));
  }

  function syncUrl() {
    const url = new URL(location.href);
    const set = (key, value) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
    set('lang', state.lang === DEFAULT_LANG ? '' : state.lang);
    set('source', state.source);
    set('q', state.q);
    history.replaceState(null, '', url);
  }

  // ---------------------------------------------------------------- views

  function applyLanguage() {
    t = TEXT[state.lang];
    fmt = formatters(state.lang);
    document.documentElement.lang = state.lang;
    document.title = t.title;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t[el.dataset.i18n]; });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t[el.dataset.i18nPlaceholder]; });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t[el.dataset.i18nAria]); });
    ui.langButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
    if (!state.doc) ui.summary.textContent = t.loading;
  }

  const timelineSources = (doc) => doc.sources.filter((s) => s.timeline !== false);

  function renderHeader(doc, now) {
    const n = doc.items.length;
    const feeds = doc.sources.length;
    const parts = [
      node('b', null, fmt.num.format(n)), ` ${noun(t.headlines, n)} · `,
      node('b', null, fmt.num.format(feeds)), ` ${noun(t.feeds, feeds)}`,
    ];
    const generated = new Date(doc.generated_at);
    if (!Number.isNaN(generated.getTime())) {
      parts.push(` · ${t.updated} `, timeEl(generated, doc.generated_at, ago(generated, now)));
    }
    ui.summary.replaceChildren(...parts);

    const failed = doc.sources.filter((s) => s.ok === false).map((s) => s.name);
    ui.warn.hidden = failed.length === 0;
    ui.warn.textContent = failed.length ? t.failed(joinNames(failed)) : '';
  }

  // Rebuilt when data or language changes; filter clicks only flip aria-pressed.
  function buildChips(doc) {
    const sources = timelineSources(doc);
    const keys = new Set(sources.map((s) => s.key));
    const count = (key) => doc.items.filter((i) => (key ? i.source === key : keys.has(i.source))).length;
    const chip = (key, label) => {
      const button = node('button', 'chip');
      button.type = 'button';
      button.dataset.src = key;
      if (key) button.append(dot(key));
      button.append(label, ' ', node('span', 'n', fmt.num.format(count(key))));
      return button;
    };
    ui.chips.replaceChildren(chip('', t.all), ...sources.map((s) => chip(s.key, s.name)));
    ui.latestNote.textContent = t.latestNote(joinNames(sources.map((s) => s.name)));
  }

  function updateChips() {
    ui.chips.querySelectorAll('.chip').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.src === state.source));
    });
  }

  function renderTimeline(doc, now) {
    const names = new Map(doc.sources.map((s) => [s.key, s.name]));
    const keys = new Set(timelineSources(doc).map((s) => s.key));
    const rows = doc.items
      .filter((i) => keys.has(i.source) && stamp(i))
      .filter((i) => !state.source || i.source === state.source)
      .filter((i) => matches(i, names.get(i.source)))
      .sort((a, b) => new Date(stamp(b)) - new Date(stamp(a)));

    const out = [];
    let lastDay = null;
    for (const item of rows) {
      const when = new Date(stamp(item));
      if (localDay(when) !== lastDay) {
        out.push(node('h3', 'day', dayLabel(when, now)));
        lastDay = localDay(when);
      }
      const recent = now >= when && now - when < DAY;
      const label = recent ? `${fmt.time.format(when)} · ${ago(when, now)}` : fmt.time.format(when);
      const source = node('span', 'm src');
      source.append(dot(item.source), names.get(item.source) || item.source);
      const meta = node('div', 'meta');
      meta.append(source, timeEl(when, stamp(item), label, item.published ? '' : t.firstSeen, 'm'));
      if (item.author) meta.append(node('span', 'm', item.author));

      const article = node('article', 'item');
      article.append(meta, headline(item));
      if (item.summary) article.append(summary(item));
      out.push(article);
    }
    ui.timeline.replaceChildren(...out);
    ui.timelineEmpty.hidden = rows.length > 0;
  }

  // Feeds marked "timeline": false (Formula1.com has no publish times) get their own card.
  function renderSide(doc) {
    const cards = doc.sources.filter((s) => s.timeline === false).map((source) => {
      const items = doc.items
        .filter((i) => i.source === source.key)
        .sort((a, b) => (a.rank || 0) - (b.rank || 0));
      const visible = items.filter((i) => matches(i, source.name));

      const card = node('section', 'card');
      card.id = `source-${source.key}`;
      const head = node('div', 'card-head');
      const title = node('h2');
      title.append(dot(source.key), source.name);
      head.append(title, node('p', 'note', items.some((i) => i.published) ? t.sideDated : t.sideUndated));

      const list = node('ol', 'olist');
      visible.forEach((item, index) => {
        const li = node('li');
        const text = node('div', 'otext');
        text.append(headline(item));
        if (item.summary) text.append(summary(item));
        li.append(node('span', 'rank', fmt.num.format(item.rank || index + 1)), text);
        list.append(li);
      });
      card.append(head, list);
      if (!visible.length) card.append(node('p', 'empty', t.noMatch));
      return card;
    });
    ui.side.replaceChildren(...cards);
  }

  function render() {
    const doc = state.doc;
    if (!doc) return;
    if (state.source && !timelineSources(doc).some((s) => s.key === state.source)) state.source = '';
    const now = new Date();
    renderHeader(doc, now);
    updateChips();
    renderTimeline(doc, now);
    renderSide(doc);
  }

  // ---------------------------------------------------------------- translation

  function loadCache() {
    try {
      return new Map(Object.entries(JSON.parse(store.get(CACHE_KEY) || '{}')));
    } catch {
      return new Map();
    }
  }

  // Titles first (newest first), then summaries: what people read first gets translated first.
  function textsOf(doc) {
    const items = [...doc.items].sort((a, b) => new Date(stamp(b)) - new Date(stamp(a)));
    return [...new Set([...items.map((i) => i.title), ...items.map((i) => i.summary)].filter(Boolean))];
  }

  function saveCache(doc) {
    const keep = new Set(textsOf(doc));
    const out = {};
    translation.cache.forEach((value, key) => { if (value && keep.has(key)) out[key] = value; });
    store.set(CACHE_KEY, JSON.stringify(out));
  }

  function setStatus(status, extra) {
    Object.assign(translation, extra, { status });
    renderStatus();
  }

  function renderStatus() {
    const el = ui.tstatus;
    const words = TEXT.uk.translation;
    if (state.lang !== 'uk' || translation.status === 'idle') {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    switch (translation.status) {
      case 'download': {
        const button = node('button', 'tbutton', words.button);
        button.type = 'button';
        button.addEventListener('click', () => {
          button.disabled = true;
          startTranslator();
        });
        el.replaceChildren(button, node('span', null, words.downloadNote));
        break;
      }
      case 'downloading':
        el.replaceChildren(words.downloading(Math.round(translation.progress * 100)));
        break;
      case 'translating':
        el.replaceChildren(words.translating(fmt.num.format(translation.done), fmt.num.format(translation.total)));
        break;
      default:
        el.replaceChildren(words[translation.status] || '');
    }
  }

  async function prepareTranslator() {
    if (state.lang !== 'uk' || translation.translator || translation.status !== 'idle') return;
    if (!('Translator' in self)) {
      setStatus('unsupported');
      return;
    }
    try {
      // Builds without the on-device model can leave this call hanging, so give up after a while.
      const availability = await Promise.race([
        self.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'uk' }),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('No answer from Translator.availability()')), 10000)),
      ]);
      if (availability === 'unavailable') setStatus('unavailable');
      else if (availability === 'available') startTranslator();
      else setStatus('download'); // the model download has to start from a click
    } catch (error) {
      console.error('Translator check failed:', error);
      setStatus('error');
    }
  }

  async function startTranslator() {
    try {
      translation.translator = await self.Translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'uk',
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            setStatus('downloading', { progress: event.total ? event.loaded / event.total : event.loaded });
          });
        },
      });
      translateAll();
    } catch (error) {
      console.error('Could not start the translator:', error);
      setStatus('error');
    }
  }

  async function translateAll() {
    const doc = state.doc;
    if (!translation.translator || !doc || state.lang !== 'uk' || translation.running) return;
    const pending = textsOf(doc).filter((text) => !translation.cache.has(text));
    if (!pending.length) {
      setStatus('ready');
      render();
      return;
    }
    translation.running = true;
    setStatus('translating', { done: 0, total: pending.length });
    try {
      for (const text of pending) {
        if (state.lang !== 'uk') break;
        try {
          translation.cache.set(text, await translation.translator.translate(text));
        } catch (error) {
          console.warn('Could not translate:', text, error);
          translation.cache.set(text, ''); // keep the original, don't retry this visit
        }
        setStatus('translating', { done: translation.done + 1 });
        if (translation.done % 10 === 0) render();
      }
    } finally {
      translation.running = false;
    }
    saveCache(doc);
    render();
    if (state.lang !== 'uk') return;
    setStatus('ready');
    if (state.doc !== doc) translateAll(); // new headlines arrived meanwhile
  }

  // ---------------------------------------------------------------- data

  async function load() {
    try {
      const url = new URL(config.dataUrl, location.href);
      url.searchParams.set('t', String(Date.now())); // skip browser and CDN caches
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await response.json();
      if (!doc || !Array.isArray(doc.items) || !Array.isArray(doc.sources)) {
        throw new Error('Unexpected data shape');
      }
      state.doc = doc;
      state.loadedAt = Date.now();
      buildChips(doc);
      render();
      if (state.lang === 'uk') {
        if (translation.translator) translateAll();
        else prepareTranslator();
      }
    } catch (error) {
      console.error('Could not load headlines:', error);
      if (!state.doc) ui.summary.textContent = t.loadError;
    }
  }

  function setLanguage(lang) {
    if (!pickLang(lang) || lang === state.lang) return;
    state.lang = lang;
    store.set(LANG_KEY, lang);
    applyLanguage();
    syncUrl();
    if (state.doc) {
      buildChips(state.doc);
      render();
    }
    renderStatus();
    if (lang === 'uk' && state.doc) {
      if (translation.translator) translateAll();
      else prepareTranslator();
    }
  }

  // ---------------------------------------------------------------- events

  ui.langButtons.forEach((button) => button.addEventListener('click', () => setLanguage(button.dataset.lang)));

  ui.chips.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    state.source = button.dataset.src || '';
    syncUrl();
    render();
  });

  ui.q.addEventListener('input', () => {
    state.q = ui.q.value.trim();
    syncUrl();
    render();
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      ui.q.focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.loadedAt > MINUTE) load();
  });

  applyLanguage();
  load();
  setInterval(load, Math.max(1, Number(config.refreshMinutes) || 5) * MINUTE);
})();
