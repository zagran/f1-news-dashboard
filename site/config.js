// Where the page reads its headlines, and how often it checks for new ones.
// To move to a backend later, point dataUrl at your API: it has to return the
// same JSON shape as data/news.json (see README) and allow CORS from this site.
window.F1NEWS_CONFIG = {
  dataUrl: 'data/news.json',
  refreshMinutes: 5,
};
