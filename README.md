# Toonkotsu Demo Preview (self-contained, no live backend)

This is a DEMO PREVIEW only, not a full website.
Everything it shows lives in this codebase: no API calls to the original
site, no proxy, no live backend.

Structure (reusable later for a real website):
- public/        : the app (verbatim JS/CSS) + static assets (fonts, favicons)
- public/cdn/    : downloaded cover/banner/group images (179 files)
- functions/     : OUR OWN backend (Cloudflare Pages Functions)
  - functions/cdn/[[path]].js : serves local demo data for /cdn/v1/home,
    /cdn/v1/latest, /cdn/v1/facets, /cdn/v1/browse (search over demo data)
  - functions/api/[[path]].js : serves local demo data for /api/v1/rankings
  - functions/_data/*.js       : the demo data itself, in code (home, latest,
    facets, rankings) - add more titles here and search/latest will show them
- deploy_demo.py : deploy with wrangler (Pages project toonkotsu-demo)

How it works:
  The app asks for /cdn/v1/home etc. Our Functions answer from _data/*.js.
  Covers are served from public/cdn/... (local files, image base patched
  from https://toonkotsu.com to "" in the app bundle).
  Search (/cdn/v1/browse?title=...) filters only the demo titles in code.

Limits (honest):
  - Data is a snapshot (captured 2026-10-29). No real live updates, because
    we are disconnected from the original server by design.
  - Search returns only demo titles in _data, not the full catalogue.
  - Title/chapter reader pages beyond the homepage demo are not fully
    captured yet; homepage + search demo is the verified scope.
  - Login / Library / personal account need a real account backend and
    are guest-only in this demo.
