# Engineering lessons

## Cloudflare clearance is not a reusable API session

- Do not assume that forwarding a browser's `Cookie` header and matching its
  User-Agent creates a durable non-browser session.
- Discourse authentication cookies such as `_t` may rotate through ordinary
  `Set-Cookie` responses and can be maintained by a cookie jar.
- Cloudflare `cf_clearance` is tied to the verified visitor/device and relies on
  browser-side challenge and JavaScript signals. A Node/Undici client cannot
  reliably renew it by replaying or merging cookies.
- When a copied browser cookie works briefly and then receives HTTP 403,
  distinguish Cloudflare clearance expiry from Discourse HTTP 401 before
  changing session-storage code.
- A durable client behind browser challenges needs an actual browser context
  (for example, a dedicated persistent Chrome profile over CDP) or a
  site-supported API authorization flow. Cookie copying is only a temporary
  compatibility path.
- The extension now follows this rule by executing same-origin requests inside
  a dedicated persistent Chrome profile over the local DevTools protocol.

## Neutral user-facing settings names

- Use the neutral label "Linux.do 设置" for configuration surfaces.
- Keep informal product intent out of settings titles, commands, view names,
  and configuration-page headings.
