(() => {
  'use strict';

  const config = Object.assign({ dataUrl: 'data/news.json', refreshMinutes: 5 }, window.F1NEWS_CONFIG || {});
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  const $ = (id) => document.getElementById(id);
  const ui = {
    summary: $('summary'),
    warn: $('warn'),
    q: $('q'),
    chips: $('chips'),
    timeline: $('timeline'),
    timelineEmpty: $('timeline-empty'),
    latestNote: $('latest-note'),
    side: $('side'),
  };

  const params = new URL(location.href).searchParams;
  const state = {
    doc: null,
    source: params.get('source') || '',
    q: (params.get('q') || '').trim(),
    loadedAt: 0,
  };
  ui.q.value = state.q;

  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const fmtNum = new Intl.NumberFormat();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const listFmt = Intl.ListFormat ? new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }) : null;

  // ---------------------------------------------------------------- helpers

  function ago(date, now) {
    const seconds = (date.getTime() - now.getTime()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    return rtf.format(Math.round(seconds / 86400), 'day');
  }

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
    el.title = (prefix || '') + fmtFull.format(date);
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

  function headline(item) {
    const href = safeUrl(item.url);
    const el = node(href ? 'a' : 'span', 'title', item.title);
    if (href) {
      el.href = href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    return el;
  }

  const stamp = (item) => item.published || item.first_seen;
  const localDay = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const joinNames = (names) => (listFmt ? listFmt.format(names) : names.join(', '));

  function dayLabel(date, now) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (localDay(date) === localDay(now)) return 'Today';
    if (localDay(date) === localDay(yesterday)) return 'Yesterday';
    return fmtDay.format(date);
  }

  function matches(item, sourceName) {
    if (!state.q) return true;
    const q = state.q.toLocaleLowerCase();
    return [item.title, item.summary, item.author, sourceName]
      .some((text) => text && String(text).toLocaleLowerCase().includes(q));
  }

  function syncUrl() {
    const url = new URL(location.href);
    if (state.source) url.searchParams.set('source', state.source);
    else url.searchParams.delete('source');
    if (state.q) url.searchParams.set('q', state.q);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
  }

  // ---------------------------------------------------------------- views

  function timelineSources(doc) {
    return doc.sources.filter((s) => s.timeline !== false);
  }

  function renderHeader(doc, now) {
    const parts = [
      node('b', null, fmtNum.format(doc.items.length)), ' headlines from ',
      node('b', null, fmtNum.format(doc.sources.length)), ' feeds',
    ];
    const generated = new Date(doc.generated_at);
    if (!Number.isNaN(generated.getTime())) {
      parts.push(' · updated ', timeEl(generated, doc.generated_at, ago(generated, now)));
    }
    ui.summary.replaceChildren(...parts);

    const failed = doc.sources.filter((s) => s.ok === false).map((s) => s.name);
    ui.warn.hidden = failed.length === 0;
    ui.warn.textContent = failed.length
      ? `${joinNames(failed)} didn’t respond at the last check, so ${failed.length === 1 ? 'its' : 'their'} headlines may be older.`
      : '';
  }

  // Built once per data load; filter changes only flip aria-pressed.
  function buildChips(doc) {
    const sources = timelineSources(doc);
    const keys = new Set(sources.map((s) => s.key));
    const count = (key) => doc.items.filter((i) => (key ? i.source === key : keys.has(i.source))).length;
    const chip = (key, label) => {
      const button = node('button', 'chip');
      button.type = 'button';
      button.dataset.src = key;
      if (key) button.append(dot(key));
      button.append(label, ' ', node('span', 'n', fmtNum.format(count(key))));
      return button;
    };
    ui.chips.replaceChildren(chip('', 'All'), ...sources.map((s) => chip(s.key, s.name)));
    ui.latestNote.textContent = `From ${joinNames(sources.map((s) => s.name))}. Newest first, in your time zone.`;
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
      const label = recent ? `${fmtTime.format(when)} · ${ago(when, now)}` : fmtTime.format(when);
      const source = node('span', 'm src');
      source.append(dot(item.source), names.get(item.source) || item.source);
      const meta = node('div', 'meta');
      meta.append(source, timeEl(when, stamp(item), label, item.published ? '' : 'First seen ', 'm'));
      if (item.author) meta.append(node('span', 'm', item.author));

      const article = node('article', 'item');
      article.append(meta, headline(item));
      if (item.summary) article.append(node('p', 'summary', item.summary));
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
      const shown = items.filter((i) => matches(i, source.name));

      const card = node('section', 'card');
      card.id = `source-${source.key}`;
      const head = node('div', 'card-head');
      const title = node('h2');
      title.append(dot(source.key), source.name);
      const dated = items.some((i) => i.published);
      head.append(title, node('p', 'note', dated
        ? 'In the order the feed lists them.'
        : 'The official feed in its own order, newest first. It doesn’t publish times.'));

      const list = node('ol', 'olist');
      shown.forEach((item, index) => {
        const li = node('li');
        const text = node('div', 'otext');
        text.append(headline(item));
        if (item.summary) text.append(node('p', 'summary', item.summary));
        li.append(node('span', 'rank', fmtNum.format(item.rank || index + 1)), text);
        list.append(li);
      });
      card.append(head, list);
      if (!shown.length) card.append(node('p', 'empty', 'No headlines match.'));
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
    } catch (error) {
      console.error('Could not load headlines:', error);
      if (!state.doc) ui.summary.textContent = 'Couldn’t load the headlines. Try again in a minute.';
    }
  }

  // ---------------------------------------------------------------- events

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

  load();
  setInterval(load, Math.max(1, Number(config.refreshMinutes) || 5) * MINUTE);
})();
