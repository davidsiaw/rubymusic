#!/bin/sh

apk add --update --no-cache ffmpeg build-base git
cd /srv && npm install

apk del build-base linux-headers pcre-dev openssl-dev
rm -rf /var/cache/apk/*