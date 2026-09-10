# Security Policy

## Authorized Use Only

> **Umbra must only be deployed in environments where you have explicit legal
> authorization to monitor the browsers involved.**
>
> Authorized environments include:
>
> - Corporate-owned devices covered by a signed acceptable-use policy that
>   discloses monitoring to employees
> - Security research labs and sandboxed test systems you operate
> - CI/CD pipeline browsers running automated tests under your control
>
> Deploying Umbra against browsers on systems you do not own, or where users
> have not been notified of monitoring as required by law, may violate:
>
> - The Computer Fraud and Abuse Act (CFAA) — United States
> - The Electronic Communications Privacy Act (ECPA) — United States
> - The General Data Protection Regulation (GDPR) — European Union
> - Analogous laws in your jurisdiction
>
> **The project maintainers accept no liability for misuse. You are solely
> responsible for operating Umbra lawfully.**

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| `latest` (`main` branch) | Yes |
| Older tagged releases | No — please update to latest |

---

## Reporting a Vulnerability

We take security reports seriously. If you discover a vulnerability in Umbra,
please report it **privately** so we can address it before public disclosure.

### Preferred channel: GitHub Security Advisories

1. Go to the repository on GitHub.
2. Click **Security** → **Advisories** → **Report a vulnerability**.
3. Fill in a description, steps to reproduce, and potential impact.
4. We will acknowledge the report within **48 hours** and aim to issue a fix or
   mitigation within **14 days** for critical issues.

Please include:

- A clear description of the vulnerability
- Steps to reproduce
- Potential impact and attack scenarios
- Any proof-of-concept code or screenshots (if safe to share)

GitHub Security Advisories is the only supported reporting channel — do not
file vulnerability reports as public issues.

### What to expect

- Acknowledgement within 48 hours
- A status update within 7 days
- Credit in the release notes (unless you prefer to remain anonymous)
- We will not take legal action against researchers who report in good faith
  following this policy

---

## Responsible Disclosure

We follow coordinated disclosure. Please allow us reasonable time to fix the
issue before publishing details publicly. We will coordinate a public disclosure
date with you.

---

## Security Hardening Notes for Operators

When running Umbra in production:

- Set `DATABASE_PASSWORD` to a strong, unique value — there is no default.
- Place the server behind a reverse proxy (e.g., nginx or Caddy) with TLS.
- Restrict access to port 4343 (WebSocket) and port 8080 (HTTP proxy) at the
  network level — only enrolled endpoints and authorized operators should reach
  these ports.
- Rotate the generated admin password immediately after first login.
- Enable access logging on your reverse proxy and review it regularly.
- Use `BCRYPT_ROUNDS=12` or higher in production (the default of 10 is
  acceptable for low-traffic deployments).
