import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_feeds as ff  # noqa: E402

# Shaped like Autosport's feed: CDATA description, tracking parameters, image enclosure.
RSS_FULL = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Autosport</title>
<item>
  <title>Haas drops Ocon for F1 Mexico GP</title>
  <link>https://www.autosport.com/f1/news/haas-drops-ocon/10870160/?utm_source=RSS&amp;utm_medium=referral</link>
  <description><![CDATA[<p>The Haas team has made a shock decision.</p> <a href="https://x">Keep reading</a>]]></description>
  <pubDate>Sat, 31 Oct 2026 14:54:48 +0000</pubDate>
  <dc:creator>Jane Writer</dc:creator>
  <enclosure url="https://cdn.example.com/a.jpg" type="image/jpeg" length="1"/>
</item>
<item>
  <title>Second story</title>
  <link>https://www.autosport.com/f1/news/second/1/</link>
  <pubDate>Fri, 30 Oct 2026 23:08:22 GMT</pubDate>
</item>
</channel></rss>"""

# Shaped like Formula1.com's feed: no pubDate, Dublin Core declared under https://.
RSS_NO_DATES = b"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="https://purl.org/dc/elements/1.1/">
<channel><title>Latest F1 News</title>
<item><title>First</title><link>https://www.formula1.com/en/latest/article/first.1</link>
  <description>One</description><dc:creator> Formula 1 </dc:creator></item>
<item><title>Second</title><link>https://www.formula1.com/en/latest/article/second.2</link>
  <description>Two</description><dc:creator> Formula 1 </dc:creator></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title>Atom story</title>
    <link rel="alternate" href="https://example.com/atom-story"/>
    <published>2026-10-31T12:00:00Z</published>
    <author><name>Sam Reporter</name></author>
    <summary>Short &amp; sweet.</summary>
  </entry>
</feed>"""

# Shaped like the FIA feed: every series, plus a repeated item.
RSS_FIA = b"""<rss version="2.0"><channel>
<item><title>Formula 1 returns to Africa</title><link>https://www.fia.com/news/africa</link>
  <pubDate>Tue, 13 Oct 2026 08:21:00 +0000</pubDate></item>
<item><title>WEC: Toyota triumphs at home</title><link>https://www.fia.com/news/wec</link>
  <pubDate>Sun, 27 Sep 2026 11:19:00 +0000</pubDate></item>
<item><title>Formula 1 returns to Africa</title><link>https://www.fia.com/news/africa</link>
  <pubDate>Tue, 13 Oct 2026 08:21:00 +0000</pubDate></item>
</channel></rss>"""

BARE_AMPERSAND = b"""<rss version="2.0"><channel><item>
<title>Q&A with the champion</title><link>https://example.com/qa</link>
</item></channel></rss>"""

FEEDS = [
    {"key": "autosport", "name": "Autosport", "feed": "mem://autosport"},
    {"key": "f1", "name": "Formula 1", "feed": "mem://f1", "official": True, "timeline": False},
    {"key": "fia", "name": "FIA", "feed": "mem://fia", "official": True,
     "include": "\\bF1\\b|Formula 1|Formula One|Grand Prix"},
]
NOW = datetime(2026, 10, 31, 18, 0, tzinfo=timezone.utc)


def fake_fetcher(responses):
    def fetch(url):
        body = responses[url]
        if isinstance(body, Exception):
            raise body
        return body
    return fetch


class ParseTests(unittest.TestCase):
    def test_rss_fields_are_cleaned(self):
        item = ff.normalize(FEEDS[0], ff.parse_feed(RSS_FULL), {}, "2026-10-31T18:00:00Z")[0]
        self.assertEqual(item["title"], "Haas drops Ocon for F1 Mexico GP")
        self.assertEqual(item["url"], "https://www.autosport.com/f1/news/haas-drops-ocon/10870160/")
        self.assertEqual(item["published"], "2026-10-31T14:54:48Z")
        self.assertEqual(item["summary"], "The Haas team has made a shock decision.")
        self.assertEqual(item["author"], "Jane Writer")
        self.assertEqual(item["image"], "https://cdn.example.com/a.jpg")

    def test_feed_without_dates_keeps_order(self):
        items = ff.normalize(FEEDS[1], ff.parse_feed(RSS_NO_DATES), {}, "2026-10-31T18:00:00Z")
        self.assertEqual([i["title"] for i in items], ["First", "Second"])
        self.assertEqual([i["rank"] for i in items], [1, 2])
        self.assertIsNone(items[0]["published"])
        self.assertIsNone(items[0]["author"])  # "Formula 1" is the feed, not a writer

    def test_atom(self):
        entry = ff.parse_feed(ATOM)[0]
        self.assertEqual(entry["url"], "https://example.com/atom-story")
        self.assertEqual(ff.iso(entry["published"]), "2026-10-31T12:00:00Z")
        self.assertEqual(entry["author"], "Sam Reporter")
        self.assertEqual(ff.summarize(entry["summary"]), "Short & sweet.")

    def test_include_filter_and_duplicates(self):
        items = ff.normalize(FEEDS[2], ff.parse_feed(RSS_FIA), {}, "2026-10-31T18:00:00Z")
        self.assertEqual([i["title"] for i in items], ["Formula 1 returns to Africa"])

    def test_bare_ampersand_is_tolerated(self):
        self.assertEqual(ff.parse_feed(BARE_AMPERSAND)[0]["title"], "Q&A with the champion")

    def test_long_summary_is_cut_on_a_word(self):
        text = ff.summarize("word " * 100)
        self.assertLessEqual(len(text), ff.SUMMARY_CHARS + 1)
        self.assertTrue(text.endswith("…"))


class BuildTests(unittest.TestCase):
    def responses(self, **overrides):
        base = {"mem://autosport": RSS_FULL, "mem://f1": RSS_NO_DATES, "mem://fia": RSS_FIA}
        base.update(overrides)
        return base

    def test_document_shape_and_order(self):
        doc = ff.build(FEEDS, None, NOW, fake_fetcher(self.responses()))
        self.assertEqual(doc["generated_at"], "2026-10-31T18:00:00Z")
        self.assertEqual([s["count"] for s in doc["sources"]], [2, 2, 1])
        self.assertTrue(all(s["ok"] for s in doc["sources"]))
        stamps = [i["published"] or i["first_seen"] for i in doc["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True))

    def test_failed_feed_keeps_earlier_items(self):
        first = ff.build(FEEDS, None, NOW, fake_fetcher(self.responses()))
        later = datetime(2026, 10, 31, 18, 30, tzinfo=timezone.utc)
        second = ff.build(FEEDS, first, later,
                          fake_fetcher(self.responses(**{"mem://autosport": TimeoutError("timed out")})))
        autosport = next(s for s in second["sources"] if s["key"] == "autosport")
        self.assertFalse(autosport["ok"])
        self.assertIn("timed out", autosport["error"])
        self.assertEqual(sum(i["source"] == "autosport" for i in second["items"]), 2)

    def test_first_seen_survives_and_unchanged_runs_are_detected(self):
        first = ff.build(FEEDS, None, NOW, fake_fetcher(self.responses()))
        later = datetime(2026, 10, 31, 19, 0, tzinfo=timezone.utc)
        second = ff.build(FEEDS, first, later, fake_fetcher(self.responses()))
        self.assertEqual({i["first_seen"] for i in second["items"]}, {"2026-10-31T18:00:00Z"})
        self.assertTrue(ff.same_content(first, second))

    def test_html_instead_of_a_feed_counts_as_a_failure(self):
        doc = ff.build(FEEDS, None, NOW, fake_fetcher(self.responses(**{"mem://f1": b"<html><body>Blocked</body></html>"})))
        f1 = next(s for s in doc["sources"] if s["key"] == "f1")
        self.assertFalse(f1["ok"])


if __name__ == "__main__":
    unittest.main()
