#!/usr/bin/env python3
"""Render README console frames as SVG → PNG.

Uses only synthetic example.test copy. No operator data.
Requires rsvg-convert (librsvg).
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "images" / "screenshots"
W, H = 1440, 900

BG = "#070a12"
RAISED = "#1c2536"
OVERLAY = "#252f44"
BORDER = "rgba(255,255,255,0.08)"
FG = "#f3f0e6"
MUTED = "#8b9bb4"
FAINT = "#5c6b82"
ACCENT = "#fbbf24"
SUCCESS = "#34d399"
DANGER = "#f87171"


def shell(content: str, extra: str = "") -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="{FG}" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="{W}" height="{H}" fill="{BG}"/>
  <rect width="{W}" height="{H}" fill="url(#grid)"/>
  {extra}
  {content}
</svg>
"""


def topbar(active: str, alerts: int = 2) -> str:
    def nav(name: str, x: int, label: str, badge: int = 0) -> str:
        on = name == active
        bg = OVERLAY if on else "transparent"
        fill = FG if on else MUTED
        b = ""
        if badge:
            b = f"""<rect x="{x + 52}" y="16" width="16" height="16" rx="8" fill="{DANGER}"/>
            <text x="{x + 60}" y="28" text-anchor="middle" font-size="10" fill="white" font-family="ui-sans-serif, system-ui">{badge}</text>"""
        return f"""<rect x="{x}" y="12" width="{70 if not badge else 78}" height="24" rx="4" fill="{bg}"/>
        <text x="{x + 12}" y="29" font-size="12" fill="{fill}" font-family="ui-sans-serif, system-ui">{label}</text>
        {b}"""

    return f"""
  <rect width="{W}" height="48" fill="{BG}" fill-opacity="0.92" stroke="{BORDER}"/>
  <rect x="16" y="12" width="24" height="24" fill="#3a2410" stroke="{ACCENT}" stroke-opacity="0.3"/>
  <text x="28" y="29" text-anchor="middle" font-size="13" font-weight="700" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">U</text>
  <text x="48" y="29" font-size="13" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Umbra</text>
  <rect x="98" y="16" width="32" height="16" fill="{OVERLAY}"/>
  <text x="114" y="28" text-anchor="middle" font-size="10" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">edr</text>
  {nav("bots", 160, "Bots")}
  {nav("alerts", 240, "Alerts", alerts)}
  {nav("settings", 340, "Settings")}
  {nav("audit", 430, "Audit")}
  <text x="1420" y="29" text-anchor="end" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">2 live · 2 offline</text>
"""


def dashboard() -> str:
    rows = [
        ("lab-workstation-04", "demo-brow…aaaa", "online", "Inbox — Contoso Mail", "3 / 18", "px-lab04", "now"),
        ("finance-kiosk-01", "demo-brow…bbbb", "online", "Period close", "5 / 42", "px-fin01", "now"),
        ("research-vm-west", "demo-brow…cccc", "offline", "Internal papers", "2 / 9", "px-rvm01", "23m"),
        ("ci-runner-chrome", "demo-brow…dddd", "offline", "browser-smoke #1842", "1 / 3", "px-ci01", "10h"),
    ]
    body = []
    y = 338
    for i, (name, bid, st, tab, th, px, ago) in enumerate(rows):
        fill = "rgba(251,191,36,0.04)" if i % 2 else "transparent"
        dot = SUCCESS if st == "online" else FAINT
        body.append(f"""
        <rect x="24" y="{y}" width="1392" height="52" fill="{fill}"/>
        <rect x="64" y="{y + 8}" width="80" height="36" fill="{BG}" stroke="{BORDER}"/>
        <rect x="64" y="{y + 8}" width="80" height="8" fill="{OVERLAY}"/>
        <rect x="64" y="{y + 16}" width="80" height="2" fill="{ACCENT}"/>
        <text x="164" y="{y + 24}" font-size="13" font-weight="500" fill="{FG}" font-family="ui-sans-serif, system-ui">{name}</text>
        <text x="164" y="{y + 40}" font-size="10" fill="{FAINT}" font-family="ui-monospace, Menlo, monospace">{bid}</text>
        <circle cx="430" cy="{y + 26}" r="4" fill="{dot}"/>
        <text x="442" y="{y + 30}" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">{st}</text>
        <text x="560" y="{y + 30}" font-size="12" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">{tab}</text>
        <text x="900" y="{y + 30}" font-size="12" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">{th}</text>
        <text x="1040" y="{y + 30}" font-size="12" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">{px}</text>
        <text x="1240" y="{y + 30}" font-size="12" fill="{FAINT}" font-family="ui-monospace, Menlo, monospace">{ago}</text>
        """)
        y += 52

    return shell(
        topbar("bots")
        + f"""
  <text x="24" y="84" font-size="20" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Bots</text>
  <text x="24" y="104" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">Connected browsers across the fleet</text>
  <rect x="24" y="124" width="336" height="72" fill="{RAISED}" stroke="{BORDER}"/>
  <rect x="376" y="124" width="336" height="72" fill="{RAISED}" stroke="{BORDER}"/>
  <rect x="728" y="124" width="336" height="72" fill="{RAISED}" stroke="{BORDER}"/>
  <rect x="1080" y="124" width="336" height="72" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="40" y="146" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">TOTAL</text>
  <text x="40" y="176" font-size="22" font-weight="600" fill="{FG}" font-family="ui-monospace, Menlo, monospace">4</text>
  <text x="392" y="146" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">ONLINE</text>
  <text x="392" y="176" font-size="22" font-weight="600" fill="{SUCCESS}" font-family="ui-monospace, Menlo, monospace">2</text>
  <text x="744" y="146" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">OFFLINE</text>
  <text x="744" y="176" font-size="22" font-weight="600" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">2</text>
  <text x="1096" y="146" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">DEFAULT PROXY</text>
  <text x="1096" y="176" font-size="13" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">none</text>

  <rect x="24" y="214" width="1392" height="56" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="40" y="236" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">SHARED SESSIONS</text>
  <text x="40" y="254" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">1 cookie · 2 bots · PHPSESSID @ intranet.example.test</text>

  <rect x="24" y="286" width="1392" height="260" fill="{RAISED}" stroke="{BORDER}"/>
  <rect x="24" y="286" width="1392" height="32" fill="{OVERLAY}"/>
  <text x="164" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">BOT</text>
  <text x="430" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">STATUS</text>
  <text x="560" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">CURRENT TAB</text>
  <text x="900" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">TABS / HIST</text>
  <text x="1040" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">PROXY</text>
  <text x="1240" y="308" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">LAST ACTIVE</text>
  {''.join(body)}
"""
    )


def endpoint() -> str:
    chips = [("Tabs", True), ("Data sync", True), ("Screen", True), ("Alerts", True), ("Mic", False), ("Keys", True), ("Canary", False), ("Block", True), ("HAR", False)]
    chip_x = 380
    chip_svg = []
    for label, on in chips:
        bg = "rgba(52,211,153,0.10)" if on else BG
        bd = "rgba(52,211,153,0.30)" if on else BORDER
        fg = SUCCESS if on else FAINT
        w = 12 * len(label) + 28
        chip_svg.append(f"""
        <rect x="{chip_x}" y="168" width="{w}" height="22" fill="{bg}" stroke="{bd}"/>
        <circle cx="{chip_x + 10}" cy="179" r="3" fill="{fg}"/>
        <text x="{chip_x + 18}" y="183" font-size="10" fill="{fg}" font-family="ui-sans-serif, system-ui">{label}</text>
        """)
        chip_x += w + 8

    tabs = ["Cinema", "Tabs", "History", "Cookies", "Bookmarks", "Downloads", "Screenshots", "Keyboard", "Clipboard", "Storage", "Audio", "Remote control", "Config"]
    tab_x = 24
    tab_svg = []
    for t in tabs:
        on = t == "Cinema"
        color = FG if on else MUTED
        underline = ACCENT if on else "transparent"
        tw = 11 * len(t) + 16
        tab_svg.append(f"""
        <text x="{tab_x + 8}" y="268" font-size="12" fill="{color}" font-family="ui-sans-serif, system-ui">{t}</text>
        <rect x="{tab_x}" y="276" width="{tw}" height="2" fill="{underline}"/>
        """)
        tab_x += tw + 4

    return shell(
        topbar("bots")
        + f"""
  <text x="24" y="76" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">← Bots  /  11111111-1111-4111-8111-111111111111</text>
  <rect x="24" y="92" width="1392" height="148" fill="{RAISED}" stroke="{BORDER}"/>
  <rect x="48" y="112" width="280" height="108" fill="{BG}" stroke="{BORDER}"/>
  <rect x="48" y="112" width="280" height="18" fill="{OVERLAY}"/>
  <rect x="48" y="130" width="280" height="3" fill="{ACCENT}"/>
  <text x="188" y="176" text-anchor="middle" font-size="11" fill="{FAINT}" font-family="ui-monospace, Menlo, monospace">intranet.example.test</text>
  <text x="380" y="128" font-size="20" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">lab-workstation-04</text>
  <circle cx="590" cy="122" r="5" fill="{SUCCESS}"/>
  <text x="380" y="150" font-size="12" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">Inbox — Contoso Mail</text>
  {''.join(chip_svg)}
  <text x="380" y="220" font-size="10" fill="{FAINT}" font-family="ui-sans-serif, system-ui">ID</text>
  <text x="380" y="236" font-size="11" fill="{MUTED}" font-family="ui-monospace, Menlo, monospace">11111111-1111-4111-8111-111111111111</text>
  {''.join(tab_svg)}
  <rect x="24" y="292" width="900" height="560" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="44" y="320" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">CINEMA</text>
  <rect x="44" y="336" width="860" height="220" fill="{BG}" stroke="{BORDER}"/>
  <rect x="44" y="336" width="860" height="22" fill="{OVERLAY}"/>
  <rect x="44" y="358" width="860" height="3" fill="{ACCENT}"/>
  <text x="474" y="460" text-anchor="middle" font-size="13" fill="{MUTED}" font-family="ui-sans-serif, system-ui">Inbox — Contoso Mail</text>
  <text x="44" y="580" font-size="11" fill="{FAINT}" font-family="ui-sans-serif, system-ui">08:14  nav  intranet.example.test/mail</text>
  <text x="44" y="602" font-size="11" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">08:14  keys  quarterly-review-notes</text>
  <text x="44" y="624" font-size="11" fill="{SUCCESS}" font-family="ui-sans-serif, system-ui">07:51  clipboard  wiki.example.test/runbooks/edr#triage</text>
  <text x="44" y="646" font-size="11" fill="{DANGER}" font-family="ui-sans-serif, system-ui">08:14  alert  payroll.example.test</text>
  <rect x="940" y="292" width="476" height="560" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="960" y="320" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">NEARBY EVENTS</text>
  <text x="960" y="352" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">nav · Inbox — Contoso Mail</text>
  <text x="960" y="376" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">screenshot · 08:14</text>
  <text x="960" y="400" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">keyboard · account notes</text>
"""
    )


def alerts() -> str:
    items = [
        ("high", "Watched domain visit", "https://payroll.example.test/login", "lab-workstation-04 opened payroll.example.test", "08:14"),
        ("medium", "Watched domain visit", "https://vpn.example.test/portal", "finance-kiosk-01 opened vpn.example.test", "07:51"),
    ]
    rows = []
    y = 140
    for sev, title, url, detail, ts in items:
        color = DANGER if sev == "high" else ACCENT
        rows.append(f"""
        <rect x="24" y="{y}" width="1392" height="88" fill="{RAISED}" stroke="{BORDER}"/>
        <circle cx="48" cy="{y + 44}" r="5" fill="{color}"/>
        <text x="72" y="{y + 32}" font-size="13" font-weight="500" fill="{FG}" font-family="ui-sans-serif, system-ui">{title}</text>
        <text x="280" y="{y + 32}" font-size="10" fill="{DANGER}" font-family="ui-sans-serif, system-ui">{sev.upper()}</text>
        <text x="1360" y="{y + 32}" text-anchor="end" font-size="10" fill="{FAINT}" font-family="ui-monospace, Menlo, monospace">{ts}</text>
        <text x="72" y="{y + 52}" font-size="12" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">{url}</text>
        <text x="72" y="{y + 72}" font-size="11" fill="{MUTED}" font-family="ui-sans-serif, system-ui">{detail}</text>
        """)
        y += 96
    return shell(
        topbar("alerts")
        + f"""
  <text x="24" y="84" font-size="20" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Alerts</text>
  <text x="24" y="104" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">Domain-visit detections from enrolled sensors.</text>
  {''.join(rows)}
"""
    )


def settings() -> str:
    return shell(
        topbar("settings", 2)
        + f"""
  <text x="24" y="84" font-size="20" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Settings</text>
  <text x="24" y="104" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">Account preferences and proxy CA download.</text>
  <rect x="24" y="128" width="700" height="160" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="44" y="156" font-size="13" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Account</text>
  <text x="44" y="178" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">Signed in as admin</text>
  <rect x="44" y="196" width="320" height="36" fill="{BG}" stroke="{BORDER}"/>
  <text x="56" y="218" font-size="12" fill="{FAINT}" font-family="ui-sans-serif, system-ui">New password</text>
  <rect x="44" y="244" width="120" height="28" fill="{ACCENT}"/>
  <text x="104" y="262" text-anchor="middle" font-size="12" fill="#1a1204" font-family="ui-sans-serif, system-ui">Change password</text>
  <rect x="740" y="128" width="676" height="160" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="760" y="156" font-size="13" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Two-factor authentication</text>
  <text x="760" y="178" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">TOTP via any authenticator app. Currently off.</text>
  <rect x="760" y="200" width="140" height="28" fill="{OVERLAY}" stroke="{BORDER}"/>
  <text x="830" y="218" text-anchor="middle" font-size="12" fill="{FG}" font-family="ui-sans-serif, system-ui">Generate secret</text>
  <rect x="24" y="308" width="1392" height="200" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="44" y="336" font-size="13" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Extension package</text>
  <text x="44" y="358" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">Download a configured Chrome extension zip with your server address baked in.</text>
  <rect x="44" y="376" width="400" height="36" fill="{BG}" stroke="{BORDER}"/>
  <text x="56" y="398" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">None (standalone extension)</text>
  <rect x="44" y="428" width="220" height="36" fill="{ACCENT}"/>
  <text x="154" y="450" text-anchor="middle" font-size="13" fill="#1a1204" font-family="ui-sans-serif, system-ui">Download extension .zip</text>
  <rect x="24" y="528" width="1392" height="120" fill="{RAISED}" stroke="{BORDER}"/>
  <text x="44" y="556" font-size="13" font-weight="600" fill="{FG}" font-family="ui-sans-serif, system-ui">Chrome / Edge policy pack</text>
  <text x="44" y="578" font-size="12" fill="{MUTED}" font-family="ui-sans-serif, system-ui">Force-install Sensor and disable QUIC so the HTTPS proxy is not bypassed via HTTP/3.</text>
  <text x="44" y="608" font-size="12" fill="{ACCENT}" font-family="ui-sans-serif, system-ui">chrome-policy.json    edge-policy.json    chrome-policy.reg</text>
"""
    )


def render(name: str, svg: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    svg_path = Path(f"/tmp/umbra-frame-{name}.svg")
    png_path = OUT / f"{name}.png"
    svg_path.write_text(svg, encoding="utf-8")
    subprocess.run(
        ["rsvg-convert", "-w", str(W), "-h", str(H), "-o", str(png_path), str(svg_path)],
        check=True,
    )
    size = png_path.stat().st_size
    print(f"wrote {png_path} ({size} bytes)")
    if size < 5120:
        raise SystemExit(f"{name}.png too small")


def main() -> None:
    render("dashboard", dashboard())
    render("endpoint", endpoint())
    render("alerts", alerts())
    render("settings", settings())


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError:
        print("rsvg-convert not found; install librsvg", file=sys.stderr)
        sys.exit(1)
