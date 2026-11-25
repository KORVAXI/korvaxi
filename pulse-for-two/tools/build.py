"""Build public/index.html from src/app.html (the same app that runs on claude.ai).

The app talks to `window.claude.use(...)`; in the standalone site that object is
provided by public/backend.js, which uses this site's own /api instead.

Usage (from the pulse-for-two folder):  python3 tools/build.py
"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (root / "src" / "app.html").read_text()

swaps = [
    ('"Sign in to claude.ai to plan meals"', '"Log in to plan meals"'),
    ('"Sign in to claude.ai to start your food diary."', '"Log in to start your food diary."'),
    ('"Sign in to claude.ai to plan meals."', '"Log in to plan meals."'),
    ('"Sign in to claude.ai to send reminders"', '"Log in to send reminders"'),
    ('"Sign in to claude.ai to save"', '"Log in to save"'),
    ('"Sign in to claude.ai to send love"', '"Log in to send love"'),
    ('const photoUrl = id => "/_blob/" + id;', 'const photoUrl = id => "/api/photo/" + id;'),
    ('''status("Open this page signed in to claude.ai to log your food and see each other's days.");''',
     '''status("Can't reach the app right now. Check your connection and reload.");'''),
    ('<meta name="claude:viewport-fit-sides" content="cover">\n', ''),
]
for a, b in swaps:
    n = src.count(a)
    if n == 0:
        raise SystemExit(f"build: expected text not found: {a[:60]}")
    src = src.replace(a, b)
src = src.replace("Sign in to claude.ai to", "Log in to")  # any newer messages of this kind
if "claude.ai" in src:
    raise SystemExit("build: a claude.ai reference is left over")

title, body = src.split("\n", 1)
assert title == "<title>Pulse for Two</title>", title

head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pulse for Two</title>
<meta name="theme-color" content="#E0182D">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Pulse">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-180.png">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
"""
marker = "<script>\n(() => {"
i = body.index(marker)
body = body[:i] + '<script src="/backend.js"></script>\n' + body[i:]
(root / "public" / "index.html").write_text(head + body + "\n</body>\n</html>\n")
print("built public/index.html")
