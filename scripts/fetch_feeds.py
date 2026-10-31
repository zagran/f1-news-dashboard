#!/usr/bin/env python3
"""Fetch the F1 news feeds listed in feeds.json and write site/data/news.json.

Standard library only. Every source is an RSS or Atom feed, so this reads
structured XML and never scrapes web pages.

    python3 scripts/fetch_feeds.py                   # update site/data/news.json
    python3 scripts/fetch_feeds.py --out /tmp/x.json # write somewhere else

The output is rewritten only when the headlines change, so a scheduled job
that commits it produces one commit per real update. A feed that fails keeps
its earlier headlines and is flagged in "sources", so one outage never
empties the page.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FEEDS = ROOT / "feeds.json"
DEFAULT_OUT = ROOT / "site" / "data" / "news.json"
USER_AGENT = "Mozilla/5.0 (compatible; f1-news-dashboard/1.0)"
TIMEOUT_SECONDS = 20
MAX_PER_FEED = 30
SUMMARY_CHARS = 280
SCHEMA_VERSION = 1

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
TRAILER_RE = re.compile(r"\s*(keep reading|read more|continue reading)\W*$", re.I)
BARE_AMP_RE = re.compile(r"&(?!#?\w+;)")
XML_DECL_RE = re.compile(r"^\s*<\?xml[^>]*\?>")


# ---------------------------------------------------------------- helpers

def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_date(text: str | None) -> datetime | None:
    """RSS dates are RFC 822, Atom dates RFC 3339; anything else is ignored."""
    if not text:
        return None
    text = text.strip()
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def local_name(tag: str) -> str:
    """'{namespace}creator' -> 'creator'. Feeds get namespaces wrong (Formula1.com
    declares Dublin Core under https://), so matching ignores them."""
    return tag.rsplit("}", 1)[-1]


def child(el: ET.Element | None, *names: str) -> ET.Element | None:
    if el is None:
        return None
    for c in el:
        if local_name(c.tag) in names:
            return c
    return None


def text_of(el: ET.Element | None, *names: str) -> str | None:
    c = child(el, *names)
    if c is None:
        return None
    return "".join(c.itertext()).strip() or None


def clean_text(text: str | None) -> str | None:
    if not text:
        return None
    text = TAG_RE.sub(" ", text)
    text = TAG_RE.sub(" ", html.unescape(text))  # escaped markup inside CDATA
    text = SPACE_RE.sub(" ", text).strip()
    return text or None


def summarize(text: str | None) -> str | None:
    text = clean_text(text)
    if not text:
        return None
    text = TRAILER_RE.sub("", text).strip()
    if len(text) > SUMMARY_CHARS:
        text = text[:SUMMARY_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"
    return text or None


def clean_url(url: str | None) -> str | None:
    """Keep http(s) links only and drop utm_* tracking parameters."""
    if not url:
        return None
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def image_of(el: ET.Element) -> str | None:
    for c in el:
        name, url = local_name(c.tag), c.get("url")
        if not url:
            continue
        kind = c.get("type") or ""
        if name == "enclosure" and kind.startswith("image/"):
            return clean_url(url)
        if name == "thumbnail" or (name == "content" and (c.get("medium") == "image" or kind.startswith("image/"))):
            return clean_url(url)
    return None


def permalink_guid(item: ET.Element) -> str | None:
    guid = child(item, "guid")
    value = (guid.text or "").strip() if guid is not None else ""
    if value.startswith("http") and guid.get("isPermaLink", "true") != "false":
        return value
    return None


# ---------------------------------------------------------------- parsing

def parse_feed(data: bytes) -> list[dict]:
    """Entries of an RSS 2.0, RSS 1.0 or Atom document, in feed order."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        # Some feeds ship a bare "&". Escape it and try once more.
        text = XML_DECL_RE.sub("", data.decode("utf-8", errors="replace"))
        root = ET.fromstring(BARE_AMP_RE.sub("&amp;", text))

    entries = []
    if local_name(root.tag) == "feed":  # Atom
        for entry in (c for c in root if local_name(c.tag) == "entry"):
            link = next((l.get("href") for l in entry
                         if local_name(l.tag) == "link" and l.get("href")
                         and l.get("rel", "alternate") == "alternate"), None)
            entries.append({
                "title": text_of(entry, "title"),
                "url": link,
                "published": parse_date(text_of(entry, "published") or text_of(entry, "updated")),
                "author": text_of(child(entry, "author"), "name"),
                "summary": text_of(entry, "summary") or text_of(entry, "content"),
                "image": image_of(entry),
            })
        return entries

    channel = child(root, "channel")
    items = [c for c in (channel if channel is not None else root) if local_name(c.tag) == "item"]
    if not items:  # RSS 1.0 keeps items beside the channel
        items = [c for c in root if local_name(c.tag) == "item"]
    for item in items:
        entries.append({
            "title": text_of(item, "title"),
            "url": text_of(item, "link") or permalink_guid(item),
            "published": parse_date(text_of(item, "pubDate") or text_of(item, "date")),
            "author": text_of(item, "creator") or text_of(item, "author"),
            "summary": text_of(item, "description") or text_of(item, "summary"),
            "image": image_of(item),
        })
    return entries


def normalize(feed: dict, entries: list[dict], previous: dict[str, dict], now: str) -> list[dict]:
    include = re.compile(feed["include"], re.I) if feed.get("include") else None
    items: list[dict] = []
    seen: set[str] = set()
    for entry in entries:
        url = clean_url(entry["url"])
        title = clean_text(entry["title"])
        if not url or not title or url in seen:
            continue
        summary = summarize(entry["summary"])
        if include and not include.search(f"{title} {summary or ''}"):
            continue
        seen.add(url)
        author = clean_text(entry["author"])
        if author and author.casefold() == feed["name"].casefold():
            author = None  # Formula1.com credits itself, not a writer
        item_id = f"{feed['key']}-{hashlib.sha1(url.encode()).hexdigest()[:12]}"
        items.append({
            "id": item_id,
            "source": feed["key"],
            "title": title,
            "url": url,
            "published": iso(entry["published"]),
            "first_seen": previous.get(item_id, {}).get("first_seen") or now,
            "author": author,
            "summary": summary,
            "image": entry["image"],
            "rank": len(items) + 1,
        })
        if len(items) >= MAX_PER_FEED:
            break
    return items


# ---------------------------------------------------------------- building

def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    })
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read()


def build(feeds: list[dict], previous_doc: dict | None, now: datetime, fetcher=fetch) -> dict:
    now_iso = iso(now)
    previous_items = {i["id"]: i for i in (previous_doc or {}).get("items", [])}

    def run(feed: dict):
        try:
            entries = parse_feed(fetcher(feed["feed"]))
            if not entries:
                raise ValueError("feed has no items")
            return feed, entries, None
        except Exception as exc:  # one bad feed must not sink the rest
            return feed, None, f"{type(exc).__name__}: {exc}"[:200]

    with ThreadPoolExecutor(max_workers=max(1, len(feeds))) as pool:
        results = list(pool.map(run, feeds))

    sources, items = [], []
    for feed, entries, error in results:
        if error is None:
            feed_items = normalize(feed, entries, previous_items, now_iso)
        else:  # keep what we had, so an outage doesn't empty the page
            feed_items = sorted((i for i in previous_items.values() if i["source"] == feed["key"]),
                                key=lambda i: i.get("rank", 0))
        items.extend(feed_items)
        sources.append({
            "key": feed["key"],
            "name": feed["name"],
            "site": feed.get("site"),
            "feed": feed["feed"],
            "official": bool(feed.get("official", False)),
            "timeline": bool(feed.get("timeline", True)),
            "ok": error is None,
            "error": error,
            "count": len(feed_items),
        })

    # Newest first; a feed without dates keeps its own order (sort is stable).
    items.sort(key=lambda i: i["published"] or i["first_seen"], reverse=True)
    return {"version": SCHEMA_VERSION, "generated_at": now_iso, "sources": sources, "items": items}


def same_content(old: dict | None, new: dict) -> bool:
    if not old:
        return False
    def strip(doc: dict) -> dict:
        return {k: v for k, v in doc.items() if k != "generated_at"}
    return strip(old) == strip(new)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch F1 news feeds into one JSON file.")
    parser.add_argument("--feeds", type=Path, default=DEFAULT_FEEDS, help="feed list (default: feeds.json)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output (default: site/data/news.json)")
    args = parser.parse_args(argv)

    feeds = json.loads(args.feeds.read_text(encoding="utf-8"))
    previous = None
    if args.out.exists():
        try:
            previous = json.loads(args.out.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            previous = None

    doc = build(feeds, previous, datetime.now(timezone.utc))
    for source in doc["sources"]:
        status = (f"{source['count']} items" if source["ok"]
                  else f"FAILED ({source['error']}); kept {source['count']} earlier items")
        print(f"{source['name']:<12} {status}")

    if same_content(previous, doc):
        print(f"No changes, {args.out} left as is")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {len(doc['items'])} items to {args.out}")

    return 0 if any(source["ok"] for source in doc["sources"]) else 1


if __name__ == "__main__":
    sys.exit(main())
