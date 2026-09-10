#!/usr/bin/env bash
# Insert synthetic, non-operator demo telemetry into the screenshot stack.
# Sourced by run.sh after /health is green. Never run against a real fleet DB.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.demo.yaml"
PROJECT=umbra-demo

_cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }

compose() {
  docker compose -f "${COMPOSE_FILE}" --project-name "${PROJECT}" "$@"
}

_cyan "[demo] reading generated admin password from server logs…"
ADMIN_PASS=""
for _ in $(seq 1 30); do
  LOGS="$(compose logs umbra-demo-server 2>/dev/null || true)"
  ADMIN_PASS="$(printf '%s\n' "${LOGS}" | python3 -c '
import sys, json, re
text = sys.stdin.read()
# JSON slog line
for line in text.splitlines():
    start = line.find("{")
    if start < 0:
        continue
    try:
        obj = json.loads(line[start:])
    except Exception:
        continue
    if obj.get("msg") == "default admin user created":
        print(obj.get("password") or "")
        raise SystemExit
# text fallback
m = re.search(r"password[=: ]+(\S+)", text)
if m:
    print(m.group(1).strip(",\""))
' 2>/dev/null || true)"
  if [ -n "${ADMIN_PASS}" ]; then
    break
  fi
  sleep 1
done
if [ -z "${ADMIN_PASS}" ]; then
  _yellow "[demo] could not parse admin password — capture will still take the login page"
else
  export UMBRA_DEMO_ADMIN_PASSWORD="${ADMIN_PASS}"
  printf '%s\n' "${ADMIN_PASS}" > /tmp/umbra-demo-admin-password.txt
  _green "[demo] admin password written to /tmp/umbra-demo-admin-password.txt"
fi

BOT1="11111111-1111-4111-8111-111111111111"
BOT2="22222222-2222-4222-8222-222222222222"
BOT3="33333333-3333-4333-8333-333333333333"
BOT4="44444444-4444-4444-8444-444444444444"
export UMBRA_DEMO_BOT_ID="${BOT1}"

_cyan "[demo] generating placeholder captures…"
THUMB_B64="$(python3 - <<'PY'
import base64, struct, zlib

def chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

def png(w, h, rgb):
    raw = b"".join(b"\x00" + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

def fill(w, h, color):
    r, g, b = color
    return bytes([r, g, b]) * (w * h)

def blit(dst, dw, x, y, src, sw, sh):
    out = bytearray(dst)
    for row in range(sh):
        dy = y + row
        if dy < 0:
            continue
        start = (dy * dw + x) * 3
        chunk = src[row * sw * 3:(row + 1) * sw * 3]
        out[start:start + len(chunk)] = chunk
    return bytes(out)

w, h = 640, 360
bg = fill(w, h, (11, 16, 28))
chrome = fill(w, 36, (18, 24, 38))
img = blit(bg, w, 0, 0, chrome, w, 36)
accent = fill(w, 3, (232, 168, 56))
img = blit(img, w, 0, 36, accent, w, 3)
panel = fill(280, 200, (22, 30, 48))
img = blit(img, w, 40, 80, panel, 280, 200)
print(base64.b64encode(png(w, h, img)).decode("ascii"))
PY
)"

SQL_FILE="$(mktemp /tmp/umbra-demo-XXXXXX.sql)"
python3 - "${BOT1}" "${BOT2}" "${BOT3}" "${BOT4}" "${THUMB_B64}" > "${SQL_FILE}" <<'PY'
import json, sys
b1, b2, b3, b4, thumb = sys.argv[1:]
data_url = "data:image/png;base64," + thumb
now = "2026-09-10T08:14:00Z"
earlier = "2026-09-10T07:51:00Z"
old = "2026-09-09T22:10:00Z"

def dumps(obj):
    return json.dumps(obj).replace("'", "''")

tabs1 = [
    {"id": 1, "url": "https://intranet.example.test/mail", "title": "Inbox — Contoso Mail", "active": True},
    {"id": 2, "url": "https://wiki.example.test/runbooks/edr", "title": "EDR runbook", "active": False},
    {"id": 3, "url": "https://id.example.test/account", "title": "Account", "active": False},
]
hist1 = [
    {"url": "https://intranet.example.test/mail", "title": "Inbox — Contoso Mail", "visitCount": 14, "lastVisitTime": 1725950000000},
    {"url": "https://wiki.example.test/runbooks/edr", "title": "EDR runbook", "visitCount": 4, "lastVisitTime": 1725949000000},
    {"url": "https://intranet.example.test/hr/time", "title": "Time off", "visitCount": 2, "lastVisitTime": 1725940000000},
]
cookies_shared = [
    {"name": "PHPSESSID", "value": "demo-session-alpha", "domain": ".intranet.example.test", "path": "/", "secure": True, "httpOnly": True},
    {"name": "locale", "value": "en-US", "domain": "intranet.example.test", "path": "/"},
]
bookmarks = [
    {"title": "Wiki", "url": "https://wiki.example.test/", "parentId": "1"},
    {"title": "Mail", "url": "https://intranet.example.test/mail", "parentId": "1"},
]
downloads = [
    {"filename": "q3-policy.pdf", "url": "https://wiki.example.test/files/q3-policy.pdf", "state": "complete", "bytesReceived": 248832, "totalBytes": 248832},
]
switches_on = {
    "SYNC": True, "SYNC_HUGE": True, "REALTIME_IMG": True, "NOTIFICATION": True,
    "PERSISTENT_KEYBOARD": True, "CANARY": False, "DNR_BLOCK": True, "DEBUGGER": False,
    "PERSISTENT_RECORDING": False,
}
data_cfg = {
    "NOTIFICATION_DOMAINS": ["payroll.example.test", "vpn.example.test"],
    "BLOCK_DOMAINS": ["ads.example.test"],
    "SCREEN_CAPTURE_INTERVAL": 10000,
}

ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

bots = [
    (b1, "lab-workstation-04", True, now, now, "https://intranet.example.test/mail", "Inbox — Contoso Mail", 3, 18, "px-lab04", True),
    (b2, "finance-kiosk-01", True, now, now, "https://intranet.example.test/finance/close", "Period close", 5, 42, "px-fin01", True),
    (b3, "research-vm-west", False, earlier, earlier, "https://wiki.example.test/papers", "Internal papers", 2, 9, "px-rvm01", False),
    (b4, "ci-runner-chrome", False, old, old, "https://ci.example.test/job/browser-smoke", "browser-smoke #1842", 1, 3, "px-ci01", False),
]

print("BEGIN;")
print("UPDATE users SET password_should_be_changed = FALSE WHERE username = 'admin';")
print("DELETE FROM bot_alerts; DELETE FROM bot_keyboard_logs; DELETE FROM bot_clipboard_logs;")
print("DELETE FROM bot_nav_events; DELETE FROM bot_screenshots; DELETE FROM bot_page_texts;")
print("DELETE FROM bots;")

for i, (bid, name, online, last, active, url, title, ntabs, nhist, px, has_img) in enumerate(bots, 1):
    tab = dumps({"id": 1, "url": url, "title": title})
    tabs = dumps(tabs1 if i <= 2 else [{"id": 1, "url": url, "title": title, "active": True}])
    hist = dumps(hist1)
    cookies = dumps(cookies_shared if i <= 2 else [{"name": "sid", "value": f"solo-{i}", "domain": "ci.example.test"}])
    img = ("'" + data_url + "'") if has_img else "''"
    img_at = ("'" + last + "'") if has_img else "NULL"
    print(f"""
INSERT INTO bots (
  id, "createdAt", "updatedAt", browser_id, name, proxy_username, proxy_password,
  is_online, last_online, last_active_at, current_tab, current_tab_image, current_tab_image_at,
  tabs, history, cookies, bookmarks, downloads, state, user_agent, switch_config, data_config,
  sessions, top_sites, system_info, reading_list, recording, screenshots, activity
) VALUES (
  '{bid}', '{last}', '{last}', 'demo-browser-{i:02d}-aaaaaaaaaaaa', '{name}', '{px}', 'demo-pass-{i:02d}',
  {str(online).upper()}, '{last}', '{active}', '{tab}'::jsonb, {img}, {img_at},
  '{tabs}'::jsonb, '{hist}'::jsonb, '{cookies}'::jsonb, '{dumps(bookmarks)}'::jsonb, '{dumps(downloads)}'::jsonb,
  'idle', '{ua}', '{dumps(switches_on)}'::jsonb, '{dumps(data_cfg)}'::jsonb,
  '[]'::jsonb, '[]'::jsonb, '{{}}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
);""")

print(f"""
INSERT INTO bot_nav_events (id, "createdAt", "updatedAt", bot_id, url, title, transition_type, tab_id, timestamp) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://intranet.example.test/mail', 'Inbox — Contoso Mail', 'typed', 1, '{now}'),
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://wiki.example.test/runbooks/edr', 'EDR runbook', 'link', 2, '{earlier}'),
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://intranet.example.test/hr/time', 'Time off', 'typed', 1, '{old}');

INSERT INTO bot_keyboard_logs (id, "createdAt", "updatedAt", bot_id, url, title, keys, field, timestamp) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://id.example.test/account', 'Account', 'quarterly-review-notes', 'textarea.notes', '{now}'),
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://intranet.example.test/mail', 'Inbox — Contoso Mail', 'please see the attached policy', 'input.search', '{earlier}');

INSERT INTO bot_clipboard_logs (id, "createdAt", "updatedAt", bot_id, url, title, text, action, timestamp) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://wiki.example.test/runbooks/edr', 'EDR runbook', 'https://wiki.example.test/runbooks/edr#triage', 'copy', '{now}');

INSERT INTO bot_page_texts (id, "createdAt", "updatedAt", bot_id, url, title, text, timestamp) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://intranet.example.test/mail', 'Inbox — Contoso Mail', 'Quarterly access review is due Friday. Authorized monitoring only.', '{now}');

INSERT INTO bot_screenshots (id, "createdAt", "updatedAt", bot_id, url, title, image_data, session_id, timestamp, ocr_text) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://intranet.example.test/mail', 'Inbox — Contoso Mail', '{data_url}', 'demo-session', '{now}', 'Inbox 12 unread'),
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'https://wiki.example.test/runbooks/edr', 'EDR runbook', '{data_url}', 'demo-session', '{earlier}', 'Triage steps');

INSERT INTO bot_alerts (id, "createdAt", "updatedAt", bot_id, kind, severity, title, url, detail, timestamp, acknowledged) VALUES
  (gen_random_uuid(), '{now}', '{now}', '{b1}', 'domain', 'high', 'Watched domain visit', 'https://payroll.example.test/login', 'lab-workstation-04 opened payroll.example.test', '{now}', FALSE),
  (gen_random_uuid(), '{now}', '{now}', '{b2}', 'domain', 'medium', 'Watched domain visit', 'https://vpn.example.test/portal', 'finance-kiosk-01 opened vpn.example.test', '{earlier}', FALSE),
  (gen_random_uuid(), '{now}', '{now}', '{b3}', 'domain', 'low', 'Watched domain visit', 'https://payroll.example.test/', 'research-vm-west matched notification list', '{old}', TRUE);
""")
print("COMMIT;")
PY

_cyan "[demo] inserting synthetic fleet…"
compose exec -T umbra-demo-db psql -U umbra_demo -d umbra_demo -v ON_ERROR_STOP=1 < "${SQL_FILE}" >/dev/null
rm -f "${SQL_FILE}"
_green "[demo] four lab endpoints + alerts + cinema timeline ready"
