# Pre-built deployment image
# Go binary and Vue dist are built locally, this just packages them.
# python:3.12-slim is already cached on the NAS (glibc, whisper-cli runs)
# and does not require a Docker Hub pull.
FROM python:3.12-slim

RUN useradd --system --uid 10001 --home-dir /work --no-create-home umbra

COPY umbra-server /usr/local/bin/umbra-server
RUN chmod +x /usr/local/bin/umbra-server
COPY gui-dist /work/gui/dist
COPY extensions /work/extensions
COPY tools/obfuscate.bundle.mjs /work/tools/obfuscate.bundle.mjs
COPY whisper /work/whisper

ENV GUI_DIST_PATH=/work/gui/dist
ENV EXTENSION_SRC_PATH=/work/extensions
ENV OBFUSCATOR_TOOL_DIR=/work/tools
ENV MEDIA_DIR=/work/media
ENV WHISPER_BIN=/work/whisper/whisper-cli
ENV WHISPER_MODEL=/work/whisper/ggml-tiny.bin
ENV LD_LIBRARY_PATH=/work/whisper

# /work/cassl/ is where the MITM CA and the CRX signing key live; the
# stack mounts a named volume here. CA_DIR and EXT_KEY_PATH default to
# `./cassl/...` relative to PWD, so pin PWD to /work and the unprivileged
# `umbra` user owns the dir.
RUN mkdir -p /work/cassl /work/media \
    && chmod +x /work/whisper/whisper-cli /usr/local/bin/umbra-server \
    && chown -R umbra:umbra /work /usr/local/bin/umbra-server
WORKDIR /work

USER umbra
EXPOSE 8118 4343 8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if b'success' in urllib.request.urlopen('http://127.0.0.1:8118/health', timeout=2).read() else 1)"

ENTRYPOINT ["/usr/local/bin/umbra-server"]
