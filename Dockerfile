FROM nginx:stable-alpine

LABEL org.opencontainers.image.title="ACH Studio" \
      org.opencontainers.image.description="Local NACHA/ACH file viewer and editor"

# The app is fully static: no build step or Node runtime is required.
COPY index.html /usr/share/nginx/html/index.html
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
