FROM mhart/alpine-node

RUN mkdir -p /srv
COPY provision.sh /provision.sh
COPY package-lock.json package.json run.sh /srv/
RUN sh /provision.sh

COPY index.js /srv/index.js

WORKDIR /srv

CMD ["sh", "run.sh"]
