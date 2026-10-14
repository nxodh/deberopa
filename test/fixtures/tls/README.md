# TLS test fixtures

**TEST ONLY.** Every key in this directory was generated for the tests, protects nothing, and is
published on purpose. `script/scan-secrets.ts` allows private keys in this directory and nowhere else.

Regenerate (needs OpenSSL 3.4+, so use a container instead of installing anything):

```sh
docker run --rm -v "$PWD/test/fixtures/tls:/out" alpine:3.22 sh -c 'apk add --no-cache openssl >/dev/null && sh /out/generate.sh'
```

| Files | What they are |
|---|---|
| `ca`, `server` | CA and a server certificate for `localhost`, `127.0.0.1`, `::1` (valid about 100 years) |
| `other-ca`, `other-server` | a second, unrelated CA and its server certificate |
| `wrongname` | signed by `ca`, but only for `wrong.test` |
| `expired` | signed by `ca`, valid only on 2020-01-01 |
| `selfsigned` | a leaf certificate that is its own issuer (no CA) |
| `nc-ca`, `nc-server`, `nc-bad-server` | a CA limited to DNS `.local` and `localhost`; a server inside the limits and one outside |
| `nc-ip-ca`, `nc-ip-server` | a CA with IP constraints: Bun cannot verify a leaf with an IP SAN under it (`UNSUPPORTED_CONSTRAINT_TYPE`) |
