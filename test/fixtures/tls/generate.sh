#!/bin/sh
# Regenerates every certificate in this directory. TEST ONLY: none of these keys protects anything.
# Run it in a container so nothing has to be installed on your machine:
#
#   docker run --rm -v "$PWD/test/fixtures/tls:/out" alpine:3.22 sh -c 'apk add --no-cache openssl >/dev/null && sh /out/generate.sh'
#
# Needs OpenSSL 3.4 or newer (the `-not_before` / `-not_after` options).
set -eu
cd "$(dirname "$0")"
LONG=36500        # about 100 years, so the tests do not start failing as time passes
BANNER="# TEST ONLY. Not a real key or certificate. Created by test/fixtures/tls/generate.sh"

key() { # key <name>: ECDSA P-256, PKCS#8
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$1-key.tmp"
  { echo "$BANNER"; cat "$1-key.tmp"; } > "$1-key.pem" && rm -f "$1-key.tmp"
}
banner() { { echo "$BANNER"; cat "$1"; } > "$1.tmp" && mv "$1.tmp" "$1"; }

ca() { # ca <name> <subject> [extra x509v3 lines...]
  name=$1; subject=$2; shift 2
  key "$name"
  { echo "basicConstraints=critical,CA:TRUE,pathlen:0"; echo "keyUsage=critical,keyCertSign,cRLSign"; for l in "$@"; do echo "$l"; done; } > "$name.ext"
  openssl req -new -key "$name-key.pem" -subj "$subject" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -signkey "$name-key.pem" -days $LONG -extfile "$name.ext" -out "$name.pem" 2>/dev/null
  banner "$name.pem"; rm -f "$name.csr" "$name.ext"
}

leaf() { # leaf <name> <issuer> <san> [not_before not_after]
  name=$1; issuer=$2; san=$3
  key "$name"
  { echo "basicConstraints=CA:FALSE"; echo "keyUsage=critical,digitalSignature"; echo "extendedKeyUsage=serverAuth"; echo "subjectAltName=$san"; } > "$name.ext"
  openssl req -new -key "$name-key.pem" -subj "/CN=$name" -out "$name.csr"
  if [ $# -ge 5 ]; then
    openssl x509 -req -in "$name.csr" -CA "$issuer.pem" -CAkey "$issuer-key.pem" -CAcreateserial -not_before "$4" -not_after "$5" -extfile "$name.ext" -out "$name.pem" 2>/dev/null
  else
    openssl x509 -req -in "$name.csr" -CA "$issuer.pem" -CAkey "$issuer-key.pem" -CAcreateserial -days $LONG -extfile "$name.ext" -out "$name.pem" 2>/dev/null
  fi
  banner "$name.pem"; rm -f "$name.csr" "$name.ext" "$issuer.srl"
}

LOCAL_SAN="DNS:localhost,IP:127.0.0.1,IP:::1"

ca ca "/CN=Vedecaps Test CA"
ca other-ca "/CN=Vedecaps Other Test CA"
# Name constraints. Measured with Bun 1.4 (BoringSSL): DNS constraints are enforced and work with IP
# SANs on the leaf; any IP constraint makes a leaf that has an IP SAN fail with
# UNSUPPORTED_CONSTRAINT_TYPE. So the "nc" CA constrains DNS names only, and "nc-ip" documents the form
# that does not work.
ca nc-ca "/CN=Vedecaps Name Constrained Test CA" \
  "nameConstraints=critical,permitted;DNS:.local,permitted;DNS:localhost"
ca nc-ip-ca "/CN=Vedecaps IP Constrained Test CA" \
  "nameConstraints=critical,permitted;DNS:localhost,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:::1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF"

leaf server ca "$LOCAL_SAN"
leaf other-server other-ca "$LOCAL_SAN"
leaf wrongname ca "DNS:wrong.test"
leaf expired ca "$LOCAL_SAN" 20200101000000Z 20200102000000Z
leaf nc-server nc-ca "DNS:localhost,DNS:diparnux.local,IP:127.0.0.1,IP:::1"
leaf nc-bad-server nc-ca "DNS:localhost,DNS:evil.example.com,IP:127.0.0.1"
leaf nc-ip-server nc-ip-ca "DNS:localhost,IP:127.0.0.1,IP:::1"

# a server certificate that is its own issuer (no CA at all): the "B" model of the design
key selfsigned
{ echo "basicConstraints=CA:FALSE"; echo "extendedKeyUsage=serverAuth"; echo "subjectAltName=$LOCAL_SAN"; } > selfsigned.ext
openssl req -new -key selfsigned-key.pem -subj "/CN=selfsigned" -out selfsigned.csr
openssl x509 -req -in selfsigned.csr -signkey selfsigned-key.pem -days $LONG -extfile selfsigned.ext -out selfsigned.pem 2>/dev/null
banner selfsigned.pem; rm -f selfsigned.csr selfsigned.ext

rm -f ./*.srl
echo "generated:"; ls -1 ./*.pem
