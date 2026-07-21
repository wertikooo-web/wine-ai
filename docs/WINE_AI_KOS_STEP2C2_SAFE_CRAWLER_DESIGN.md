# WINE AI KOS — Step 2C.2 Safe HTTP Client & WebsiteCrawlerProvider Specification

## Overview & Architecture Principles

Step 2C.2 implements the low-level safe web ingestion component of KOS, cleanly separating **Network Security & Protocol Execution** from **Traversal & Crawl Management**.

```text
Source
↓
CrawlRun Policy Snapshot
↓
SafeHttpClient (Single safe request + redirect chain)
↓
WebsiteCrawlerProvider (Queue, depth, rate limiting, robots.txt, sitemaps)
↓
FetchedResource[]
```

---

## 1. Safe HTTP Client (`src/kos/sources/safeHttpClient.js`)

### Key Responsibilities:
- Executes single-hop HTTP/HTTPS requests with **Real Socket IP Pinning**.
- Performs manual redirect handling (`redirect: 'manual'`) with per-hop SSRF validation.
- Caps streaming response size (`maxBytes = 10 MB` default) during body download (works for chunked encoding and missing Content-Length).
- Applies `timeoutMs = 15000` deadline and supports `AbortSignal` cancellation.
- Transparently decodes `gzip`, `deflate`, and `br` Content-Encoding while preserving decoded entity `rawBody` as a `Buffer`.
- Redacts sensitive headers (`set-cookie`, `authorization`, `proxy-authorization`).

### Socket IP Pinning Mechanism:
1. URL is syntactically normalized (`normalizeUrlSyntactic`).
2. SSRF check (`validateUrlSsrf`) resolves DNS A/AAAA records and verifies all returned IPs against blocked private, loopback, link-local, and cloud metadata CIDRs.
3. Custom `lookup` function forces Node's `http.request` / `https.request` socket connection to connect directly to the pre-verified public IP.
4. HTTP `Host` header and TLS Server Name Indication (SNI) retain the original requested hostname.
5. Socket `connect` listener verifies `socket.remoteAddress` against the allowed IP list. If a mismatch or private address is detected, the socket is destroyed with `KOS_SSRF_REMOTE_IP_MISMATCH`.

---

## 2. Website Crawler Provider (`src/kos/sources/websiteCrawlerProvider.js`)

### Key Responsibilities:
- Manages traversal queue, depth tracking, and link deduplication.
- Enforces `same-origin` scope policy.
- Applies delay rate limiting (`delayMs = 1000` default) per origin.
- Parses and enforces `robots.txt` rules (`robotsPolicy.js`).
- Discovers and crawls URLs from `sitemap.xml`.
- Extracts HTML document links (`htmlLinkExtractor.js`) while ignoring non-document schemes (`mailto:`, `tel:`, etc.) and static binary assets.
- Returns structured partial vs fatal crawl outputs with classified failure items.
- **Strict Prohibition**: Performs ZERO database writes, ZERO parsing/extraction, and ZERO LLM calls.

---

## 3. Structured Error Catalog & Retry Classification

| Error Code | Category | Retryable | Description |
|---|---|---|---|
| `KOS_HTTP_INVALID_URL` | Client | `false` | Malformed or missing URL string |
| `KOS_HTTP_PORT_BLOCKED` | Security | `false` | Port outside allowed 80/443 set |
| `KOS_SSRF_BLOCKED` | Security | `false` | Private/loopback IP or credential in URL |
| `KOS_SSRF_REMOTE_IP_MISMATCH` | Security | `false` | Socket connected to unverified IP |
| `KOS_SSRF_REDIRECT_TARGET_BLOCKED` | Security | `false` | Redirect target target private IP |
| `KOS_HTTP_REDIRECT_LIMIT_EXCEEDED` | Client | `false` | Exceeded max redirects limit (5) |
| `KOS_HTTP_REDIRECT_LOOP` | Client | `false` | Redirect loop detected |
| `KOS_HTTP_RESPONSE_TOO_LARGE` | Resource | `false` | Downloaded body exceeded maxBytes |
| `KOS_HTTP_TIMEOUT` | Network | `true` | Request deadline exceeded |
| `KOS_HTTP_ABORTED` | Cancellation | `true` | Aborted by AbortSignal |
| `KOS_HTTP_CONNECTION_FAILED` | Network | `true` | TCP socket reset or connection error |
| `KOS_HTTP_STATUS_429` | HTTP | `true` | Rate limited by remote server |
| `KOS_HTTP_STATUS_50X` | Server | `true` | Remote server error |
