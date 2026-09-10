FROM golang:1.25-alpine AS build
WORKDIR /src

# Cache deps
COPY go.mod go.sum ./
RUN go mod download

# Build static binary
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags="-s -w" \
    -o /out/umbra-server ./cmd/umbra-server

# Runtime
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata curl wget && \
    adduser -D -H -u 10001 umbra
COPY --from=build /out/umbra-server /usr/local/bin/umbra-server
ENV MEDIA_DIR=/work/media
ENV CA_DIR=/work/cassl
ENV GUI_DIST_PATH=/work/gui/dist
RUN mkdir -p /work/media /work/cassl /work/gui/dist && chown -R umbra:umbra /work
WORKDIR /work
USER umbra
EXPOSE 8118 4343 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8118/health | grep -q '"success":true' || exit 1
ENTRYPOINT ["/usr/local/bin/umbra-server"]
