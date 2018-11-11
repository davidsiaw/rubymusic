FROM davidsiaw/musicbot-base

COPY index.js run.sh /srv/
WORKDIR /srv
CMD ["sh", "run.sh"]
