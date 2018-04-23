#!/bin/sh

apk add --update --no-cache ffmpeg autoconf automake make libtool python build-base git
#git clone https://github.com/Rantanen/node-opus /srv/node-opus
#cd /srv/node-opus
#cd deps/opus
#autoreconf --install
#./configure --enable-static --disable-shared --with-pic
#make install

npm install -g node-gyp@3.6.2
#cd /srv/node-opus
#npm install --unsafe-perm --verbose -g

cd /srv && npm install node-opus@0.2.7 && npm install

apk del autoconf automake make libtool git build-base linux-headers pcre-dev openssl-dev
rm -rf /var/cache/apk/*
