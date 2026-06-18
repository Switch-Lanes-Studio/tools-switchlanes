# Keyword Clustering Tool

Internal SEO keyword-research tool for Switchlanes Studio. Replaces the manual
"SEO Template | Keyword Research" Google Sheet.

- **Live:** https://tools.switchlanes.be/kwr/
- 100% client-side (no backend, no data leaves the browser).
- Upload Google Keyword Planner exports → cluster keywords with contains/exclude
  rules → see volume, trends, seasonality → export CSV/Excel.

## Run locally
```bash
python3 -m http.server 8123
# open http://localhost:8123
```
