# scip-go inside Esper's analyzer contract (D12). Built by Esper on first use, from this folder.
FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-trimpath
RUN go install github.com/scip-code/scip-go/cmd/scip-go@v0.2.9
COPY esper /build
RUN cd /build && go build -o /go/bin/esper-scip-go .

FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb
COPY --from=build /go/bin/scip-go /go/bin/esper-scip-go /usr/local/bin/
# The dependency cache is a volume that starts from this folder, owned by the user that runs.
RUN mkdir -p /esper/cache && chown 65532:65532 /esper/cache
# No toolchain download, no version control, no cgo: fetching runs nothing of the target's, and
# go.mod and go.sum are never written.
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=readonly \
    GOPROXY=https://proxy.golang.org \
    GOVCS=*:off \
    GOMODCACHE=/esper/cache/mod \
    GOCACHE=/tmp/go-build \
    GOPATH=/tmp/go \
    HOME=/tmp
USER 65532:65532
ENTRYPOINT ["esper-scip-go"]
