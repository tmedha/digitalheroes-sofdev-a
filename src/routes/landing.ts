/**
 * A single self-contained page served at `/`. It exists so the deployed URL is
 * useful in a browser and so the API can be exercised without a REST client.
 * No build step, no assets, no external requests.
 */
export const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URL Audit Service</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66; --line: #e2e1dd;
    --card: #ffffff; --accent: #2f6f4e;
    --pass: #2f6f4e; --warn: #9a6b18; --fail: #a63a2f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f; --fg: #eceae4; --muted: #9a978d; --line: #2c2b25;
      --card: #1c1b16; --accent: #7fbf9a;
      --pass: #7fbf9a; --warn: #d9ab55; --fail: #e08573;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 3rem 1.25rem 5rem;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .35rem; letter-spacing: -.02em; }
  .sub { color: var(--muted); margin: 0 0 2rem; }
  form { display: flex; gap: .6rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  input[type=url] {
    flex: 1 1 20rem; padding: .7rem .85rem; font-size: 1rem; font-family: inherit;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg);
  }
  input[type=url]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    padding: .7rem 1.3rem; font-size: 1rem; font-family: inherit; font-weight: 600;
    border: 0; border-radius: 8px; background: var(--accent); color: var(--bg); cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: progress; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.25rem; margin-bottom: 1rem; }
  .score { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
  .score b { font-size: 2.4rem; letter-spacing: -.03em; }
  .cats { display: flex; gap: 1.25rem; flex-wrap: wrap; margin-top: .85rem; color: var(--muted); font-size: .87rem; }
  .cats span b { font-size: 1rem; color: var(--fg); }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .7rem 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 4.2rem 1fr; gap: .75rem; }
  li:first-child { border-top: 0; }
  .tag { font-size: .68rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding-top: .25rem; }
  .pass { color: var(--pass); } .warn { color: var(--warn); } .fail { color: var(--fail); }
  .t { font-weight: 600; }
  .d { color: var(--muted); font-size: .9rem; }
  .meta { color: var(--muted); font-size: .85rem; margin-top: .5rem; word-break: break-all; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
         background: color-mix(in srgb, var(--fg) 8%, transparent); padding: .1em .35em; border-radius: 4px; }
  .err { border-color: var(--fail); }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .85rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>URL Audit Service</h1>
  <p class="sub">Fetches a page and reports on its security headers, SEO and metadata.</p>

  <form id="f">
    <input id="u" type="url" placeholder="https://example.com" required autocomplete="url" spellcheck="false">
    <button id="b" type="submit">Audit</button>
  </form>

  <div id="out"></div>

  <footer>
    API: <code>POST /v1/audit</code> with <code>{"url": "https://example.com"}</code>,
    or <code>GET /v1/audit?url=…</code>. Health at <code>/healthz</code>, runtime stats at <code>/readyz</code>.
    Results are cached; add <code>refresh=true</code> to bypass.
  </footer>
</main>
<script>
(function () {
  var form = document.getElementById('f');
  var input = document.getElementById('u');
  var button = document.getElementById('b');
  var out = document.getElementById('out');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderError(payload, status) {
    var card = el('div', 'card err');
    card.appendChild(el('div', 't', (payload && payload.error && payload.error.code) || ('HTTP ' + status)));
    card.appendChild(el('div', 'd', (payload && payload.error && payload.error.message) || 'Request failed.'));
    var details = payload && payload.error && payload.error.details;
    if (details && details.length) {
      var list = el('ul');
      details.forEach(function (detail) {
        var item = el('li');
        item.style.gridTemplateColumns = '1fr';
        item.appendChild(el('div', 'd', (detail.field ? detail.field + ': ' : '') + detail.message));
        list.appendChild(item);
      });
      card.appendChild(list);
    }
    if (payload && payload.error && payload.error.requestId) {
      card.appendChild(el('div', 'meta', 'request id ' + payload.error.requestId));
    }
    out.replaceChildren(card);
  }

  function renderResult(data) {
    var head = el('div', 'card');
    var score = el('div', 'score');
    var value = el('b', data.summary.score >= 80 ? 'pass' : data.summary.score >= 60 ? 'warn' : 'fail',
                    String(data.summary.score));
    score.appendChild(value);
    score.appendChild(el('span', '', 'grade ' + data.summary.grade));
    score.appendChild(el('span', 'd', data.summary.passed + ' passed \\u00b7 ' +
      data.summary.warnings + ' warnings \\u00b7 ' + data.summary.failed + ' failed'));
    head.appendChild(score);

    var cats = el('div', 'cats');
    data.summary.categories.forEach(function (category) {
      var span = el('span', '', category.category + ' ');
      span.appendChild(el('b', '', String(category.score)));
      cats.appendChild(span);
    });
    head.appendChild(cats);

    head.appendChild(el('div', 'meta',
      data.url.final + ' \\u00b7 ' + data.fetch.status + ' \\u00b7 ' +
      (data.fetch.bytes / 1024).toFixed(1) + ' KB \\u00b7 ' + data.fetch.durationMs + ' ms' +
      (data.cache.hit ? ' \\u00b7 cached ' + Math.round(data.cache.ageMs / 1000) + 's ago' : ' \\u00b7 fresh')));

    var list = el('ul');
    data.checks.forEach(function (check) {
      var item = el('li');
      item.appendChild(el('div', 'tag ' + check.status, check.status));
      var body = el('div');
      body.appendChild(el('div', 't', check.title));
      body.appendChild(el('div', 'd', check.detail));
      item.appendChild(body);
      list.appendChild(item);
    });
    var checksCard = el('div', 'card');
    checksCard.appendChild(list);

    out.replaceChildren(head, checksCard);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    button.disabled = true;
    out.replaceChildren(el('div', 'card', 'Auditing\\u2026'));

    fetch('/v1/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.value })
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) renderError(payload, response.status);
          else renderResult(payload);
        });
      })
      .catch(function () {
        out.replaceChildren(el('div', 'card err', 'Could not reach the audit service.'));
      })
      .finally(function () {
        button.disabled = false;
      });
  });

  // Allow deep links such as /?url=https://example.com to run immediately.
  var preset = new URLSearchParams(location.search).get('url');
  if (preset) { input.value = preset; form.requestSubmit(); }
})();
</script>
</body>
</html>
`;
